import * as vscode from 'vscode';
import SerialPort from 'serialport';
import * as fs from 'fs';
import * as path from 'path';
import { XModem, SerialLink } from './xmodem';
import { formatHexDump } from './hexDump';
import { parseDirResponse } from './cpmDirParser';
import { SerialSession, sendFiles } from './slide-ts';
import { RemoteCcpClient, RemoteCcpFile } from './remoteCcp';
import { toIntelHex } from './intelHex';
import { TransferQueue, TransferCancelledError, ConnectionResetError } from './transferQueue';
import { ListingLine, parseListingFile } from './listingFile';

/** Filename Remote CCP is bootstrapped/looked up under - 8 chars, CP/M's limit ("REMOTECCP" doesn't fit). */
const REMOTE_CCP_FILENAME = 'REMOTCCP.COM';
/** Command typed at the CCP to launch it - no ".COM": the CCP appends that itself when searching for a command. */
const REMOTE_CCP_COMMAND = 'REMOTCCP';

const getDeviceType = () => vscode.workspace.getConfiguration('cpmIde').get<string>('deviceType') ?? 'Generic';

export class SerialTerminal {
	readonly transferQueue = new TransferQueue();
	private port: SerialPort | undefined;
	private xmodem: XModem;
	private readonly log: vscode.OutputChannel;
	/** A CCP prompt: a drive letter, optionally followed by a 1-2 digit user-area number - CP/M 3/MP/M shows e.g. "A2>" or "B15>" for a non-zero user area, not just "A>". */
	private promptRegex = /[A-P]\d{0,2}>/;
	private inputBuffer = '';
	private hiddenCommandInProgress = false;
	private lastDataTime = 0;
	private connectionGeneration = 0;
	/**
	 * Serializes withExclusiveAccess() calls against each other - it is
	 * itself just a busy flag/label around one `work()` call, not a mutex,
	 * so two calls issued while an earlier one is still running would
	 * otherwise both proceed to touch the wire at the same time (e.g. an
	 * auto-refresh on connect racing a refreshDrive() from a just-completed
	 * transfer), scrambling both operations' reads/writes together. Chaining
	 * onto this tail - the same pattern TransferQueue already uses for
	 * transfers specifically - makes every caller wait its turn instead.
	 */
	private exclusiveAccessTail: Promise<void> = Promise.resolve();
	/** Forces trace logging on regardless of the `enableSerialTrace` setting - used by runCommsTest. */
	private forceTrace = false;
	/* Forces all input to be converted to uppercase before sending to the device, regardless of what the user typed. */
	private forceCapitals = true;
	/** Best-known current CCP drive, tracked from the last "X>" prompt seen. */
	private currentDrive: string | undefined;
	/** True from the moment DDT is launched (debugAssemblyFile) until a CCP prompt reappears - see handleSerialData(). */
	private ddtMode = false;
	/**
	 * Which DDT command a response is currently in flight for, or undefined
	 * if DDT is idle at its prompt with nothing outstanding. DDT_MODE has no
	 * free-typing (see stepDdt()/goDdt()) - every command DDT is ever sent
	 * comes from exactly one of a handful of known call sites, so this is
	 * always precisely known rather than inferred: 'launch' for the initial
	 * `DDT <name>.COM`, 'examine' for `X` (sent both to seed the initial
	 * register display and automatically after every G stop), 'step' for
	 * `T`, 'go' for `G` (with or without a start+breakpoint). See
	 * routeDdtResponse(), which is the only place this changes.
	 */
	private ddtPending: 'launch' | 'examine' | 'step' | 'go' | undefined = undefined;
	/**
	 * The remaining not-yet-echoed-back tail of the command just sent to
	 * DDT (see beginDdtCommand()/launchDdt()) - unlike anything that might
	 * follow it, this part is never ambiguous no matter which command it
	 * is: it's a plain echo of bytes we ourselves just wrote, not the
	 * debugged program's output. routeDdtResponse() consumes it off the
	 * front of each incoming chunk (trusted, straight to the DEBUG panel)
	 * before applying isDdtResponseTrusted()'s logic to whatever's left.
	 */
	private ddtPendingEcho = '';
	/** Unclassified tail of the in-flight command's response not yet resolved as matching DDT's own prompt shape or not - see routeDdtResponse(). */
	private ddtScanBuffer = '';
	/**
	 * True once DDT's own prompt has actually been seen at least once.
	 * Exit-detection (a CCP prompt reappearing) is only armed after this -
	 * the very first bytes back after launching DDT are just the console's
	 * echo of the `DDT <NAME>.COM` command line itself, which (because it
	 * was typed at a normal CCP prompt) contains a bare "X>" too. Without
	 * this gate that echo alone reads as "back at the CCP" and ends the
	 * session before DDT has even printed its banner.
	 */
	private ddtSeenPrompt = false;
	/** What launchDdt() was last called with - kept across a session ending (deliberately not cleared by resetDdtState()) so restartDdt() can relaunch the same target without the caller needing to remember it. */
	private lastDdtLaunch: { remoteComName: string; drive: string } | undefined;
	/** "CP/M X.Y", learned from Remote CCP's startup version byte - undefined until first learned, reset on reconnect. */
	private cpmVersion: string | undefined;

	private _onData = new vscode.EventEmitter<string>();
	readonly onData = this._onData.event;

	private _onCpmVersionDetected = new vscode.EventEmitter<string>();
	readonly onCpmVersionDetected = this._onCpmVersionDetected.event;

	private _onRawData = new vscode.EventEmitter<{ generation: number; data: Buffer }>();
	/** Raw bytes as they arrive, unfiltered by `hiddenCommandInProgress` - used by XModem. */
	private readonly onRawData = this._onRawData.event;

	private _onError = new vscode.EventEmitter<string>();
	readonly onError = this._onError.event;

	private _onConnect = new vscode.EventEmitter<string>();
	readonly onConnect = this._onConnect.event;

	private _onDisconnect = new vscode.EventEmitter<void>();
	readonly onDisconnect = this._onDisconnect.event;

	private _onBusyChange = new vscode.EventEmitter<boolean>();
	readonly onBusyChange = this._onBusyChange.event;

	private _onActivity = new vscode.EventEmitter<string>();
	readonly onActivity = this._onActivity.event;

	/** DDT's own prompt/status output (matched by routeDdtResponse()), bound for the DEBUG panel rather than the main terminal. */
	private _onDebugData = new vscode.EventEmitter<string>();
	readonly onDebugData = this._onDebugData.event;

	private _onDdtModeChanged = new vscode.EventEmitter<boolean>();
	readonly onDdtModeChanged = this._onDdtModeChanged.event;

	/** Fires the parsed .lst matching the file under debug (see loadDdtListingFromPath()), or undefined if none was found/the session ended. */
	private _onDdtListingChanged = new vscode.EventEmitter<ListingLine[] | undefined>();
	readonly onDdtListingChanged = this._onDdtListingChanged.event;

	/** Fires once a DDT command's response is fully resolved and ddtPending has cleared - the DEBUG panel's cue that it may send the next one. See routeDdtResponse(). */
	private _onDdtReady = new vscode.EventEmitter<void>();
	readonly onDdtReady = this._onDdtReady.event;

	currentPort: string | undefined;

	constructor(private readonly context: vscode.ExtensionContext) {
		this.xmodem = new XModem();
		this.log = vscode.window.createOutputChannel('CP/M IDE: Serial Trace');
	}

	get isOpen(): boolean {
		return this.port?.isOpen ?? false;
	}

	/** "CP/M X.Y" once learned from a Remote CCP session's startup byte, else undefined. */
	get detectedCpmVersion(): string | undefined {
		return this.cpmVersion;
	}

	/** Best-known current CCP drive, tracked from the last "X>" prompt seen - undefined until one's been seen. */
	get activeDrive(): string | undefined {
		return this.currentDrive;
	}

	private traceEnabled(): boolean {
		return this.forceTrace || (vscode.workspace.getConfiguration('cpmIde').get<boolean>('enableSerialTrace') ?? false);
	}

	get isBusy(): boolean {
		return this.hiddenCommandInProgress;
	}

	async connect(
		portName?: string, baudRate?: number, dataBits?: number, stopBits?: number,
		parity?: string, flowControl?: string
	) {
		const settings = vscode.workspace.getConfiguration('cpmIde');
		// `||`, not `??`: an empty string (e.g. the webview's port dropdown
		// with nothing selected) must fall through to the saved setting too,
		// not be treated as a deliberately-chosen value.
		const resolvedPort = portName || settings.get<string>('serialPort') || 'COM1';
		const resolvedBaud = baudRate ?? settings.get<number>('baudRate') ?? 9600;
		const resolvedDataBits = dataBits ?? settings.get<number>('dataBits') ?? 8;
		const resolvedStopBits = stopBits ?? settings.get<number>('stopBits') ?? 1;
		const resolvedParity = parity || settings.get<string>('parity') || 'none';
		const resolvedFlowControl = flowControl || settings.get<string>('flowControl') || 'xonxoff';

		if (!resolvedPort) {
			throw new Error('No serial port selected. Choose a port and try again.');
		}

		if (this.port?.isOpen) {
			this.port.close();
		}

		// Invalidate any stale transfer/link state from an older connection.
		this.connectionGeneration++;
		this.cpmVersion = undefined;

		// Many hobbyist CP/M/Z80 boards use Xon/Xoff software flow control
		// since their UART receive buffers are tiny - without honoring it,
		// long responses (DIR, TYPE) stop dead partway through instead of
		// resuming once the device is ready for more.
		const xonxoff = resolvedFlowControl === 'xonxoff';
		const rtscts = resolvedFlowControl === 'rtscts';

		this.port = new SerialPort(resolvedPort, {
			baudRate: resolvedBaud,
			dataBits: resolvedDataBits,
			stopBits: resolvedStopBits,
			parity: resolvedParity as any,
			xon: xonxoff,
			xoff: xonxoff,
			xany: xonxoff,
			rtscts,
		} as any);

		// Deliberately paused-mode reading (not `.on('data', ...)`, which puts
		// the stream in flowing mode) - flowing mode is known to drop bytes
		// on the `serialport` package when reads and writes happen
		// concurrently, exactly what interactive typing does.
		this.port.on('readable', () => {
			let chunk: Buffer | string | null;
			// No encoding is ever set on the stream, so reads are always
			// Buffers - the string case is just the library's generic typing.
			while ((chunk = this.port!.read()) !== null) {
				this.handleSerialData(chunk as Buffer);
			}
		});
		this.port.on('error', (err: Error) => {
			this._onError.fire(err.message);
		});
		this.port.on('close', () => {
			this.currentPort = undefined;
			this._onDisconnect.fire();
		});
		this.port.on('open', () => {
			// The constructor's dtr/rts defaults (true) aren't always
			// reliably reaching the actual UART control lines on Windows -
			// assert them explicitly. Some boards check CTS (driven by our
			// RTS) before continuing multi-line output and abort gracefully
			// back to the prompt if it isn't asserted.
			this.port!.set({ dtr: true, rts: true }, (err) => {
				if (err) {
					this.log.appendLine(`Failed to assert DTR/RTS: ${err.message}`);
				}
			});
		});

		this.currentPort = resolvedPort;
		this._onConnect.fire(resolvedPort);
		this._onActivity.fire(`Connected to ${resolvedPort}`);
	}

	/**
	 * True while the in-flight DDT command (see ddtPending) is guaranteed to
	 * produce only DDT's own text - false only for 'go'. The launch banner
	 * and X don't run any target code, so nothing else could be producing
	 * output; T executes exactly one instruction and always finishes with
	 * its own register dump - even when that one instruction is a CALL, a
	 * single step only steps *into* it (pushes the return address, lands on
	 * the callee's first instruction) rather than running the callee to
	 * completion, so it can't produce real program output either. Only G
	 * can run an unbounded amount of the debugged program's own code, so
	 * only its response is treated as untrusted (the debugged program's own
	 * until proven otherwise). See routeDdtResponse().
	 */
	private isDdtResponseTrusted(): boolean {
		return this.ddtPending !== 'go';
	}

	/**
	 * Emits any content still held in ddtScanBuffer to the main terminal
	 * before a DDT session's tracking state is cleared - but only if it was
	 * withheld from an untrusted (T/G) response; a trusted response's bytes
	 * are already streamed to the DEBUG panel live as they arrive (see
	 * routeDdtResponse()), so what's left in ddtScanBuffer at that point is
	 * just pattern-matching bookkeeping, not unshown content. For an
	 * untrusted response, routeDdtResponse() can legitimately be sitting on up
	 * to a few characters that still might be the start of a DDT prompt - if
	 * the session ends before that resolves one way or the other (a real CCP
	 * prompt shows up instead, or the user manually ends the session), those
	 * characters were never actually a DDT prompt after all, so they belong
	 * in the main terminal rather than being silently discarded by
	 * resetDdtState().
	 */
	private flushDdtScanBuffer(): void {
		if (this.ddtScanBuffer && !this.isDdtResponseTrusted()) {
			this._onData.fire(this.ddtScanBuffer);
		}
	}

	/** Clears all DDT session tracking fields - shared by every place a DDT session ends (CCP prompt reappearing, disconnect, or the manual endDdtSession()). Callers fire onDdtModeChanged/onDdtListingChanged themselves afterward, and should call flushDdtScanBuffer() first if any pending program output should be preserved. */
	private resetDdtState(): void {
		this.ddtMode = false;
		this.ddtPending = undefined;
		this.ddtScanBuffer = '';
		this.ddtSeenPrompt = false;
		this.ddtPendingEcho = '';
	}

	/**
	 * Manual escape hatch for ending a DDT session that isn't returning to
	 * the CCP prompt on its own (see handleSerialData()'s normal
	 * exit-detection) - sends Ctrl-C in case DDT or the program under it is
	 * still reading the console, then unconditionally resets ddtMode state
	 * so SerialTerminal doesn't keep thinking a session it can no longer
	 * show output for is still active. Deliberately leaves the DEBUG panel's
	 * listing/registers/output alone (no onDdtListingChanged fire here) -
	 * the panel stays open showing the session's final state so the user
	 * can review what happened.
	 */
	endDdtSession(): void {
		if (!this.ddtMode) {
			return;
		}
		this.flushDdtScanBuffer();
		this.resetDdtState();
		this._onDdtModeChanged.fire(false);
		this._onActivity.fire('DDT session ended (manual)');
		this.sendData('\x03');
	}

	/**
	 * The DEBUG panel's Restart button: sends Ctrl-C (same as
	 * endDdtSession(), in case DDT or the program under it is stuck or
	 * still running) and relaunches DDT against the same file+drive as the
	 * session that's active now, or was last ended - lastDdtLaunch persists
	 * across a session ending, unlike the rest of the DDT tracking state.
	 * No-op if DDT has never been launched this connection.
	 */
	async restartDdt(): Promise<boolean> {
		if (!this.lastDdtLaunch) {
			return false;
		}
		if (this.ddtMode) {
			this.endDdtSession();
		}
		const { remoteComName, drive } = this.lastDdtLaunch;
		return this.launchDdt(remoteComName, drive);
	}

	disconnect() {
		if (this.hiddenCommandInProgress) {
			this.hiddenCommandInProgress = false;
			this._onBusyChange.fire(false);
			this._onActivity.fire('Cancelled active serial task');
		}

		if (this.ddtMode) {
			this.flushDdtScanBuffer();
			this.resetDdtState();
			this._onDdtModeChanged.fire(false);
			// Leaves the DEBUG panel's listing/registers/output as they were -
			// see endDdtSession()'s comment on why that's left in place for
			// the user to review, which applies here too.
		}
		// A restart against a now-disconnected (or since-reopened, possibly
		// different) connection doesn't mean anything.
		this.lastDdtLaunch = undefined;

		// The "last known drive" doesn't survive a disconnect either - it's
		// meaningless for whatever connects next (a different port, a
		// power-cycled device defaulting back to A:, etc.), and leaving it
		// set is actively dangerous: selectDrive() treats a matching
		// currentDrive as "already there, nothing to send", so a stale value
		// could make it silently skip the real select on the new connection,
		// leaving operations writing to whatever drive the device actually
		// booted to instead of the one the software thinks is current.
		this.currentDrive = undefined;

		// Invalidate all existing serial links so stale transfer tasks cannot
		// continue writing into a newly-opened connection.
		this.connectionGeneration++;

		if (this.port?.isOpen) {
			this.port.close();
			this._onActivity.fire('Disconnected');
		}
	}

	async resetConnection(): Promise<void> {
		const wasOpen = this.port?.isOpen ?? false;
		if (!wasOpen) {
			this._onActivity.fire('Reset requested but serial port is not connected');
			return;
		}

		this._onActivity.fire('Resetting serial connection…');
		this.disconnect();
		await new Promise(resolve => setTimeout(resolve, 250));
		await this.connect();
		this._onActivity.fire('Serial connection reset complete');
	}

	dispose() {
		this.disconnect();
		this.log.dispose();
	}

	/**
	 * Sends interactive keystrokes typed by the user at the main terminal.
	 * Ignored while a background command (drive scan, DIR listing, file
	 * transfer) has exclusive control of the line - CP/M only has one
	 * console, so the two must never write to it at the same time. Not used
	 * for DDT commands - see stepDdt()/goDdt(), the only way those are ever
	 * sent, so this never needs to guess at what the user typed.
	 */
	sendData(data: string) {
		if (this.hiddenCommandInProgress) {
			return;
		}
		this.writeRaw(data);
	}

	private writeRaw(data: string | Buffer) {
		if (this.port?.isOpen) {
			if (this.traceEnabled()) {
				const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
				this.log.appendLine(`[${new Date().toISOString()}] TX ${formatHexDump(buffer)}`);
			}
			this.port.write(data);
		}
	}

	/**
	 * Writes `data` one byte at a time, pausing `charDelayMs` after each -
	 * or the longer `lineDelayMs` instead whenever that byte is a line
	 * terminator ('\r' or '\n') - rather than writeRaw()'s single unbroken
	 * write. Gives a receiver that needs to actually process/buffer each
	 * line (e.g. PIP reading a raw binary stream from CON:/RDR: on a slow
	 * BIOS) enough time to keep up, at the cost of a much slower transfer.
	 * Used by streamRemoteCcpFileRaw() - the byte-pacing raw-PIP install
	 * path is already the least reliable of Remote CCP's install methods
	 * (see bootstrapRemoteCcp), so trading speed for a better shot at
	 * landing intact is the right tradeoff there specifically.
	 */
	private async writeRawPaced(data: Buffer, charDelayMs = 3, lineDelayMs = 50): Promise<void> {
		for (const byte of data) {
			this.writeRaw(Buffer.from([byte]));
			const isLineEnd = byte === 0x0d || byte === 0x0a;
			await new Promise(resolve => setTimeout(resolve, isLineEnd ? lineDelayMs : charDelayMs));
		}
	}

	/**
	 * Runs `work` with sole ownership of the serial line, blocking interactive
	 * input for its duration so a background probe (drive scan, DIR listing,
	 * file transfer) can't interleave with - and corrupt - what the user is
	 * typing at the CP/M prompt. `label` is surfaced in the activity log.
	 */
	async withExclusiveAccess<T>(label: string, work: () => Promise<T>): Promise<T> {
		const run = async (): Promise<T> => {
			const driveBefore = this.currentDrive;
			const generation = this.connectionGeneration;
			this.hiddenCommandInProgress = true;
			this._onBusyChange.fire(true);
			this._onActivity.fire(label);
			try {
				return await work();
			} finally {
				// Restore the drive the user was on before this background
				// operation ran, so they land back where they were rather
				// than wherever the last scan/transfer happened to leave
				// the CCP - but only if the connection `work()` ran against
				// is still the one that's live. Attempting it against a
				// connection that's been reset/disconnected (or, worse,
				// reopened fresh under a new generation in the meantime)
				// would either throw again - masking whatever error
				// `work()` actually failed with - or send a leftover
				// "restore" command into a connection this operation was
				// never meant to touch.
				if (driveBefore && driveBefore !== this.currentDrive && generation === this.connectionGeneration) {
					await this.selectDrive(driveBefore);
					this._onActivity.fire(`Restored current drive to ${driveBefore}:`);
				}
				this.hiddenCommandInProgress = false;
				this._onBusyChange.fire(false);
				this._onActivity.fire('Ready');
			}
		};

		// Chain onto the tail rather than running immediately, so a call
		// issued while an earlier one is still in flight waits for it
		// instead of running concurrently against the same wire - see
		// exclusiveAccessTail's own comment.
		const resultPromise = this.exclusiveAccessTail.then(run, run);
		this.exclusiveAccessTail = resultPromise.then(() => undefined, () => undefined);
		return resultPromise;
	}

	/** @deprecated Use connect() */
	async openTerminal() {
		await this.connect();
	}

	private handleSerialData(data: Buffer) {
		if (this.traceEnabled()) {
			this.log.appendLine(`[${new Date().toISOString()}] RX ${formatHexDump(data)}`);
		}
		const text = data.toString();
		this.inputBuffer += text;
		this.lastDataTime = Date.now();
		this._onRawData.fire({ generation: this.connectionGeneration, data });

		// See promptRegex's comment re: CP/M 3/MP/M's optional user-area digit.
		const promptMatches = text.match(/[A-P]\d{0,2}>/g);
		if (promptMatches) {
			this.currentDrive = promptMatches[promptMatches.length - 1][0];
			if (this.ddtMode && this.ddtSeenPrompt) {
				// A normal CCP prompt reappearing (after DDT's own prompt has
				// genuinely been seen at least once - see ddtSeenPrompt) means
				// DDT (or the program it ran) has returned control to the CCP -
				// this chunk is regular (post-DDT) output, handled by the
				// branch below like any other. Covers both "quit DDT" and a
				// running program warm-booting straight past DDT to the CCP.
				this.flushDdtScanBuffer();
				this.resetDdtState();
				this._onDdtModeChanged.fire(false);
				// Leaves the DEBUG panel's listing/registers/output as they were -
				// see endDdtSession()'s comment on why that's left in place for
				// the user to review, which applies here too.
				this._onActivity.fire('DDT session ended');
			}
		}

		if (!this.hiddenCommandInProgress) {
			if (this.ddtMode) {
				this.routeDdtResponse(text);
			} else {
				this._onData.fire(text);
			}
		}
	}

	/**
	 * Longest suffix of `buffer` that could still grow into a full DDT
	 * prompt match ("\r\n-" or "*XXXX\r\n-") given more incoming bytes -
	 * e.g. "\r" or "\r\n", or "*", "*3", "*3F", "*3F0", "*3F09", "*3F09\r",
	 * "*3F09\r\n". Anything before this suffix can never become part of a
	 * match no matter what arrives next, so it's safe for routeDdtResponse() to
	 * flush immediately rather than waiting for the buffer to reach some
	 * fixed size - which is what let short output (a handful of bytes) sit
	 * unflushed indefinitely before this existed.
	 */
	private static ddtPromptPartialTailLength(buffer: string): number {
		const isPartialPrefix = (s: string) =>
			/^\r\n?$/.test(s) || /^\*[0-9A-F]{0,4}\r?\n?$/.test(s);
		const maxLen = Math.min(buffer.length, 7); // "*XXXX\r\n" - longest possible partial (the 8th char completes a full match, caught separately)
		for (let len = maxLen; len > 0; len--) {
			if (isPartialPrefix(buffer.slice(buffer.length - len))) {
				return len;
			}
		}
		return 0;
	}

	/**
	 * Sends one of DDT's own commands and marks its response as in flight -
	 * the only way anything is ever sent to DDT (see the DDT_MODE note on
	 * ddtPending: there is no free-typing). `kind` records which command
	 * this is, so routeDdtResponse() knows both how to treat the response
	 * (see isDdtResponseTrusted()) and what to do once it's complete.
	 */
	private beginDdtCommand(command: string, kind: 'examine' | 'step' | 'go'): void {
		this.ddtPending = kind;
		this.ddtScanBuffer = '';
		this.ddtPendingEcho = command;
		this.writeRaw(command);
	}

	/** Sends DDT's `T` (single-step one instruction) command. A no-op if a DDT session isn't active or another command's response hasn't resolved yet - the DEBUG panel already keeps Step/Step Over/Go disabled for that window, this is just the same invariant enforced at the source. */
	stepDdt(): void {
		if (!this.ddtMode || this.ddtPending) {
			return;
		}
		this.beginDdtCommand('T\r', 'step');
	}

	/**
	 * Sends DDT's `G` (go) command - runs from the current PC, stopping at
	 * whichever of `bp1`/`bp2` are given, using DDT's own `G,bp1,bp2`
	 * breakpoint syntax (either, both, or neither may be given - a bare `G`
	 * runs unconditionally). Used both for the DEBUG panel's own Go button
	 * (which passes its two user-set breakpoints) and Step Over (which
	 * passes the address right after a CALL as bp1, to run it to completion
	 * instead of stepping into it - see debug.js's btn-step-over handler).
	 * Same no-op guard as stepDdt().
	 */
	goDdt(bp1?: string, bp2?: string): void {
		if (!this.ddtMode || this.ddtPending) {
			return;
		}
		const breakpoints = [bp1, bp2].filter((bp): bp is string => !!bp);
		const command = (breakpoints.length ? `G,${breakpoints.join(',')}` : 'G') + '\r';
		this.beginDdtCommand(command, 'go');
	}

	/**
	 * Routes incoming serial data while a DDT session is active. Every byte
	 * arriving here is in reply to a command *we* chose (ddtPending is
	 * always exactly which one - see the DDT_MODE note on that field), so
	 * there's always a definite answer to "is this still DDT replying to
	 * the last thing sent, or has something else's output started" -
	 * isDdtResponseTrusted() (true for the launch banner, X, and T, none of
	 * which run an unbounded amount of target code, so everything received
	 * is unambiguously DDT's own and streams to the DEBUG panel live as it
	 * arrives; false only for G, which can run an arbitrary amount of the
	 * debugged program's own code and so might produce real, unpredictable
	 * output, so incoming text defaults to the main terminal and only a
	 * recognized DDT prompt shape is pulled out for the DEBUG panel - see
	 * ddtPromptPartialTailLength()).
	 *
	 * Either way, once DDT's own prompt shape ("*addr\r\n-" or a bare
	 * "\r\n-") is found in the accumulated response, it's complete:
	 * ddtSeenPrompt arms the CCP-prompt exit-detection above, and either
	 * another command is chased automatically, or the DEBUG panel is told
	 * the session is ready for the next button press. The launch banner,
	 * every G stop, AND every T step are all followed by an auto-X - only
	 * X's own response reliably pairs the true current PC with its
	 * disassembly. A T's own response reprints the *previous* register/
	 * disasm state (whatever was already known/displayed before this step)
	 * and only appends a trailing "*nnnn" - with no disassembly of its own -
	 * for where execution actually landed; treating that as "good enough"
	 * left the DEBUG panel's registers/listing, and Step Over's own
	 * decision of whether the *next* instruction is a CALL, all one step
	 * stale until whatever ran next happened to correct it - e.g. Step Over
	 * re-issuing a G at an address DDT had already stepped past, running
	 * that CALL a second time. Only 'examine' (X) itself is exempt, since
	 * chasing an X after an X would loop forever.
	 *
	 * If nothing is pending at all (ddtPending undefined - DDT and the
	 * device should both be idle), there's no in-flight command this could
	 * be a response to, so it isn't guessed at: it goes straight to the
	 * main terminal like any other unclassified data.
	 *
	 * Before any of that: whatever's still left in ddtPendingEcho - the
	 * echo of the command we just sent - is consumed first, unconditionally
	 * trusted regardless of isDdtResponseTrusted() (even a G's echo is 100%
	 * known, it's not the debugged program's output). Without this, a
	 * G's own echo - arriving before DDT or the program has said anything
	 * back - would fall through to the untrusted-by-default handling below
	 * and land in the main terminal.
	 */
	private routeDdtResponse(text: string): void {
		if (!this.ddtPending) {
			this._onData.fire(text);
			return;
		}

		if (this.ddtPendingEcho) {
			const consumeLen = Math.min(text.length, this.ddtPendingEcho.length);
			this._onDebugData.fire(text.slice(0, consumeLen));
			this.ddtPendingEcho = this.ddtPendingEcho.slice(consumeLen);
			text = text.slice(consumeLen);

			// DDT prints its own "\r\n" immediately once it's read the command
			// line back (the same convention the CCP itself uses before
			// running a program), right after the character-echo of our sent
			// command - not something we sent ourselves, but still preamble
			// rather than real content. Left unconsumed, this fell through to
			// the trusted/untrusted classification below same as anything
			// else: for a trusted response (T/X/launch) that's harmless
			// (everything goes to the DEBUG panel regardless), but for an
			// untrusted one (G) it was wrongly counted as part of "whatever
			// the debugged program printed before DDT's prompt reappeared" -
			// e.g. text like "04,0107\r\r\nH*0107\r\n-" (echo of "04,0107\r"
			// followed by DDT's own "\r\n", then the program's real "H",
			// then DDT's stop prompt) left a stray "\r\n" glued onto the
			// front of "H" in the main terminal, showing up as a spurious
			// blank line ahead of every character the program printed.
			if (!this.ddtPendingEcho && text.startsWith('\r\n')) {
				this._onDebugData.fire('\r\n');
				text = text.slice(2);
			}

			if (!text) {
				return;
			}
		}

		const DDT_PROMPT_PATTERN = /(\*[0-9A-F]{4}\r\n-)|(\r\n-)/m;
		const trusted = this.isDdtResponseTrusted();

		if (trusted) {
			this._onDebugData.fire(text);
		}
		this.ddtScanBuffer += text;

		const match = DDT_PROMPT_PATTERN.exec(this.ddtScanBuffer);
		if (match) {
			this.ddtSeenPrompt = true;
			if (!trusted) {
				const beforeMatch = this.ddtScanBuffer.slice(0, match.index);
				const fromMatchOnward = this.ddtScanBuffer.slice(match.index);
				if (beforeMatch) {
					this._onData.fire(beforeMatch);
				}
				// The matched prompt itself, plus anything already buffered
				// right after it in this same chunk, is DDT's own output.
				this._onDebugData.fire(fromMatchOnward);
			}
			const completedKind = this.ddtPending;
			this.ddtScanBuffer = '';
			this.ddtPending = undefined;

			if (completedKind === 'examine') {
				this._onDdtReady.fire();
			} else {
				this.beginDdtCommand('X\r', 'examine');
			}
			return;
		}

		if (trusted) {
			// Nothing to flush anywhere - already streamed above. Just cap
			// how much of the (already-shown) banner/dump text this keeps
			// around for pattern-matching purposes.
			if (this.ddtScanBuffer.length > 8) {
				this.ddtScanBuffer = this.ddtScanBuffer.slice(-8);
			}
			return;
		}

		const keepLen = SerialTerminal.ddtPromptPartialTailLength(this.ddtScanBuffer);
		if (this.ddtScanBuffer.length > keepLen) {
			const flushLen = this.ddtScanBuffer.length - keepLen;
			this._onData.fire(this.ddtScanBuffer.slice(0, flushLen));
			this.ddtScanBuffer = this.ddtScanBuffer.slice(flushLen);
		}
	}

	/**
	 * Facade handed to protocol implementations (XModem, Slide) so their
	 * reads go through this connection's single paused-mode reader instead
	 * of attaching a competing `port.on('data', ...)` listener of its own.
	 */
	private getSerialLink(): SerialLink {
		const linkGeneration = this.connectionGeneration;
		return {
			write: (data: Buffer) => {
				if (linkGeneration !== this.connectionGeneration) {
					throw new ConnectionResetError();
				}
				this.writeRaw(data);
			},
			onData: (listener: (data: Buffer) => void) => this.onRawData((evt) => {
				if (evt.generation === linkGeneration) {
					listener(evt.data);
				}
			}),
			drain: () => new Promise<void>((resolve, reject) => {
				if (!this.port?.isOpen) {
					resolve();
					return;
				}
				this.port.drain((err) => (err ? reject(err) : resolve()));
			}),
			flush: () => new Promise<void>((resolve, reject) => {
				if (!this.port?.isOpen) {
					resolve();
					return;
				}
				this.port.flush((err) => (err ? reject(err) : resolve()));
			}),
			baudRate: () => this.port?.baudRate ?? 19200,
		};
	}

	/**
	 * Waits until no new serial data has arrived for `idleMs`, so a multi-line
	 * response (e.g. DIR output) has time to fully arrive instead of assuming
	 * it's done after one fixed delay. Throws ConnectionResetError as soon as
	 * a disconnect/reset happens mid-wait, instead of polling out the rest of
	 * `timeoutMs` against a connection that's gone - see the class it throws
	 * for why that matters.
	 */
	private async waitForIdle(idleMs = 300, timeoutMs = 4000): Promise<void> {
		const generation = this.connectionGeneration;
		const start = Date.now();
		this.lastDataTime = Date.now();
		while (Date.now() - start < timeoutMs) {
			await new Promise(resolve => setTimeout(resolve, 50));
			if (generation !== this.connectionGeneration) {
				throw new ConnectionResetError();
			}
			if (Date.now() - this.lastDataTime >= idleMs) {
				return;
			}
		}
	}

	/**
	 * Polls the buffer captured since `sinceLength` for a "X>" prompt, up to
	 * `timeoutMs`. Selecting a drive can involve real disk I/O (mounting,
	 * seeking) that on some hardware takes seconds - a fixed "quiet for
	 * 300ms" heuristic sees the near-instant echo of the typed command,
	 * mistakes that gap for completion, and moves on while the real prompt is
	 * still on its way. Waiting for the prompt itself, rather than for
	 * silence, is the only way to tell "still working" from "actually done".
	 * Throws ConnectionResetError as soon as a disconnect/reset happens
	 * mid-wait - see waitForIdle().
	 */
	private async waitForPrompt(sinceLength: number, timeoutMs = 5000): Promise<boolean> {
		const generation = this.connectionGeneration;
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			if (this.promptRegex.test(this.inputBuffer.slice(sinceLength))) {
				return true;
			}
			await new Promise(resolve => setTimeout(resolve, 50));
			if (generation !== this.connectionGeneration) {
				throw new ConnectionResetError();
			}
		}
		return this.promptRegex.test(this.inputBuffer.slice(sinceLength));
	}

	/**
	 * Selects `drive` and waits for its prompt to confirm the CCP has
	 * actually finished the switch. If no prompt shows up in time - e.g. the
	 * device is stuck showing an error for a drive that doesn't exist and
	 * waiting for a keypress to dismiss it - sends a bare CR to nudge it back
	 * to a known state so the next command sent isn't swallowed as that
	 * dismissal keystroke.
	 */
	private async selectDrive(drive: string, timeoutMs = 5000): Promise<boolean> {
		if (this.currentDrive === drive) {
			// Some CCPs don't reliably re-print a fresh prompt when you
			// reselect the drive you're already on - reselecting anyway
			// just burns the full waitForPrompt timeout (seen firsthand:
			// 5s wasted per redundant check, cascading into further
			// unnecessary work in callers like ensure*OnDrive that retry
			// on a false "not found") for no benefit, since we already
			// know where the CCP is from the last real prompt seen.
			return true;
		}

		const start = this.inputBuffer.length;
		this.writeRaw(`${drive}:\r`);
		const found = await this.waitForPrompt(start, timeoutMs);
		if (!found) {
			this.writeRaw('\r');
			await this.waitForIdle(300, 1000);
		}
		return found;
	}

	/**
	 * Sends Ctrl-C to nudge the CCP back to a known idle prompt before a
	 * drive/file scan begins. Some CCPs treat Ctrl-C as "abort the current
	 * input line"; as the first character of a line, others do a full warm
	 * boot (reloading the CCP from disk) - either way this resyncs a
	 * console left mid-command or showing stale output from a previous
	 * session. Not seeing a prompt afterward isn't fatal: a device already
	 * sitting at a clean prompt has no reason to echo anything back for a
	 * bare Ctrl-C, and the scan proceeds regardless.
	 */
	private async resyncConsole(): Promise<void> {
		const start = this.inputBuffer.length;
		this.writeRaw(Buffer.from([0x03]));
		await this.waitForPrompt(start, 5000);
	}

	async showConfiguration() {
		vscode.commands.executeCommand('cpmIde.serialTerminal.focus');
	}

	/** The CP/M program to use for auto transfers, captured once per transfer request rather than re-read when a queued item's turn comes - a later dropdown change can't retroactively alter an already-queued item's protocol. */
	private getTransferApplication(): string {
		return vscode.workspace.getConfiguration('cpmIde').get<string>('transferApplication') || 'REMOTCCP.COM';
	}

	async transferFileToDevice(localFilePath: string, drive: string): Promise<boolean> {
		if (!this.port?.isOpen) {
			vscode.window.showErrorMessage('Serial port not connected');
			return false;
		}

		if (!drive) {
			vscode.window.showErrorMessage('No target CP/M drive selected');
			return false;
		}

		const fileName = path.basename(localFilePath);
		// CP/M filenames are uppercase; the CCP doesn't case-fold what we send it.
		const remoteFileName = fileName.toUpperCase();
		const fileContent = fs.readFileSync(localFilePath);
		const app = this.getTransferApplication();

		try {
			await this.transferQueue.enqueue(fileName, 'send', fileContent.length, (onProgress, isCancelled) =>
				this.withExclusiveAccess(`Sending ${fileName} to ${drive}: via ${app}…`, () =>
					this.sendOneFileVia(app, drive, localFilePath, remoteFileName, fileContent, onProgress, isCancelled)
				)
			);
			this._onActivity.fire(`Sent ${fileName}`);
			vscode.window.showInformationMessage(`File ${fileName} transferred to device`);
			return true;
		} catch (error) {
			if (error instanceof TransferCancelledError || error instanceof ConnectionResetError || !this.port?.isOpen) {
				this._onActivity.fire(`Cancelled: ${fileName}`);
				return false;
			}
			this._onActivity.fire(`Failed to send ${fileName}`);
			vscode.window.showErrorMessage(`Transfer failed: ${error}`);
			return false;
		}
	}

	/**
	 * Sends `fileContent` (already read from `localFilePath`) to `drive` as
	 * `remoteFileName`, using `app` (one of the cpmIde.transferApplication
	 * values) - existence-checked on `drive` first, no silent fallback to a
	 * different protocol if that check or the transfer itself fails. Must be
	 * called from within withExclusiveAccess.
	 */
	private async sendOneFileVia(
		app: string,
		drive: string,
		localFilePath: string,
		remoteFileName: string,
		fileContent: Buffer,
		onProgress: (bytesTransferred: number) => void,
		isCancelled: () => boolean
	): Promise<void> {
		if (app === 'XMODEM.COM') {
			if (!await this.ensureXModemOnDrive(drive)) {
				throw new Error(
					`XMODEM.COM not found on drive ${drive}: and no copy available on A: - install it on the device first`
				);
			}
			// ensureXModemOnDrive() leaves `drive` selected as the current drive.
			// /F skips XMODEM.COM's "Overwrite (Y/N)?" prompt, which would
			// otherwise hang forever waiting for a keypress we never send.
			// /X0 forces the transfer through CON: (the same serial
			// connection everything else here uses) instead of XMODEM.COM's
			// default of RDR:/PUN: - on boards where those logical devices
			// aren't mapped to this same port, the console side (us) can
			// send all day and the receiver (listening on RDR:) never sees
			// any of it, aborting almost immediately with "ABORT: Sync
			// fail" - a device-side device-mapping mismatch, not a timing
			// issue, and no amount of getting our own timing right fixes it.
			this.writeRaw(`XMODEM ${remoteFileName} /F /R /X0\r`);
			// No fixed delay here before starting to listen - XModem.send()'s
			// own sync wait (waitForIsolatedByte(), a generous 60s budget)
			// already accounts for however long the CCP takes to load and
			// launch XMODEM.COM. A delay here instead risks the device's own
			// sync byte and timeout landing inside the delay window, before
			// the onData subscription this.getSerialLink() feeds even exists
			// to catch it.
			await this.xmodem.send(this.getSerialLink(), fileContent, remoteFileName, onProgress, isCancelled);
			return;
		}

		if (app === 'SLIDECPM.COM' || app === 'SLIDE.COM') {
			if (app === 'SLIDE.COM') {
				const reason = this.slideComUnavailableReason();
				if (reason) {
					throw new Error(reason);
				}
			}
			const ready = app === 'SLIDE.COM'
				? await this.ensureSlideComOnDrive()
				: await this.ensureSlideCpmOnDrive(drive);
			if (!ready) {
				throw new Error(app === 'SLIDE.COM'
					? `SLIDE.COM not found on A: - it must already be installed on the device`
					: `SLIDECPM.COM not found on drive ${drive}: and no copy available on A: - install it on the device first`
				);
			}
			// SLIDE.COM only ever runs from A: on microBeast - launched via an
			// explicit "A:SLIDE" so the CCP finds it there regardless of which
			// drive is current, while `drive` stays selected as current so the
			// files it receives land on the actual target drive.
			await this.selectDrive(drive);
			this.writeRaw(`${app === 'SLIDE.COM' ? 'A:SLIDE' : 'SLIDECPM'}\r`);
			// Give the CCP a moment to load and launch SLIDE(CPM).COM, and wait
			// for whatever it prints in response, before starting Slide's own
			// RDY/RDY handshake.
			await this.waitForIdle(300, 3000);
			const session = new SerialSession(this.getSerialLink());
			await sendFiles(session, [localFilePath], this.traceEnabled(), onProgress, isCancelled);
			return;
		}

		// REMOTCCP.COM (default) - launchRemoteCcp() already checks/bootstraps
		// REMOTCCP.COM's presence on `drive` internally, so there's no
		// separate ensure-step needed here.
		const sent = await this.withRemoteCcp(drive, async (client) => {
			await client.putFile(remoteFileName, fileContent, onProgress, isCancelled);
			return true;
		});
		if (!sent) {
			throw new Error(`Could not start a Remote CCP session on drive ${drive}:`);
		}
	}

	/**
	 * Sends `filePaths` to `drive` honoring the currently selected transfer
	 * application. A single file just goes through transferFileToDevice().
	 * For multiple files, REMOTCCP.COM and SLIDECPM.COM both support one
	 * session/handshake serving any number of files, so those are batched
	 * (one launch, one queue row) rather than relaunching per file - that
	 * relaunch-per-file was a real regression (very slow) from initially
	 * always looping transferFileToDevice() here. XMODEM.COM has no session
	 * to share - it's a fresh CP/M program invocation per file by protocol
	 * design - so it still sends one at a time.
	 */
	async sendFilesToDevice(filePaths: string[], drive: string): Promise<boolean> {
		if (!this.port?.isOpen) {
			vscode.window.showErrorMessage('Serial port not connected');
			return false;
		}

		if (!drive) {
			vscode.window.showErrorMessage('No target CP/M drive selected');
			return false;
		}

		if (filePaths.length === 0) {
			return false;
		}

		if (filePaths.length === 1) {
			return this.transferFileToDevice(filePaths[0], drive);
		}

		const app = this.getTransferApplication();
		if (app === 'SLIDECPM.COM' || app === 'SLIDE.COM') {
			return this.sendFileBatchViaSlide(app, filePaths, drive);
		}
		if (app === 'REMOTCCP.COM') {
			return this.sendFileBatchViaRemoteCcp(filePaths, drive);
		}

		let allOk = true;
		for (const filePath of filePaths) {
			if (!await this.transferFileToDevice(filePath, drive)) {
				allOk = false;
			}
		}
		return allOk;
	}

	/**
	 * Sends multiple files to `drive` through one shared Remote CCP session
	 * (one launch/quit, one queue row with aggregate progress) instead of
	 * relaunching REMOTCCP.COM per file - it's a resident session that can
	 * serve any number of FP (put file) requests without restarting.
	 */
	private async sendFileBatchViaRemoteCcp(filePaths: string[], drive: string): Promise<boolean> {
		const queueName = `${filePaths.length} files`;
		const files = filePaths.map(p => ({
			name: path.basename(p).toUpperCase(),
			content: fs.readFileSync(p),
		}));
		const totalBytes = files.reduce((sum, f) => sum + f.content.length, 0);

		try {
			await this.transferQueue.enqueue(queueName, 'send', totalBytes, (onProgress, isCancelled) =>
				this.withExclusiveAccess(`Sending ${queueName} to ${drive}: via REMOTCCP.COM…`, async () => {
					const sent = await this.withRemoteCcp(drive, async (client) => {
						let bytesDoneInEarlierFiles = 0;
						for (const file of files) {
							await client.putFile(
								file.name,
								file.content,
								(bytesInFile) => onProgress(bytesDoneInEarlierFiles + bytesInFile),
								isCancelled
							);
							bytesDoneInEarlierFiles += file.content.length;
						}
						return true;
					});
					if (!sent) {
						throw new Error(`Could not start a Remote CCP session on drive ${drive}:`);
					}
				})
			);
			this._onActivity.fire(`Sent ${filePaths.length} file(s) to ${drive}:`);
			vscode.window.showInformationMessage(`Sent ${filePaths.length} file(s) to ${drive}:`);
			return true;
		} catch (error) {
			if (error instanceof TransferCancelledError || error instanceof ConnectionResetError || !this.port?.isOpen) {
				this._onActivity.fire(`Cancelled: ${queueName}`);
				return false;
			}
			this._onActivity.fire('Send failed');
			vscode.window.showErrorMessage(`Send failed: ${error}`);
			return false;
		}
	}

	/**
	 * Sends multiple files to `drive` through one shared Slide handshake
	 * (one launch, one queue row with aggregate progress) - restores the
	 * batching Slide always had before transfer-application selection was
	 * introduced, rather than relaunching SLIDE(CPM).COM per file. `app` is
	 * 'SLIDECPM.COM' or 'SLIDE.COM' - see sendOneFileVia's matching branch for
	 * how the two differ (install support, device/baud restrictions).
	 */
	private async sendFileBatchViaSlide(app: string, filePaths: string[], drive: string): Promise<boolean> {
		const queueName = `${filePaths.length} files`;
		const totalBytes = filePaths.reduce((sum, p) => {
			try {
				return sum + fs.statSync(p).size;
			} catch (error) {
				return sum;
			}
		}, 0);

		try {
			await this.transferQueue.enqueue(queueName, 'send', totalBytes, (onProgress, isCancelled) =>
				this.withExclusiveAccess(`Sending ${queueName} to ${drive}: via ${app}…`, async () => {
					if (app === 'SLIDE.COM') {
						const reason = this.slideComUnavailableReason();
						if (reason) {
							throw new Error(reason);
						}
					}
					const ready = app === 'SLIDE.COM'
						? await this.ensureSlideComOnDrive()
						: await this.ensureSlideCpmOnDrive(drive);
					if (!ready) {
						throw new Error(app === 'SLIDE.COM'
							? `SLIDE.COM not found on A: - it must already be installed on the device`
							: `SLIDECPM.COM not found on drive ${drive}: and no copy available on A: - install it on the device first`
						);
					}
					// SLIDE.COM only ever runs from A: on microBeast - launched
					// via an explicit "A:SLIDE" so the CCP finds it there
					// regardless of which drive is current, while `drive` stays
					// selected as current so the files it receives land on the
					// actual target drive.
					await this.selectDrive(drive);
					this.writeRaw(`${app === 'SLIDE.COM' ? 'A:SLIDE' : 'SLIDECPM'}\r`);
					await this.waitForIdle(300, 3000);
					const session = new SerialSession(this.getSerialLink());
					await sendFiles(session, filePaths, this.traceEnabled(), onProgress, isCancelled);
				})
			);
			this._onActivity.fire(`Sent ${filePaths.length} file(s) to ${drive}:`);
			vscode.window.showInformationMessage(`Sent ${filePaths.length} file(s) to ${drive}:`);
			return true;
		} catch (error) {
			if (error instanceof TransferCancelledError || error instanceof ConnectionResetError || !this.port?.isOpen) {
				this._onActivity.fire(`Cancelled: ${queueName}`);
				return false;
			}
			this._onActivity.fire('Slide send failed');
			vscode.window.showErrorMessage(`Slide send failed: ${error}`);
			return false;
		}
	}

	/**
	 * "Debug Assembly": ensures DDT.COM is on the current drive, sends
	 * `comFilePath` (a freshly-assembled local .com) to that same drive,
	 * then launches DDT against it. Use debugRemoteFile() instead for a
	 * file that's already on the device - no local file, nothing to build
	 * or transfer.
	 */
	async debugAssemblyFile(comFilePath: string): Promise<boolean> {
		if (!this.port?.isOpen) {
			vscode.window.showErrorMessage('Serial port not connected');
			return false;
		}

		const drive = this.activeDrive;
		if (!drive) {
			vscode.window.showErrorMessage(
				'Current CP/M drive is not known yet - let the terminal settle on a prompt first, then retry'
			);
			return false;
		}

		if (!await this.ensureDdtOnDrive(drive)) {
			return false;
		}

		if (!await this.transferFileToDevice(comFilePath, drive)) {
			return false;
		}

		this.loadDdtListingFromPath(
			path.join(path.dirname(comFilePath), path.parse(comFilePath).name + '.lst')
		);
		return this.launchDdt(path.basename(comFilePath).toUpperCase(), drive);
	}

	/**
	 * Debugs a file already on the device - no build, no transfer, just
	 * ensures DDT.COM is present (same as debugAssemblyFile) and launches
	 * DDT directly against `fileName` on `drive`.
	 */
	async debugRemoteFile(fileName: string, drive: string): Promise<boolean> {
		if (!this.port?.isOpen) {
			vscode.window.showErrorMessage('Serial port not connected');
			return false;
		}

		if (!await this.ensureDdtOnDrive(drive)) {
			return false;
		}

		this.loadDdtListingForRemoteFile(fileName);
		return this.launchDdt(fileName.toUpperCase(), drive);
	}

	/**
	 * There's no local copy of a remote-only debug target, so the matching
	 * .lst (if any) is looked up by name in the workspace root instead of
	 * next to a known local .com path - see loadDdtListingFromPath().
	 */
	private loadDdtListingForRemoteFile(fileName: string): void {
		const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
		if (!workspaceFolder) {
			this._onDdtListingChanged.fire(undefined);
			return;
		}
		const baseName = path.parse(fileName).name;
		this.loadDdtListingFromPath(path.join(workspaceFolder.uri.fsPath, baseName + '.lst'));
	}

	/**
	 * Loads and parses the .lst matching the file under debug, if one exists
	 * at `lstPath`, and fires onDdtListingChanged with the result (or
	 * undefined if there's no listing to show) - the DEBUG panel uses this
	 * to display source context around the current PC alongside the
	 * registers. Best-effort: a missing or unparseable listing just means no
	 * source view, not a failed debug launch.
	 */
	private loadDdtListingFromPath(lstPath: string): void {
		if (!fs.existsSync(lstPath)) {
			this._onDdtListingChanged.fire(undefined);
			return;
		}
		try {
			const lines = parseListingFile(fs.readFileSync(lstPath, 'utf8'));
			this._onActivity.fire(`Loaded listing ${path.basename(lstPath)} (${lines.length} addressed line(s))`);
			this._onDdtListingChanged.fire(lines);
		} catch {
			this._onDdtListingChanged.fire(undefined);
		}
	}

	/**
	 * Confirms DDT.COM is present on `drive`, copying the bundled
	 * remote/DDT.COM there if missing - not something any device already
	 * has, unlike REMOTCCP.COM/XMODEM.COM/SLIDECPM.COM which the
	 * ensure*OnDrive helpers can copy device-to-device via A:.
	 */
	private async ensureDdtOnDrive(drive: string): Promise<boolean> {
		const ddtLocalPath = this.context.asAbsolutePath(path.join('remote', 'DDT.COM'));
		if (!fs.existsSync(ddtLocalPath)) {
			vscode.window.showErrorMessage('Bundled DDT.COM not found - reinstall the extension');
			return false;
		}

		const hasDdt = await this.withExclusiveAccess(
			`Checking for DDT.COM on ${drive}:…`,
			() => this.hasFileOnDrive(drive, 'DDT.COM')
		);
		if (hasDdt) {
			return true;
		}
		return this.transferFileToDevice(ddtLocalPath, drive);
	}

	/**
	 * Types `DDT <remoteComName>` at the CCP and enters DDT_MODE. DDT is
	 * interactive - this only launches it and returns; the user drives it
	 * from there through the DEBUG panel/terminal keystroke path, the same
	 * as typing any other command. Must be called with `drive` already
	 * selected as the CCP's current drive (both callers' preceding steps -
	 * a transfer, or ensureDdtOnDrive's own DIR check - already leave it
	 * there, so reselecting here would just be a pointless multi-second
	 * round trip standing between "DDT launched" and control actually
	 * returning to the user).
	 */
	private async launchDdt(remoteComName: string, drive: string): Promise<boolean> {
		this.lastDdtLaunch = { remoteComName, drive };
		const command = `DDT ${remoteComName}\r`;
		await this.withExclusiveAccess(`Launching DDT ${remoteComName}…`, async () => {
			this.writeRaw(command);
		});

		this.ddtMode = true;
		this.ddtSeenPrompt = false;
		this.ddtScanBuffer = '';
		this.ddtPendingEcho = command;
		// The launch banner ends without ever reporting registers - treating
		// it as a 'launch'-kind response (same as any other DDT command, via
		// routeDdtResponse()) means the moment it completes, the SAME auto-X
		// logic used after every G stop fires here too, seeding the DEBUG
		// panel's register/listing display instead of leaving it blank
		// until the user's first Step/Go.
		this.ddtPending = 'launch';
		this._onDdtModeChanged.fire(true);
		this._onActivity.fire(`Launched DDT ${remoteComName} on ${drive}: - continue in the DEBUG panel`);

		return true;
	}

	/**
	 * Confirms XMODEM.COM is present on `drive`, copying it from A: (the
	 * conventional CP/M system drive) via PIP first if it's missing there.
	 * Must be called from within `withExclusiveAccess`. Leaves `drive`
	 * selected as the CCP's current drive.
	 */
	private async ensureXModemOnDrive(drive: string): Promise<boolean> {
		let comReady = await this.hasFileOnDrive(drive, 'XMODEM.COM');

		if (!comReady) {
			if (drive === 'A') {
				this._onActivity.fire('XMODEM.COM was not detected in A: listing - trying transfer anyway');
				comReady = true;
			} else {
				this._onActivity.fire(`XMODEM.COM not found on ${drive}: - checking A: for a copy…`);
				if (!await this.hasFileOnDrive('A', 'XMODEM.COM')) {
					return false;
				}
				comReady = await this.copyFileFromA('A', drive, 'XMODEM.COM');
				if (!comReady) {
					return false;
				}
			}
		}

		// XMODEM.COM reads XMODEM.CFG from whichever drive is current when
		// it's launched - not always A:, even if that's where the "real"
		// config lives (e.g. the /X0 override selecting the console as the
		// transfer port). Without a matching copy here, it silently falls
		// back to its built-in default (RDR/PUN on many builds), which on
		// boards where that port isn't wired to anything fails with
		// "ABORT: Init timeout" instead of using the configured port.
		// Best-effort: a missing/failed copy just means the built-in
		// defaults apply, not a reason to abort the transfer.
		if (drive !== 'A' && !await this.hasFileOnDrive(drive, 'XMODEM.CFG') && await this.hasFileOnDrive('A', 'XMODEM.CFG')) {
			await this.copyFileFromA('A', drive, 'XMODEM.CFG');
		}

		return true;
	}

	private async copyFileFromA(source: string, drive: string, fileName: string): Promise<boolean> {
		this._onActivity.fire(`Copying ${fileName} from ${source}: to ${drive}:…`);
		this.writeRaw(`PIP ${drive}:=${source}:${fileName}\r`);
		await this.waitForIdle(500, 8000);

		const copied = await this.hasFileOnDrive(drive, fileName);
		this._onActivity.fire(copied ? `${fileName} copied to ${drive}:` : `Failed to copy ${fileName} to ${drive}:`);
		return copied;
	}

	/**
	 * Confirms SLIDECPM.COM is present on `drive`, copying it from A: via PIP
	 * first if it's missing there - mirroring ensureXModemOnDrive's pattern
	 * (minus XMODEM.CFG's config-copy step, which has no SLIDECPM.COM
	 * equivalent). Must be called from within withExclusiveAccess.
	 */
	private async ensureSlideCpmOnDrive(drive: string): Promise<boolean> {
		if (await this.hasFileOnDrive(drive, 'SLIDECPM.COM')) {
			return true;
		}
		if (drive === 'A') {
			return false;
		}
		if (!await this.hasFileOnDrive('A', 'SLIDECPM.COM')) {
			return false;
		}
		return await this.copyFileFromA('A', drive, 'SLIDECPM.COM');
	}

	/**
	 * Confirms SLIDE.COM is present on A:. Unlike SLIDECPM.COM, it only ever
	 * runs from A: on microBeast (never copied to/launched from another
	 * drive), and there's no bootstrap/copy support for it either way - it's
	 * a microBeast-specific program that's expected to already be on the
	 * device, not something this codebase bundles or knows how to install.
	 */
	private async ensureSlideComOnDrive(): Promise<boolean> {
		return await this.hasFileOnDrive('A', 'SLIDE.COM');
	}

	/**
	 * Checks whether SLIDE.COM can be used right now, returning a
	 * human-readable reason it can't (to surface as an error) or undefined if
	 * it's fine to proceed. SLIDE.COM is microBeast-only and only runs at
	 * 19,200 baud - unlike the other transfer applications, its baud rate
	 * isn't just a setting, it's a hard requirement of the program itself, so
	 * this is checked against the serial port's actual current baud rather
	 * than the cpmIde.baudRate setting (which could differ from what the port
	 * was actually opened with).
	 */
	private slideComUnavailableReason(): string | undefined {
		const deviceType = getDeviceType();
		if (deviceType !== 'microBeast') {
			return 'SLIDE.COM is only available on microBeast devices - choose a different transfer application or switch cpmIde.deviceType to microBeast';
		}
		if (this.port?.baudRate !== 19200) {
			return 'SLIDE.COM only works at 19,200 baud - reconnect at 19,200 baud and try again';
		}
		return undefined;
	}

	/**
	 * The drive REMOTCCP.COM is bootstrapped/looked up on before being
	 * propagated to wherever a transfer actually needs it - A: for every
	 * device except microBeast, which needs it on B: instead: microBeast's
	 * post-install A:WRITE step (see runTargetPostInstallHook) can overwrite
	 * A:, which would destroy a copy left there before it had a chance to
	 * propagate anywhere else.
	 */
	private remoteCcpHomeDrive(): string {
		const deviceType = getDeviceType();
		return deviceType === 'microBeast' ? 'B' : 'A';
	}

	/**
	 * Confirms REMOTCCP.COM is present on `drive`, bootstrapping it onto its
	 * home drive (remoteCcpHomeDrive() - prompting the user first) and/or
	 * copying it from there via PIP as needed - mirroring
	 * ensureXModemOnDrive's pattern. Must be called from within
	 * withExclusiveAccess.
	 */
	private async ensureRemoteCcpOnDrive(drive: string): Promise<boolean> {
		if (await this.hasFileOnDrive(drive, REMOTE_CCP_FILENAME)) {
			return true;
		}
		const home = this.remoteCcpHomeDrive();
		if (drive !== home) {
			return await this.ensureRemoteCcpOnDrive(home) && await this.copyFileFromA(home, drive, REMOTE_CCP_FILENAME);
		}
		return await this.bootstrapRemoteCcp();
	}

	/**
	 * Installs REMOTCCP.COM onto its home drive for the first time, after
	 * asking the user. Tries up to five methods in order, each falling back
	 * to the next on failure or missing prerequisites:
	 *
	 * 0. SLIDE (installRemoteCcpViaSlide) - microBeast only. SLIDE.COM is
	 *    normally already on these devices' A:, and its windowed/CRC16
	 *    transfer is just as resilient as XMODEM without going through
	 *    RDR: at all - tried first specifically on this device type, ahead
	 *    of even XMODEM.
	 * 1. XMODEM (installRemoteCcpViaXmodem) - block checksums and ACK/NAK
	 *    retries built into the protocol itself, rather than this code
	 *    having to work around hardware quirks after the fact. Tried first
	 *    on every other device type, for exactly that reason.
	 * 2. ED (installRemoteCcpViaEd) - inserting text through ED.COM's line
	 *    editor is driven entirely through the console, the same path
	 *    DIR/STAT/LOAD/etc. already use reliably throughout this file, so it
	 *    never touches RDR: (the reader device) at all - sidesteps RDR:'s
	 *    hardware-specific quirks rather than working around any one of
	 *    them.
	 * 3. Intel HEX via PIP (installRemoteCcpViaHex) - text-mode PIP,
	 *    checksummed per line, one record at a time. Still goes through
	 *    RDR:, but text mode has proven more reliable than raw binary.
	 * 4. Raw binary via PIP's object mode ("[O]") - the original approach;
	 *    has proven the least reliable of all four on real hardware, kept
	 *    only as a last resort for devices without any of XMODEM.COM,
	 *    ED.COM+LOAD.COM, or LOAD.COM+PIP.COM available.
	 */
	private async bootstrapRemoteCcp(): Promise<boolean> {
		const comPath = this.context.asAbsolutePath(path.join('remote', 'remotccp.com'));
		if (!fs.existsSync(comPath)) {
			this._onActivity.fire(`Remote CCP bootstrap failed: couldn't find bundled ${REMOTE_CCP_FILENAME}`);
			return false;
		}

		const home = this.remoteCcpHomeDrive();
		const choice = await vscode.window.showInformationMessage(
			`${REMOTE_CCP_FILENAME} isn't on ${home}: yet. It replaces the slower CCP-command-driven drive scans, ` +
			`file listings, and transfers with a small resident helper. Install it now over the serial link?`,
			{ modal: true },
			'Install'
		);
		if (choice !== 'Install') {
			return false;
		}

		let installed = false;

		// microBeast only: SLIDE.COM is normally already on A: there, and its
		// windowed/CRC16 transfer is at least as resilient as XMODEM's own
		// checksummed blocks while never touching RDR: at all - tried before
		// even XMODEM specifically on this device type.
		if (await this.canInstallRemoteCcpViaSlide()) {
			installed = await this.installRemoteCcpViaSlide();
			if (!installed) {
				this._onActivity.fire('SLIDE install failed - trying XMODEM…');
			}
		}

		// XMODEM's own block-level checksums and retries are specifically
		// designed to cope with an unreliable link, rather than this code
		// having to detect and route around hardware quirks after the fact
		// like every other method below - tried first for exactly that
		// reason.
		if (!installed && await this.canInstallRemoteCcpViaXmodem()) {
			installed = await this.installRemoteCcpViaXmodem();
			if (!installed) {
				this._onActivity.fire('XMODEM install failed - trying ED…');
			}
		}

		// ED never touches RDR: - inserting text is driven entirely through
		// the console, the same path DIR/STAT/LOAD/etc. already use
		// reliably throughout this file - so it sidesteps the hardware-
		// specific RDR: quirks (echoed transfers replaying as fake
		// keystrokes, PIP outright aborting) the other two methods below
		// have both hit, rather than working around any one of them.
		if (!installed && await this.canInstallRemoteCcpViaEd()) {
			installed = await this.installRemoteCcpViaEd();
			if (!installed) {
				this._onActivity.fire('ED install failed - trying Intel HEX via PIP…');
			}
		}

		// Raw binary through PIP's [O] mode has proven unreliable on real
		// hardware - prefer text-mode PIP + LOAD (Intel HEX, checksummed
		// per line) whenever both are available, and only fall back further
		// if they're missing or the hex install itself fails.
		if (!installed && await this.canInstallRemoteCcpViaHex()) {
			installed = await this.installRemoteCcpViaHex();
			if (!installed) {
				this._onActivity.fire('Intel HEX install via PIP failed - falling back to raw binary PIP transfer…');
			}
		}

		if (!installed) {
			await this.sendRemoteCcpPipReceiveCommand();
			// Give the CCP a moment to load and launch PIP before streaming.
			await new Promise(resolve => setTimeout(resolve, 300));
			installed = await this.streamRemoteCcpFileRaw();
		}

		if (installed) {
			await this.runTargetPostInstallHook();
		}
		return installed;
	}

	/**
	 * Runs whatever extra step a non-Generic device type (cpmIde.deviceType)
	 * needs right after REMOTCCP.COM has been confirmed installed. Currently
	 * only microBeast needs this: it requires A:WRITE to be run afterward,
	 * gated by cpmIde.autoWrite. Must be called from within
	 * withExclusiveAccess.
	 */
	private async runTargetPostInstallHook(): Promise<void> {
		const config = vscode.workspace.getConfiguration('cpmIde');
		const deviceType = config.get<string>('deviceType') ?? 'Generic';
		if (deviceType !== 'microBeast' || !(config.get<boolean>('autoWrite') ?? true)) {
			return;
		}

		this._onActivity.fire('microBeast device - running A:WRITE…');
		await this.selectDrive('A');
		const start = this.inputBuffer.length;
		this.writeRaw('A:WRITE\r');
		await this.waitForPrompt(start, 15000);
		await this.waitForIdle(500, 5000);

		const response = this.inputBuffer.slice(start);
		this._onActivity.fire(/error/i.test(response)
			? `A:WRITE reported an error: ${response.trim()}`
			: 'A:WRITE completed');
	}

	/** LOAD.COM and PIP.COM must both already be on A: for the Intel HEX install path. */
	private async canInstallRemoteCcpViaHex(): Promise<boolean> {
		return await this.hasFileOnDrive('A', 'LOAD.COM') && await this.hasFileOnDrive('A', 'PIP.COM');
	}

	/**
	 * Installs REMOTCCP.COM onto A: via Intel HEX instead of raw binary:
	 * binary -> Intel HEX text -> PIP (text mode, checksummed per line) ->
	 * LOAD -> .COM. Requires canInstallRemoteCcpViaHex() to have already
	 * confirmed LOAD.COM/PIP.COM are present. Must be called from within
	 * withExclusiveAccess.
	 */
	private async installRemoteCcpViaHex(): Promise<boolean> {
		const comPath = this.context.asAbsolutePath(path.join('remote', 'remotccp.com'));
		let fileContent: Buffer;
		try {
			fileContent = fs.readFileSync(comPath);
		} catch (error) {
			this._onActivity.fire(`Remote CCP install failed: couldn't read bundled ${REMOTE_CCP_FILENAME}`);
			return false;
		}

		const hexFileName = 'REMOTCCP.HEX';
		const hexLines = toIntelHex(fileContent).split('\r\n').filter(Boolean);
		const home = this.remoteCcpHomeDrive();

		// PIP.COM/LOAD.COM are looked up on A: (canInstallRemoteCcpViaHex) -
		// current drive stays A: throughout so the CCP can find them; the
		// destination drive (A: normally, C: for microBeast) is qualified
		// explicitly in each command below instead.
		await this.selectDrive('A');

		// One whole-file PIP transfer reliably ends with this hardware
		// replaying the entire thing back as fake keystrokes once PIP hands
		// control back to the CCP (garbled "?" unknown-command errors) -
		// seemingly some shared type-ahead buffer the BIOS's raw byte-input
		// routine feeds regardless of whether PIP or the CCP is the logical
		// reader. Sending one Intel HEX record (a single short line) per PIP
		// invocation keeps each RDR: session tiny: record 0 creates
		// hexFileName fresh, every record after that appends to it with
		// PIP's [A] parameter - no multi-source concatenation (tried first,
		// but this PIP silently produced an empty file instead of erroring,
		// so the presence-only check kept passing while every record was
		// quietly discarded - not caught until the very end).
		let bytesSoFar = 0;
		for (let i = 0; i < hexLines.length; i++) {
			const line = hexLines[i] + '\r\n';
			this._onActivity.fire(`Sending Intel HEX record ${i + 1}/${hexLines.length}${i > 0 ? ' (append)' : ''}…`);
			if (!await this.pipReceiveLine(home, hexFileName, line, i > 0)) {
				this._onActivity.fire(`Record ${i + 1}/${hexLines.length} transfer could not be verified - leaving ${hexFileName} in place for inspection`);
				return false;
			}

			bytesSoFar += line.length;
			// Verify at record 1 (confirms plain create works) and again at
			// record 3 (confirms [A] append is actually accumulating, not
			// silently overwriting) - three ~45-byte records is enough to
			// cross the 128-byte record boundary, so a broken append (each
			// call landing 1 record regardless) reads differently from a
			// working one (2 records by then). Checking only at record 1
			// wouldn't catch that: one or two small records both still fit
			// in a single 128-byte record, so a no-op append would look
			// identical to a working one until enough data piles up. Not
			// checked on every record - fast, just enough to fail within a
			// few seconds instead of after sending everything (as happened
			// with multi-source concatenation). The full transfer still
			// gets one thorough check below.
			if (i === 0 || i === 2) {
				const expectedSoFar = Math.ceil(bytesSoFar / 128);
				if (!await this.waitForExpectedFileSize(home, hexFileName, expectedSoFar, 3, 400)) {
					this._onActivity.fire(
						`${hexFileName} didn't grow as expected after record ${i + 1} - ` +
						`PIP's [A] append may not be supported on this device - leaving it in place for inspection`
					);
					return false;
				}
			}
		}

		// A DIR match right after the transfer's prompt reappears isn't solid
		// proof the file is genuinely done landing on disk (see LOAD's error
		// below, which this hardware has been seen to hit despite exactly
		// that check passing moments earlier) - confirm its actual size
		// against what was sent before trusting it enough to hand to LOAD.
		const expectedRecords = Math.ceil(bytesSoFar / 128);
		if (!await this.waitForExpectedFileSize(home, hexFileName, expectedRecords)) {
			this._onActivity.fire(`${hexFileName} transfer could not be verified - leaving it in place for inspection`);
			return false;
		}

		return await this.runLoadForRemoteCcp(hexFileName, 'via Intel HEX');
	}

	/**
	 * Runs `LOAD REMOTCCP` to convert an already-verified REMOTCCP.HEX into
	 * REMOTCCP.COM. Checks LOAD's own response for an error rather than
	 * trusting a bare "DIR shows the name" check afterward - on at least one
	 * BIOS, LOAD creates/truncates its output .COM before it even tries to
	 * open the source .HEX, so a failed conversion still leaves an empty
	 * REMOTCCP.COM behind that a presence-only check can't tell apart from a
	 * real install (this is exactly what produced garbled Remote CCP output
	 * and LOAD's own error resurfacing when REMOTCCP was run by hand
	 * afterward - CCP jumping into a near-empty .COM ends up executing
	 * whatever LOAD.COM itself left behind in memory). Not erasing
	 * REMOTCCP.HEX here, even on success - temporary, so a device that
	 * misbehaves can still be inspected by hand afterward; re-add cleanup
	 * once this hardware's RDR: quirks are actually sorted out. Must be
	 * called from within withExclusiveAccess.
	 */
	private async runLoadForRemoteCcp(hexFileName: string, via: string): Promise<boolean> {
		const home = this.remoteCcpHomeDrive();
		this._onActivity.fire(`Converting ${hexFileName} to ${REMOTE_CCP_FILENAME} with LOAD…`);
		const loadStart = this.inputBuffer.length;
		this.writeRaw(`LOAD ${home}:REMOTCCP\r`);
		await this.waitForPrompt(loadStart, 15000);
		await this.waitForIdle(500, 5000);

		const loadResponse = this.inputBuffer.slice(loadStart);
		if (/error/i.test(loadResponse)) {
			this._onActivity.fire(`LOAD reported an error converting ${hexFileName}: ${loadResponse.trim()} - leaving it in place for inspection`);
			return false;
		}

		const installed = await this.hasFileOnDrive(home, REMOTE_CCP_FILENAME);
		this._onActivity.fire(installed
			? `${REMOTE_CCP_FILENAME} installed on ${home}: ${via}`
			: `LOAD did not produce ${REMOTE_CCP_FILENAME}`);
		return installed;
	}

	/**
	 * Receives `line` into `fileName` on `drive` via a single short PIP/RDR:
	 * session - a fresh file (`append` false, PIP's F_DELETE+F_MAKE) or
	 * appended onto an existing one (`append` true, PIP's `[A]` parameter).
	 * Used one Intel HEX record at a time by installRemoteCcpViaHex rather
	 * than one PIP call for the whole file - see that method's comment for
	 * why. Must be called from within withExclusiveAccess.
	 */
	private async pipReceiveLine(drive: string, fileName: string, line: string, append: boolean): Promise<boolean> {
		this.writeRaw(`PIP ${drive}:${fileName}=RDR:${append ? '[A]' : ''}\r`);
		// Give the CCP a moment to load and launch PIP before streaming.
		await new Promise(resolve => setTimeout(resolve, 300));

		const start = this.inputBuffer.length;
		this.writeRaw(line);
		this.writeRaw(Buffer.from([0x1a]));

		const sent = await this.waitForPrompt(start, 10000);
		// Even a single small record has shown some trailing echo/replay on
		// this hardware - settle before trusting it's actually done, just
		// with a far smaller budget than the whole-file transfer needed
		// (see installRemoteCcpViaHex), since there's far less to replay.
		await this.waitForIdle(500, 8000);
		return sent && await this.hasFileOnDrive(drive, fileName);
	}

	/**
	 * SLIDE.COM must already be on A:, and the device/connection must
	 * actually support it (microBeast, 19,200 baud - see
	 * slideComUnavailableReason()), for the Slide-based install path.
	 */
	private async canInstallRemoteCcpViaSlide(): Promise<boolean> {
		if (this.slideComUnavailableReason()) {
			return false;
		}
		return await this.hasFileOnDrive('A', 'SLIDE.COM');
	}

	/**
	 * Installs REMOTCCP.COM onto its home drive via SLIDE.COM's
	 * windowed/CRC16 transfer protocol - see bootstrapRemoteCcp's comment for
	 * why this is tried first on microBeast. Requires
	 * canInstallRemoteCcpViaSlide() to have already confirmed SLIDE.COM's
	 * prerequisites. Must be called from within withExclusiveAccess.
	 */
	private async installRemoteCcpViaSlide(): Promise<boolean> {
		const comPath = this.context.asAbsolutePath(path.join('remote', 'remotccp.com'));
		if (!fs.existsSync(comPath)) {
			this._onActivity.fire(`Remote CCP install failed: couldn't find bundled ${REMOTE_CCP_FILENAME}`);
			return false;
		}

		const home = this.remoteCcpHomeDrive();
		// SLIDE.COM only ever runs from A: - launched via an explicit
		// "A:SLIDE" so the CCP finds it there regardless of which drive is
		// current, while `home` stays selected as current so the file it
		// receives lands there.
		await this.selectDrive(home);
		this._onActivity.fire(`Sending ${REMOTE_CCP_FILENAME} via SLIDE…`);
		this.writeRaw('A:SLIDE\r');
		// Give the CCP a moment to load and launch SLIDE.COM, and wait for
		// whatever it prints in response, before starting Slide's own
		// RDY/RDY handshake - same as sendOneFileVia's SLIDE.COM branch.
		await this.waitForIdle(300, 3000);

		try {
			const session = new SerialSession(this.getSerialLink());
			await sendFiles(session, [comPath], this.traceEnabled());
		} catch (error) {
			this._onActivity.fire(`SLIDE send failed: ${error instanceof Error ? error.message : error} - leaving any partial ${REMOTE_CCP_FILENAME} in place for inspection`);
			return false;
		}

		const installed = await this.hasFileOnDrive(home, REMOTE_CCP_FILENAME);
		this._onActivity.fire(installed
			? `${REMOTE_CCP_FILENAME} installed on ${home}: via SLIDE`
			: `SLIDE send completed but ${REMOTE_CCP_FILENAME} could not be verified`);
		return installed;
	}

	/** XMODEM.COM must already be on A: for the XMODEM-based install path. */
	private async canInstallRemoteCcpViaXmodem(): Promise<boolean> {
		return await this.hasFileOnDrive('A', 'XMODEM.COM');
	}

	/**
	 * Installs REMOTCCP.COM onto A: via XMODEM instead of PIP or ED. Unlike
	 * every other install path in this file, XMODEM's own block-level
	 * checksums and ACK/NAK retries are specifically designed to cope with
	 * an unreliable link, rather than this code having to work around
	 * hardware quirks after the fact - tried first for exactly that reason.
	 * Requires canInstallRemoteCcpViaXmodem() to have already confirmed
	 * XMODEM.COM is present. Must be called from within withExclusiveAccess.
	 */
	private async installRemoteCcpViaXmodem(): Promise<boolean> {
		const comPath = this.context.asAbsolutePath(path.join('remote', 'remotccp.com'));
		let fileContent: Buffer;
		try {
			fileContent = fs.readFileSync(comPath);
		} catch (error) {
			this._onActivity.fire(`Remote CCP install failed: couldn't read bundled ${REMOTE_CCP_FILENAME}`);
			return false;
		}

		// Unlike the PIP/ED paths below, this project's XMODEM.COM has no
		// drive-qualified destination argument - it always writes to
		// whichever drive is current. So when the home drive isn't A: (only
		// microBeast), XMODEM.COM itself has to be staged there first (via
		// the same ensure/copy-from-A pattern regular transfers use) before
		// selecting it as current and running the receive.
		const home = this.remoteCcpHomeDrive();
		if (home !== 'A' && !await this.ensureXModemOnDrive(home)) {
			this._onActivity.fire(`Could not stage XMODEM.COM on ${home}: for the Remote CCP install`);
			return false;
		}

		await this.selectDrive(home);
		this._onActivity.fire(`Sending ${REMOTE_CCP_FILENAME} via XMODEM…`);
		// No /F here (unlike the regular file-transfer path) - this only
		// ever runs when REMOTCCP.COM is confirmed missing (see
		// ensureRemoteCcpOnDrive), so there's nothing to overwrite and no
		// "Overwrite (Y/N)?" prompt to skip. /X0 forces CON: instead of
		// XMODEM.COM's default RDR:/PUN: - see sendOneFileVia()'s XMODEM.COM
		// branch for why that default causes an instant "Sync fail" on
		// boards where those aren't mapped to this same serial port.
		this.writeRaw(`XMODEM ${REMOTE_CCP_FILENAME} /R /X0\r`);
		// No fixed delay before listening either - same reasoning as
		// sendOneFileVia(): the device's own sync byte and abort timeout
		// would otherwise race whenever this side starts listening.

		try {
			await this.xmodem.send(this.getSerialLink(), fileContent, REMOTE_CCP_FILENAME);
		} catch (error) {
			this._onActivity.fire(`XMODEM send failed: ${error instanceof Error ? error.message : error} - leaving any partial ${REMOTE_CCP_FILENAME} in place for inspection`);
			return false;
		}

		const installed = await this.hasFileOnDrive(home, REMOTE_CCP_FILENAME);
		this._onActivity.fire(installed
			? `${REMOTE_CCP_FILENAME} installed on ${home}: via XMODEM`
			: `XMODEM send completed but ${REMOTE_CCP_FILENAME} could not be verified`);
		return installed;
	}

	/** ED.COM and LOAD.COM must both already be on A: for the ED-based install path. */
	private async canInstallRemoteCcpViaEd(): Promise<boolean> {
		return await this.hasFileOnDrive('A', 'ED.COM') && await this.hasFileOnDrive('A', 'LOAD.COM');
	}

	/**
	 * Installs REMOTCCP.COM onto A: by typing the Intel HEX text straight
	 * into ED.COM's line editor and saving, instead of transferring it via
	 * PIP. Requires canInstallRemoteCcpViaEd() to have already confirmed
	 * ED.COM is present. Must be called from within withExclusiveAccess.
	 *
	 * ED never touches RDR: - inserting text goes through the console, the
	 * same path DIR/STAT/LOAD/etc. use reliably throughout this file - so
	 * this sidesteps the whole class of RDR:-specific problems the PIP-based
	 * paths have hit, rather than working around any one of them. Untested
	 * against real hardware; ED's command syntax below follows the standard
	 * DR CP/M 2.2 ED specification (`I` to insert, a line starting with
	 * Ctrl-Z to end insert mode, `E` to save and exit) - a third-party ED
	 * clone could differ.
	 */
	private async installRemoteCcpViaEd(): Promise<boolean> {
		const comPath = this.context.asAbsolutePath(path.join('remote', 'remotccp.com'));
		let fileContent: Buffer;
		try {
			fileContent = fs.readFileSync(comPath);
		} catch (error) {
			this._onActivity.fire(`Remote CCP install failed: couldn't read bundled ${REMOTE_CCP_FILENAME}`);
			return false;
		}

		const hexFileName = 'REMOTCCP.HEX';
		const hexLines = toIntelHex(fileContent).split('\r\n').filter(Boolean);
		const home = this.remoteCcpHomeDrive();

		// ED.COM/LOAD.COM are looked up on A: (canInstallRemoteCcpViaEd) -
		// current drive stays A: throughout so the CCP can find them; the
		// destination drive (A: normally, C: for microBeast) is qualified
		// explicitly in ED's own filename arguments below instead.
		await this.selectDrive('A');

		// Clear any stale REMOTCCP.HEX left by an earlier failed attempt
		// first, so ED opens it as a genuinely NEW FILE rather than editing
		// whatever's already there - unlike leaving a failed attempt's own
		// files in place for inspection, this is just making sure a new
		// attempt starts from a clean slate.
		this.writeRaw(`ERA ${home}:${hexFileName}\r`);
		await this.waitForIdle(300, 3000);

		this._onActivity.fire(`Starting ED to insert ${hexFileName}…`);
		const edStart = this.inputBuffer.length;
		this.writeRaw(`ED ${home}:${hexFileName}\r`);
		// ED doesn't print the CCP's "X>" drive prompt while it's running,
		// so there's no pattern to wait for here - settle instead. Loading
		// ED.COM itself is real disk I/O, which this hardware has shown can
		// take a good while (see selectDrive's own comment on the same
		// point), hence the generous cap.
		await this.waitForIdle(500, 8000);

		this._onActivity.fire(`Inserting ${hexLines.length} Intel HEX records…`);
		this.writeRaw('I\r');
		await this.waitForIdle(300, 3000);

		this.writeRaw(hexLines.map(line => line + '\r').join(''));
		// A line starting with Ctrl-Z ends ED's insert mode.
		this.writeRaw(Buffer.from([0x1a]));
		// Still inside ED (Ctrl-Z returns to its own "*" command mode, not
		// the CCP) so there's no prompt to wait for yet either - this has
		// been observed taking several seconds just to finish echoing back
		// what was inserted, well before whatever real work ED itself still
		// has left to do with it, hence the large cap. The gap BETWEEN
		// individual echoed lines has also been observed exceeding 1.5s
		// even mid-transfer (not just at the very end) - too short an idle
		// threshold here declares "done" after 3-4 of ~70 lines, sending E
		// while ED is still in insert mode, where it lands as bogus
		// inserted text instead of the exit command and everything after
		// hangs waiting for a prompt that's never coming. 5s comfortably
		// clears the observed gap.
		await this.waitForIdle(5000, 60000);

		this._onActivity.fire(`Saving ${hexFileName} and exiting ED…`);
		const saveStart = this.inputBuffer.length;
		this.writeRaw('E\r');
		// Unlike the steps above, E ends the ED session and returns control
		// to the CCP - which does print its "X>" prompt, so this is the one
		// place in this whole method a real prompt-wait applies. Writing
		// the file out is real disk I/O (rewriting the whole thing, not an
		// incremental append), and every other disk-I/O step on this
		// hardware has needed a generous budget to avoid moving on to LOAD
		// before the save has actually finished - so this one gets the
		// largest budget in the method.
		const saved = await this.waitForPrompt(saveStart, 60000);
		await this.waitForIdle(500, 10000);
		if (!saved) {
			// E never actually returned to the CCP - most likely it landed as
			// bogus inserted text instead of the exit command (e.g. sent
			// while ED was still mid-insert-echo), leaving ED still running.
			// Failing here immediately matters: falling through anyway would
			// still attempt LOAD next, which would also hang and eventually
			// time out on its own - needlessly doubling the time before this
			// method reports failure and the caller can fall back to the
			// next install method.
			this._onActivity.fire(`ED never returned to the CCP after E - leaving ${hexFileName} in place for inspection`);
			return false;
		}

		const edResponse = this.inputBuffer.slice(edStart);
		if (/error/i.test(edResponse)) {
			this._onActivity.fire(`ED reported an error: ${edResponse.trim()} - leaving ${hexFileName} in place for inspection`);
			return false;
		}

		// No pre-LOAD size check here (unlike the PIP-based hex path) - a
		// manual test confirmed ED's save is trustworthy once E's own
		// prompt has returned (TYPE showed the file byte-for-byte correct),
		// while the STAT-based size check was the one thing that produced a
		// false failure on that same run: it never even got to LOAD despite
		// the file already being fine, almost certainly the same echo-lag
		// timing fragility seen everywhere else on this hardware, just
		// tripping up the verification instead of the transfer this time.
		// LOAD's own response is a clean enough success/failure signal on
		// its own (see runLoadForRemoteCcp).
		return await this.runLoadForRemoteCcp(hexFileName, 'via ED');
	}

	/**
	 * Sends the raw PIP command that puts A: into "receive REMOTCCP.COM over
	 * the serial line" mode - the first half of the install handshake. Split
	 * out from bootstrapRemoteCcp so the terminal's manual "Send REMOTCCP"
	 * dialog can trigger each half independently (e.g. to retry after a
	 * declined/failed auto-install, or to watch the handshake step by step).
	 * Must be called from within withExclusiveAccess.
	 */
	private async sendRemoteCcpPipReceiveCommand(): Promise<void> {
		const home = this.remoteCcpHomeDrive();
		this._onActivity.fire(`Sending PIP command to receive ${REMOTE_CCP_FILENAME} on ${home}:…`);
		await this.selectDrive('A');
		this.writeRaw(`PIP ${home}:${REMOTE_CCP_FILENAME}=CON:[O]\r`);
	}

	/**
	 * Streams the bundled REMOTCCP.COM's bytes raw over the serial line, for
	 * a PIP receive already started (see sendRemoteCcpPipReceiveCommand) to
	 * pick up. Second half of the install handshake, split out for the same
	 * reason. Must be called from within withExclusiveAccess.
	 */
	private async streamRemoteCcpFileRaw(): Promise<boolean> {
		const comPath = this.context.asAbsolutePath(path.join('remote', 'remotccp.com'));
		let fileContent: Buffer;
		try {
			fileContent = fs.readFileSync(comPath);
		} catch (error) {
			this._onActivity.fire(`Remote CCP send failed: couldn't read bundled ${REMOTE_CCP_FILENAME}`);
			return false;
		}

		this._onActivity.fire(`Sending ${REMOTE_CCP_FILENAME} (${fileContent.length} bytes) raw…`);
		const start = this.inputBuffer.length;
		// Paced byte-by-byte (writeRawPaced's defaults: 3ms/char, 50ms after
		// each line) rather than one unbroken write - this raw-PIP path is
		// already the least reliable of Remote CCP's install methods (see
		// bootstrapRemoteCcp), and giving PIP time to actually keep up with
		// each byte (and extra time at each line boundary) has proven more
		// likely to land intact than blasting the whole file at once.
		await this.writeRawPaced(fileContent);
		// Trailing sentinel: harmless whether or not [O] mode needs it, and
		// the only signal available if it turns out RDR: has no EOF of its
		// own for PIP to detect completion from.
		this.writeRaw(Buffer.from([0x1a]));

		const finished = await this.waitForPrompt(start, 30000);
		// See installRemoteCcpViaHex's matching comment: the prompt
		// reappearing doesn't mean the line is free yet - this hardware
		// replays the whole transfer back as fake keystrokes afterward, and
		// that can run well past 10s, so this budget needs real margin.
		await this.waitForIdle(1500, 45000);
		if (!finished) {
			this._onActivity.fire('Remote CCP send timed out waiting for PIP to finish');
			return false;
		}

		const home = this.remoteCcpHomeDrive();
		const installed = await this.hasFileOnDrive(home, REMOTE_CCP_FILENAME);
		this._onActivity.fire(installed
			? `${REMOTE_CCP_FILENAME} installed on ${home}:`
			: `${REMOTE_CCP_FILENAME} install could not be verified`);
		return installed;
	}

	/**
	 * Confirms `fileName` on `drive` has actually reached `expectedRecords`
	 * 128-byte records, retrying for a few seconds rather than trusting a
	 * single check right after the transfer's prompt reappears (see the
	 * caller for why that alone isn't solid proof on this hardware).
	 *
	 * Uses STAT.COM's exact "Recs" column when it's present - the CP/M 2.2
	 * standard STAT report format ("Recs  Bytes  Ext Acc" with Recs as the
	 * leftmost, exact-count field) is stable enough across DR-derived
	 * implementations to parse safely. Without STAT.COM, falls back to
	 * requiring the plain DIR-based presence check (hasFileOnDrive) to
	 * succeed twice in a row - not an exact size, but still meaningfully
	 * more than a single point-in-time check.
	 */
	private async waitForExpectedFileSize(
		drive: string, fileName: string, expectedRecords: number, attempts = 6, delayMs = 500
	): Promise<boolean> {
		const haveStat = await this.hasFileOnDrive(drive, 'STAT.COM');
		let lastSeen = false;

		for (let i = 0; i < attempts; i++) {
			if (haveStat) {
				await this.selectDrive(drive);
				const start = this.inputBuffer.length;
				this.writeRaw(`STAT ${drive}:${fileName}\r`);
				await this.waitForPrompt(start, 8000);
				await this.waitForIdle(300, 3000);
				const response = this.inputBuffer.slice(start);
				const line = response.split(/\r?\n/).find(l => new RegExp(fileName.replace('.', '\\.'), 'i').test(l));
				const recs = line?.match(/(\d+)/)?.[1];
				if (recs !== undefined && parseInt(recs, 10) === expectedRecords) {
					return true;
				}
			} else {
				const seen = await this.hasFileOnDrive(drive, fileName);
				if (seen && lastSeen) {
					return true;
				}
				lastSeen = seen;
			}
			await new Promise(resolve => setTimeout(resolve, delayMs));
		}
		return false;
	}

	/**
	 * Manually triggers a Remote CCP install attempt using whichever install
	 * method matches the currently selected cpmIde.transferApplication
	 * (XMODEM.COM -> installRemoteCcpViaXmodem, SLIDE.COM ->
	 * installRemoteCcpViaSlide) - the terminal's "Send REMOTCCP" action tries
	 * this first, falling back to the manual PIP-command dialog only if it
	 * returns false (the selected application has no install path of its
	 * own, its prerequisites aren't met, or the attempt itself failed).
	 */
	async sendRemoteCcpViaSelectedTransferApplication(): Promise<boolean> {
		if (!this.port?.isOpen) {
			throw new Error('Serial port not connected');
		}
		return await this.withExclusiveAccess('Trying Remote CCP install via the selected transfer application…', async () => {
			const app = this.getTransferApplication();
			if (app === 'XMODEM.COM' && await this.canInstallRemoteCcpViaXmodem()) {
				return await this.installRemoteCcpViaXmodem();
			}
			if (app === 'SLIDE.COM' && await this.canInstallRemoteCcpViaSlide()) {
				return await this.installRemoteCcpViaSlide();
			}
			return false;
		});
	}

	/** Manually sends just the PIP receive command - the terminal's "Send PIP command" action. */
	async sendRemoteCcpPipCommand(): Promise<void> {
		if (!this.port?.isOpen) {
			throw new Error('Serial port not connected');
		}
		await this.withExclusiveAccess('Sending PIP command for Remote CCP…', async () => {
			await this.sendRemoteCcpPipReceiveCommand();
		});
	}

	/**
	 * Manually streams REMOTCCP.COM's bytes raw - the terminal's "SEND
	 * RemotCCP" action, for a PIP receive already started (typically via
	 * sendRemoteCcpPipCommand).
	 */
	async sendRemoteCcpRaw(): Promise<boolean> {
		if (!this.port?.isOpen) {
			throw new Error('Serial port not connected');
		}
		return await this.withExclusiveAccess('Sending REMOTCCP.COM raw…', async () => {
			return await this.streamRemoteCcpFileRaw();
		});
	}

	/**
	 * Launches an already-present REMOTCCP.COM on `drive` and waits for its
	 * startup version byte. Returns undefined if it can't be confirmed
	 * running (missing/declined install, or no response) rather than
	 * throwing, so callers fall back to their CCP-command/XMODEM path.
	 */
	private async launchRemoteCcp(drive: string): Promise<RemoteCcpClient | undefined> {
		if (!await this.ensureRemoteCcpOnDrive(drive)) {
			return undefined;
		}

		await this.selectDrive(drive);
		// Constructed - and its onData subscription attached - before the
		// launch command is even sent, so it's listening from the very
		// first byte back (the echo itself). An earlier version of this
		// code sent the command first and only started listening once a
		// separate wait-for-idle gate saw 300ms of quiet, on the theory
		// that echo/CRLF chatter needed time to settle before the version
		// byte could safely be told apart from it. In practice that gate
		// ran on SerialTerminal's own inputBuffer/lastDataTime tracking,
		// completely independent of this client's onData - so whenever the
		// real version byte happened to arrive while that gate was still
		// mid-wait (well within its 300ms window, e.g. right after a fast
		// disk load), it was consumed by SerialTerminal's general handling
		// and never reached this client at all: waitForStartup() below then
		// waited out its full budget for a byte that had already come and
		// gone, and this fell back to the legacy CCP-command path even
		// though Remote CCP was running fine.
		const client = new RemoteCcpClient(this.getSerialLink());
		// No ".COM" here - the CCP appends that itself when it searches for
		// a command, and typing it explicitly makes most CCPs fail to find
		// the match at all (reported as "REMOTCCP.COM?", CP/M's unknown-
		// command error) rather than just being harmlessly redundant.
		const command = `${REMOTE_CCP_COMMAND}\r`;
		this.writeRaw(command);

		try {
			// The character-echo of `command` itself is entirely predictable
			// (it's listening from before the command was even sent, so
			// none of it can be missed) - everything after that up to the
			// version byte (the CCP's own trailing CR/LF before the .COM
			// actually starts running) is skipped dynamically by
			// waitForStartup() instead of assuming a fixed count, since not
			// every CCP prints the same number of bytes there.
			const versionByte = await client.waitForStartup(command.length, 40000);
			this.recordCpmVersion(versionByte);
			return client;
		} catch (error) {
			this._onActivity.fire(`Remote CCP didn't respond on ${drive}: (${error instanceof Error ? error.message : error}) - falling back to legacy method`);
			client.dispose();
			return undefined;
		}
	}

	private recordCpmVersion(versionByte: number): void {
		const version = `CP/M ${(versionByte >> 4) & 0xf}.${versionByte & 0xf}`;
		if (version !== this.cpmVersion) {
			this.cpmVersion = version;
			this._onCpmVersionDetected.fire(version);
		}
	}

	/**
	 * Runs `work` against a live Remote CCP session on `drive`: launches it
	 * (bootstrapping/propagating REMOTCCP.COM as needed), runs `work`, then
	 * quits back to the CCP. Returns undefined - instead of throwing - if
	 * Remote CCP isn't available at all (REMOTCCP.COM couldn't be
	 * found/installed on `drive`); callers that reach this because the user
	 * explicitly chose REMOTCCP.COM as their transfer application surface
	 * that as an error rather than silently trying something else. Every
	 * call re-checks REMOTCCP.COM's presence fresh (no "already known
	 * unavailable" caching) - now that transfer protocol is an explicit
	 * per-transfer choice rather than an implicit try-then-fall-back chain,
	 * a stale negative from some earlier attempt (e.g. while a different
	 * protocol was selected) must not keep blocking this one; a failure
	 * partway through `work` itself still throws normally. Must be called
	 * from within withExclusiveAccess.
	 */
	private async withRemoteCcp<T>(drive: string, work: (client: RemoteCcpClient) => Promise<T>): Promise<T | undefined> {
		const client = await this.launchRemoteCcp(drive);
		if (!client) {
			return undefined;
		}

		try {
			return await work(client);
		} finally {
			try {
				await client.quit();
			} catch (error) {
				// best-effort - withExclusiveAccess's drive-restore step
				// still gets the CCP back to a known prompt regardless.
			} finally {
				client.dispose();
			}
		}
	}

	/**
	 * Checks for a single file with a targeted `DIR <name>`, instead of
	 * pulling the drive's entire listing just to search it locally - a full
	 * `DIR` on a drive with many files is slow and puts a lot of unrelated
	 * traffic on the wire right before an XMODEM handshake.
	 */
	private async hasFileOnDrive(drive: string, fileName: string): Promise<boolean> {
		const normalizedTarget = fileName.toUpperCase();
		const [namePart, extPart] = normalizedTarget.split('.');
		if (!namePart || !extPart) {
			return false;
		}

		await this.selectDrive(drive);
		const start = this.inputBuffer.length;
		this.writeRaw(`DIR ${normalizedTarget}\r`);
		// A DIR that has to seek can pause mid-listing for longer than a
		// short idle window - waiting for the prompt itself first (like
		// selectDrive() does, for the same reason) avoids mistaking that
		// pause for completion and moving on to the next write while the
		// device is still busy and not reading its console, which drops
		// whatever gets typed next.
		await this.waitForPrompt(start, 8000);
		await this.waitForIdle(500, 3000);
		const response = this.inputBuffer.slice(start);

		// Restrict the match to listing-like lines to avoid a false positive
		// from the echoed "DIR XMODEM.COM" command line itself.
		const escapedName = namePart.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		const escapedExt = extPart.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		const listingLinePattern = new RegExp(
			`(?:^|\\r?\\n)\\s*(?:[0-9]+:)?(?:[A-P]:\\s*)?${escapedName}\\s+${escapedExt}(?:\\s|$)`,
			'i'
		);

		return listingLinePattern.test(response);
	}

	async transferFileFromDevice(fileName: string, drive: string, expectedSizeBytes?: number): Promise<boolean> {
		if (!this.port?.isOpen) {
			vscode.window.showErrorMessage('Serial port not connected');
			return false;
		}

		const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
		if (!workspaceFolder) {
			vscode.window.showErrorMessage('Open a workspace folder to receive the file into');
			return false;
		}

		const app = this.getTransferApplication();
		if (app === 'SLIDECPM.COM' || app === 'SLIDE.COM') {
			// Slide's receive side (src/slide-ts/recv.ts) only supports
			// accepting whatever the device decides to push, not requesting
			// one specific named file the way Remote CCP's FG/XMODEM's /S do
			// - there's no device-side SLIDECPM.COM/SLIDE.COM protocol support
			// for that in this codebase.
			vscode.window.showErrorMessage(
				'Slide download not yet implemented - choose REMOTCCP.COM or XMODEM.COM as the transfer application to receive files.'
			);
			return false;
		}

		// CP/M filenames are uppercase; the CCP doesn't case-fold what we send it.
		const remoteFileName = fileName.toUpperCase();
		const savePath = path.join(workspaceFolder.uri.fsPath, fileName);
		if (fs.existsSync(savePath)) {
			const choice = await vscode.window.showWarningMessage(
				`${fileName} already exists in the workspace. Overwrite it?`,
				{ modal: true },
				'Overwrite'
			);
			if (choice !== 'Overwrite') {
				return false;
			}
		}

		try {
			await this.transferQueue.enqueue(fileName, 'receive', expectedSizeBytes ?? 0, (onProgress, isCancelled) =>
				this.withExclusiveAccess(`Receiving ${fileName} from device via ${app}…`, async () => {
					if (app === 'XMODEM.COM') {
						if (!await this.ensureXModemOnDrive(drive)) {
							throw new Error(
								`XMODEM.COM not found on drive ${drive}: and no copy available on A: - ` +
								`install it on the device first`
							);
						}

						// ensureXModemOnDrive() leaves `drive` selected as the CCP's
						// current drive. /X0 forces CON: instead of XMODEM.COM's
						// default RDR:/PUN: - see sendOneFileVia()'s XMODEM.COM
						// branch for why that default causes an instant "Sync
						// fail" on boards where those aren't mapped to this same
						// serial port.
						this.writeRaw(`XMODEM ${remoteFileName} /S /X0\r`);
						// No fixed delay before starting the receive handshake -
						// XModem.receive() sends the initial NAK itself, repeatedly,
						// for up to 60s (see its own comment), which already covers
						// however long the CCP takes to load and launch XMODEM.COM.
						// A delay here just means this side isn't sending that NAK
						// yet while the device-side XMODEM.COM (in send mode) is
						// already waiting for one and may give up first.

						// XModem.receive() already strips the trailing CTRL-Z padding
						// XMODEM uses to fill out the last block - no further trimming
						// needed (or correct: this used to search for NUL, the wrong
						// pad byte, with slice math that could zero out the whole
						// buffer whenever a stray 0x00 happened to appear near the end).
						const fileContent = await this.xmodem.receive(this.getSerialLink(), remoteFileName, onProgress, isCancelled);
						fs.writeFileSync(savePath, fileContent);
						return;
					}

					// REMOTCCP.COM (default) - launchRemoteCcp() already
					// checks/bootstraps REMOTCCP.COM's presence on `drive`.
					const received = await this.withRemoteCcp(drive, async (client) => {
						const fileContent = await client.getFile(remoteFileName, onProgress, isCancelled);
						fs.writeFileSync(savePath, fileContent);
						return true;
					});
					if (!received) {
						throw new Error(`Could not start a Remote CCP session on drive ${drive}:`);
					}
				})
			);
			this._onActivity.fire(`Received ${fileName}`);
			vscode.window.showInformationMessage(`File ${fileName} received from device`);
			return true;
		} catch (error) {
			if (error instanceof TransferCancelledError || error instanceof ConnectionResetError || !this.port?.isOpen) {
				this._onActivity.fire(`Cancelled: ${fileName}`);
				return false;
			}
			this._onActivity.fire(`Failed to receive ${fileName}`);
			vscode.window.showErrorMessage(`Transfer failed: ${error}`);
			return false;
		}
	}

	/**
	 * Downloads multiple files, grouped by drive (a multi-select in the
	 * CP/M Files tree can span drives - each folder there is one drive).
	 * REMOTCCP.COM shares one session per drive-group (one launch, one queue
	 * row with aggregate progress) instead of relaunching per file; XMODEM.COM
	 * and a lone file in a group fall back to transferFileFromDevice() one at
	 * a time.
	 */
	async receiveFilesFromDevice(files: { fileName: string; drive: string; sizeBytes?: number }[]): Promise<boolean> {
		if (!this.port?.isOpen) {
			vscode.window.showErrorMessage('Serial port not connected');
			return false;
		}
		if (files.length === 0) {
			return false;
		}
		if (files.length === 1) {
			return this.transferFileFromDevice(files[0].fileName, files[0].drive, files[0].sizeBytes);
		}

		const app = this.getTransferApplication();
		if (app === 'SLIDECPM.COM' || app === 'SLIDE.COM') {
			vscode.window.showErrorMessage(
				'Slide download not yet implemented - choose REMOTCCP.COM or XMODEM.COM as the transfer application to receive files.'
			);
			return false;
		}

		const byDrive = new Map<string, typeof files>();
		for (const f of files) {
			const group = byDrive.get(f.drive) ?? [];
			group.push(f);
			byDrive.set(f.drive, group);
		}

		let allOk = true;
		for (const [drive, group] of byDrive) {
			if (app === 'REMOTCCP.COM' && group.length > 1) {
				if (!await this.receiveFileBatchViaRemoteCcp(group, drive)) {
					allOk = false;
				}
				continue;
			}
			for (const f of group) {
				if (!await this.transferFileFromDevice(f.fileName, f.drive, f.sizeBytes)) {
					allOk = false;
				}
			}
		}
		return allOk;
	}

	/**
	 * Downloads multiple files from `drive` through one shared Remote CCP
	 * session (one launch/quit, one queue row with aggregate progress)
	 * instead of relaunching REMOTCCP.COM per file.
	 */
	private async receiveFileBatchViaRemoteCcp(
		files: { fileName: string; drive: string; sizeBytes?: number }[],
		drive: string
	): Promise<boolean> {
		const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
		if (!workspaceFolder) {
			vscode.window.showErrorMessage('Open a workspace folder to receive files into');
			return false;
		}

		// Ask about each overwrite up front, rather than partway through a
		// shared session.
		const toFetch: typeof files = [];
		for (const f of files) {
			const savePath = path.join(workspaceFolder.uri.fsPath, f.fileName);
			if (fs.existsSync(savePath)) {
				const choice = await vscode.window.showWarningMessage(
					`${f.fileName} already exists in the workspace. Overwrite it?`,
					{ modal: true },
					'Overwrite'
				);
				if (choice !== 'Overwrite') {
					continue;
				}
			}
			toFetch.push(f);
		}
		if (toFetch.length === 0) {
			return false;
		}

		const queueName = `${toFetch.length} files`;
		const totalBytes = toFetch.reduce((sum, f) => sum + (f.sizeBytes ?? 0), 0);

		try {
			await this.transferQueue.enqueue(queueName, 'receive', totalBytes, (onProgress, isCancelled) =>
				this.withExclusiveAccess(`Receiving ${queueName} from ${drive}: via REMOTCCP.COM…`, async () => {
					const received = await this.withRemoteCcp(drive, async (client) => {
						let bytesDoneInEarlierFiles = 0;
						for (const f of toFetch) {
							const remoteFileName = f.fileName.toUpperCase();
							const savePath = path.join(workspaceFolder.uri.fsPath, f.fileName);
							const fileContent = await client.getFile(
								remoteFileName,
								(bytesInFile) => onProgress(bytesDoneInEarlierFiles + bytesInFile),
								isCancelled
							);
							fs.writeFileSync(savePath, fileContent);
							bytesDoneInEarlierFiles += f.sizeBytes ?? fileContent.length;
						}
						return true;
					});
					if (!received) {
						throw new Error(`Could not start a Remote CCP session on drive ${drive}:`);
					}
				})
			);
			this._onActivity.fire(`Received ${toFetch.length} file(s) from ${drive}:`);
			vscode.window.showInformationMessage(`Received ${toFetch.length} file(s) from ${drive}:`);
			return true;
		} catch (error) {
			if (error instanceof TransferCancelledError || error instanceof ConnectionResetError || !this.port?.isOpen) {
				this._onActivity.fire(`Cancelled: ${queueName}`);
				return false;
			}
			this._onActivity.fire('Receive failed');
			vscode.window.showErrorMessage(`Receive failed: ${error}`);
			return false;
		}
	}

	async receiveFileManualXmodem(savePath: string): Promise<boolean> {
		if (!this.port?.isOpen) {
			vscode.window.showErrorMessage('Serial port not connected');
			return false;
		}

		const targetName = path.basename(savePath);

		try {
			await this.withExclusiveAccess(`Waiting for manual XMODEM send into ${targetName}…`, async () => {
				const fileContent = await this.xmodem.receive(this.getSerialLink(), targetName);
				fs.writeFileSync(savePath, fileContent);
			});

			this._onActivity.fire(`Received ${targetName} (manual)`);
			vscode.window.showInformationMessage(`Manual XMODEM receive complete: ${targetName}`);
			return true;
		} catch (error) {
			this._onActivity.fire(`Manual receive failed for ${targetName}`);
			vscode.window.showErrorMessage(`Manual XMODEM receive failed: ${error}`);
			return false;
		}
	}

	/**
	 * Sends `localFilePath` over XMODEM without driving the CCP at all - no
	 * drive select, no XMODEM.COM lookup/copy, no launch command. Assumes the
	 * user has already started `XMODEM <file> /R /X0` themselves at the CP/M
	 * console, sidestepping the automated flow's drive-select/launch traffic
	 * (see transferFileToDevice) for devices where that traffic is unreliable.
	 */
	async sendFileManualXmodem(localFilePath: string): Promise<void> {
		if (!this.port?.isOpen) {
			vscode.window.showErrorMessage('Serial port not connected');
			return;
		}

		const fileName = path.basename(localFilePath);
		// CP/M filenames are uppercase; the CCP doesn't case-fold what we send it.
		const remoteFileName = fileName.toUpperCase();
		const fileContent = fs.readFileSync(localFilePath);

		try {
			await this.withExclusiveAccess(`Waiting to send ${fileName} (manual XMODEM)…`, async () => {
				await this.xmodem.send(this.getSerialLink(), fileContent, remoteFileName);
			});

			this._onActivity.fire(`Sent ${fileName} (manual)`);
			vscode.window.showInformationMessage(`Manual XMODEM send complete: ${fileName}`);
		} catch (error) {
			this._onActivity.fire(`Manual send failed for ${fileName}`);
			vscode.window.showErrorMessage(`Manual XMODEM send failed: ${error}`);
		}
	}

	/**
	 * Probes drives A-P by selecting each one and checking for a prompt in
	 * response. Must be called from within `withExclusiveAccess` so these
	 * probe commands don't interleave with interactive typing.
	 */
	async scanDrives(): Promise<string[]> {
		const drives: string[] = [];

		if (!this.port?.isOpen) {
			return drives;
		}

		const deviceType = getDeviceType();
		if (deviceType === 'microBeast') {
			return ['A','B'];
		}

		this._onActivity.fire('Resyncing console…');
		await this.resyncConsole();

		// Test the drive we're already sitting on before hopping around A-P -
		// it's the one the user actually cares about, and confirming it up
		// front means we know it's genuinely still good when we return to it
		// afterward, rather than just assuming 16 drive switches didn't
		// leave the CCP somewhere unexpected.
		const startingDrive = this.currentDrive;
		if (startingDrive) {
			this._onActivity.fire(`Testing current drive ${startingDrive}:…`);
			if (await this.selectDrive(startingDrive)) {
				drives.push(startingDrive);
				this._onActivity.fire(`Found drive ${startingDrive}:`);
			}
		}

		this._onActivity.fire('Scanning drives A-P…');
		for (let i = 0; i < 16; i++) {
			const driveLetter = String.fromCharCode(65 + i); // A-P
			if (driveLetter === startingDrive) {
				continue; // already tested above
			}
			try {
				// selectDrive() waits for the actual "X>" prompt rather than
				// a quiet gap - some hardware takes seconds to mount/seek a
				// drive, and a quiet-gap heuristic mistakes the near-instant
				// echo of the typed command for completion, moving on to the
				// next drive while this one's real response is still pending
				// (which then arrives late and gets misattributed, making
				// drives appear to be skipped).
				if (await this.selectDrive(driveLetter)) {
					drives.push(driveLetter);
					this._onActivity.fire(`Found drive ${driveLetter}:`);
				}
			} catch (error) {
				// The connection was reset out from under this scan - stop
				// entirely rather than ploughing through the remaining
				// drives against a connection that's gone (or, worse, a
				// freshly-reopened one this scan was never meant to touch).
				if (error instanceof ConnectionResetError || !this.port?.isOpen) {
					throw error;
				}
				// Any other error just means this one drive doesn't exist
				// or didn't respond - skip it and keep scanning the rest.
			}
		}

		if (startingDrive) {
			await this.selectDrive(startingDrive);
			this._onActivity.fire(`Restored current drive to ${startingDrive}:`);
		}

		this._onActivity.fire(`Drive scan complete: ${drives.length} drive(s) found`);

		return drives;
	}

	/**
	 * Must be called from within `withExclusiveAccess` - see scanDrives().
	 */
	async getDirListing(drive: string): Promise<string[]> {
		if (!this.port?.isOpen) {
			return [];
		}

		this._onActivity.fire(`Listing files on ${drive}:`);
		// See selectDrive() for why this waits for the prompt itself rather
		// than a quiet gap.
		await this.selectDrive(drive);

		const start = this.inputBuffer.length;
		this.writeRaw('DIR\r');
		await this.waitForIdle();
		const response = this.inputBuffer.slice(start);

		const files = parseDirResponse(response);
		this._onActivity.fire(`${drive}: ${files.length} file(s) found`);

		return files;
	}

	/**
	 * Scans drives and lists each one's files through a single Remote CCP
	 * session (one launch/quit for the whole refresh, rather than the
	 * launch-per-operation cost of calling scanDrives()/getDirListing() once
	 * Remote CCP were wired in per-call). Returns undefined if Remote CCP
	 * isn't available, so callers fall back to scanDrives()+getDirListing().
	 * Must be called from within `withExclusiveAccess`.
	 */
	async scanDrivesAndFilesViaRemoteCcp(): Promise<Map<string, RemoteCcpFile[]> | undefined> {
		if (!this.port?.isOpen) {
			return undefined;
		}

		return this.withRemoteCcp(this.remoteCcpHomeDrive(), async (client) => {
			const result = new Map<string, RemoteCcpFile[]>();
			this._onActivity.fire('Remote CCP: scanning drives…');
			const drives = await client.driveList((letter) => {
				this._onActivity.fire(`Found drive ${letter}:`);
			});
			this._onActivity.fire(`Remote CCP: found ${drives.length} drive(s)`);

			for (const drive of drives) {
				await client.setDrive(drive);
				const files = await client.listFiles();
				result.set(drive, files);
				this._onActivity.fire(`${drive}: ${files.length} file(s) found`);
			}

			return result;
		});
	}

	/**
	 * Lists just `drive` through a single Remote CCP session. Returns
	 * undefined if Remote CCP isn't available, so callers fall back to
	 * getDirListing(). Must be called from within `withExclusiveAccess`.
	 */
	async listFilesViaRemoteCcp(drive: string): Promise<RemoteCcpFile[] | undefined> {
		if (!this.port?.isOpen) {
			return undefined;
		}

		return this.withRemoteCcp(drive, async (client) => {
			return client.listFiles();
		});
	}

	/**
	 * Sends a command and captures the complete raw response into the
	 * "CP/M IDE: Serial Trace" output channel as a hex dump, so a real
	 * exchange can be compared byte-for-byte against a known-good capture
	 * (e.g. from TeraTerm) instead of guessing at what was lost or altered.
	 */
	async runCommsTest(command = 'DIR\r'): Promise<{ receivedBytes: number; elapsedMs: number; response: string }> {
		if (!this.port?.isOpen) {
			throw new Error('Serial port not connected');
		}

		this.log.show(true);
		this.forceTrace = true;
		try {
			return await this.withExclusiveAccess(`Running comms test: ${JSON.stringify(command)}…`, async () => {
				this.log.appendLine('');
				this.log.appendLine(`===== COMMS TEST: sending ${JSON.stringify(command)} =====`);
				const start = this.inputBuffer.length;
				const startTime = Date.now();
				this.writeRaw(command);
				// Generous idle window: if the device has natural gaps between
				// lines (e.g. per-entry disk I/O) that are longer than a short
				// timeout, a tight window would misread "still working" as "done".
				await this.waitForIdle(3000, 20000);
				const response = this.inputBuffer.slice(start);
				const elapsedMs = Date.now() - startTime;
				this.log.appendLine(
					`===== COMMS TEST: received ${response.length} chars in ${elapsedMs}ms, ` +
					`idle-terminated (no new data for 3000ms) =====`
				);
				this._onActivity.fire(`Comms test: ${response.length} char(s) received in ${elapsedMs}ms`);
				return { receivedBytes: response.length, elapsedMs, response };
			});
		} finally {
			this.forceTrace = false;
		}
	}
}
