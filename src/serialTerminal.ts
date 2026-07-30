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

/** Filename Remote CCP is bootstrapped/looked up under - 8 chars, CP/M's limit ("REMOTECCP" doesn't fit). */
const REMOTE_CCP_FILENAME = 'REMOTCCP.COM';
/** Command typed at the CCP to launch it - no ".COM": the CCP appends that itself when searching for a command. */
const REMOTE_CCP_COMMAND = 'REMOTCCP';

export class SerialTerminal {
	private port: SerialPort | undefined;
	private xmodem: XModem;
	private readonly log: vscode.OutputChannel;
	private promptRegex = /[A-P]>/;
	private inputBuffer = '';
	private hiddenCommandInProgress = false;
	private lastDataTime = 0;
	private connectionGeneration = 0;
	/** Forces trace logging on regardless of the `enableSerialTrace` setting - used by runCommsTest. */
	private forceTrace = false;
	/* Forces all input to be converted to uppercase before sending to the device, regardless of what the user typed. */
	private forceCapitals = true;
	/** Best-known current CCP drive, tracked from the last "X>" prompt seen. */
	private currentDrive: string | undefined;
	/**
	 * Whether REMOTCCP.COM is confirmed usable on this connection - undefined
	 * until first attempted, then sticky until reconnect so we don't retry
	 * (and re-prompt to install) on every single operation once it's known
	 * to be unavailable.
	 */
	private remoteCcpAvailable: boolean | undefined;
	/**
	 * Manual user override that blocks Remote CCP from being launched or
	 * installed by the automatic drive-scan/file-listing/transfer paths.
	 * Unlike remoteCcpAvailable, this is a deliberate choice rather than a
	 * detection result, so it does NOT reset on reconnect - it stays off
	 * until the user turns it back on. The manual "Send REMOTCCP" actions
	 * bypass this flag entirely, since triggering them IS the user asking
	 * for Remote CCP traffic despite the toggle.
	 */
	private remoteCcpDisabled = false;
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

	currentPort: string | undefined;

	constructor(private readonly context: vscode.ExtensionContext) {
		this.xmodem = new XModem();
		this.log = vscode.window.createOutputChannel('CP/M IDE: Serial Trace');
	}

	get isOpen(): boolean {
		return this.port?.isOpen ?? false;
	}

	get isRemoteCcpDisabled(): boolean {
		return this.remoteCcpDisabled;
	}

	setRemoteCcpDisabled(disabled: boolean): void {
		this.remoteCcpDisabled = disabled;
		this._onActivity.fire(disabled
			? 'Remote CCP disabled - falling back to legacy CCP-command path'
			: 'Remote CCP re-enabled');
	}

	/** "CP/M X.Y" once learned from a Remote CCP session's startup byte, else undefined. */
	get detectedCpmVersion(): string | undefined {
		return this.cpmVersion;
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
		// A different device may be on the other end now - re-probe rather
		// than trusting the previous connection's answer.
		this.remoteCcpAvailable = undefined;
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

	disconnect() {
		if (this.hiddenCommandInProgress) {
			this.hiddenCommandInProgress = false;
			this._onBusyChange.fire(false);
			this._onActivity.fire('Cancelled active serial task');
		}

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
	 * Sends interactive keystrokes typed by the user at the terminal. Ignored
	 * while a background command (drive scan, DIR listing, file transfer) has
	 * exclusive control of the line - CP/M only has one console, so the two
	 * must never write to it at the same time.
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
	 * Runs `work` with sole ownership of the serial line, blocking interactive
	 * input for its duration so a background probe (drive scan, DIR listing,
	 * file transfer) can't interleave with - and corrupt - what the user is
	 * typing at the CP/M prompt. `label` is surfaced in the activity log.
	 */
	async withExclusiveAccess<T>(label: string, work: () => Promise<T>): Promise<T> {
		const driveBefore = this.currentDrive;
		this.hiddenCommandInProgress = true;
		this._onBusyChange.fire(true);
		this._onActivity.fire(label);
		try {
			return await work();
		} finally {
			// Restore the drive the user was on before this background
			// operation ran, so they land back where they were rather than
			// wherever the last scan/transfer happened to leave the CCP.
			if (driveBefore && driveBefore !== this.currentDrive) {
				await this.selectDrive(driveBefore);
				this._onActivity.fire(`Restored current drive to ${driveBefore}:`);
			}
			this.hiddenCommandInProgress = false;
			this._onBusyChange.fire(false);
			this._onActivity.fire('Ready');
		}
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

		const promptMatches = text.match(/[A-P]>/g);
		if (promptMatches) {
			this.currentDrive = promptMatches[promptMatches.length - 1][0];
		}

		if (!this.hiddenCommandInProgress) {
			this._onData.fire(text);
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
					throw new Error('Connection was reset');
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
	 * it's done after one fixed delay.
	 */
	private async waitForIdle(idleMs = 300, timeoutMs = 4000): Promise<void> {
		const start = Date.now();
		this.lastDataTime = Date.now();
		while (Date.now() - start < timeoutMs) {
			await new Promise(resolve => setTimeout(resolve, 50));
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
	 */
	private async waitForPrompt(sinceLength: number, timeoutMs = 5000): Promise<boolean> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			if (this.promptRegex.test(this.inputBuffer.slice(sinceLength))) {
				return true;
			}
			await new Promise(resolve => setTimeout(resolve, 50));
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

		try {
			await this.withExclusiveAccess(`Sending ${fileName} to ${drive}:…`, async () => {
				const viaRemoteCcp = await this.withRemoteCcp(drive, async (client) => {
					await client.putFile(remoteFileName, fileContent);
					return true;
				});
				if (viaRemoteCcp) {
					return;
				}

				// Remote CCP unavailable - fall back to XMODEM.
				if (!await this.ensureXModemOnDrive(drive)) {
					throw new Error(
						`XMODEM.COM not found on drive ${drive}: and no copy available on A: - ` +
						`install it on the device first`
					);
				}

				// ensureXModemOnDrive() leaves `drive` selected as the current drive.
				// /F skips XMODEM.COM's "Overwrite (Y/N)?" prompt, which would
				// otherwise hang forever waiting for a keypress we never send.
				this.writeRaw(`XMODEM ${remoteFileName} /F /R\r`);
				// Give the CCP a moment to load and launch XMODEM.COM before we send.
				await new Promise(resolve => setTimeout(resolve, 300));
				await this.xmodem.send(this.getSerialLink(), fileContent, remoteFileName);
			});
			this._onActivity.fire(`Sent ${fileName}`);
			vscode.window.showInformationMessage(`File ${fileName} transferred to device`);
			return true;
		} catch (error) {
			this._onActivity.fire(`Failed to send ${fileName}`);
			vscode.window.showErrorMessage(`Transfer failed: ${error}`);
			return false;
		}
	}

	/**
	 * Sends one or more files to `drive` using the Slide protocol (see
	 * src/slide-ts) instead of XMODEM. Launches SLIDECPM on the device,
	 * waits for it to respond, then hands off to Slide's own RDY/RDY
	 * handshake and sliding-window transfer.
	 */
	async sendFilesViaSlide(filePaths: string[], drive: string): Promise<boolean> {
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

		const label = filePaths.length === 1
			? `Sending ${path.basename(filePaths[0])} via Slide…`
			: `Sending ${filePaths.length} files via Slide…`;

		try {
			await this.withExclusiveAccess(label, async () => {
				await this.selectDrive(drive);

				this.writeRaw('SLIDECPM\r');
				// Give the CCP a moment to load and launch SLIDECPM.COM, and
				// wait for whatever it prints in response, before starting
				// Slide's own RDY/RDY handshake.
				await this.waitForIdle(300, 3000);

				const session = new SerialSession(this.getSerialLink());
				await sendFiles(session, filePaths, this.traceEnabled());
			});

			this._onActivity.fire(`Sent ${filePaths.length} file(s) via Slide to ${drive}:`);
			vscode.window.showInformationMessage(`Slide: sent ${filePaths.length} file(s) to ${drive}:`);
			return true;
		} catch (error) {
			this._onActivity.fire('Slide send failed');
			vscode.window.showErrorMessage(`Slide send failed: ${error}`);
			return false;
		}
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
				comReady = await this.copyFileFromA(drive, 'XMODEM.COM');
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
			await this.copyFileFromA(drive, 'XMODEM.CFG');
		}

		return true;
	}

	private async copyFileFromA(drive: string, fileName: string): Promise<boolean> {
		this._onActivity.fire(`Copying ${fileName} from A: to ${drive}:…`);
		this.writeRaw(`PIP ${drive}:=A:${fileName}\r`);
		await this.waitForIdle(500, 8000);

		const copied = await this.hasFileOnDrive(drive, fileName);
		this._onActivity.fire(copied ? `${fileName} copied to ${drive}:` : `Failed to copy ${fileName} to ${drive}:`);
		return copied;
	}

	/**
	 * Confirms REMOTCCP.COM is present on `drive`, bootstrapping it onto A:
	 * (prompting the user first) and/or copying it from A: via PIP as
	 * needed - mirroring ensureXModemOnDrive's pattern. Must be called from
	 * within withExclusiveAccess.
	 */
	private async ensureRemoteCcpOnDrive(drive: string): Promise<boolean> {
		if (await this.hasFileOnDrive(drive, REMOTE_CCP_FILENAME)) {
			return true;
		}
		if (drive !== 'A') {
			return await this.ensureRemoteCcpOnDrive('A') && await this.copyFileFromA(drive, REMOTE_CCP_FILENAME);
		}
		return await this.bootstrapRemoteCcp();
	}

	/**
	 * Installs REMOTCCP.COM onto A: for the first time, after asking the
	 * user. Tries four methods in order, each falling back to the next on
	 * failure or missing prerequisites:
	 *
	 * 1. XMODEM (installRemoteCcpViaXmodem) - block checksums and ACK/NAK
	 *    retries built into the protocol itself, rather than this code
	 *    having to work around hardware quirks after the fact. Tried first
	 *    for exactly that reason.
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

		const choice = await vscode.window.showInformationMessage(
			`${REMOTE_CCP_FILENAME} isn't on A: yet. It replaces the slower CCP-command-driven drive scans, ` +
			`file listings, and transfers with a small resident helper. Install it now over the serial link?`,
			{ modal: true },
			'Install'
		);
		if (choice !== 'Install') {
			return false;
		}

		let installed = false;

		// XMODEM's own block-level checksums and retries are specifically
		// designed to cope with an unreliable link, rather than this code
		// having to detect and route around hardware quirks after the fact
		// like every other method below - tried first for exactly that
		// reason.
		if (await this.canInstallRemoteCcpViaXmodem()) {
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
	 * Runs whatever extra step a non-Generic target (cpmIde.target) needs
	 * right after REMOTCCP.COM has been confirmed installed. Currently only
	 * MicroBeast needs this: it requires ALWRITE to be run afterward. Must
	 * be called from within withExclusiveAccess.
	 */
	private async runTargetPostInstallHook(): Promise<void> {
		const target = vscode.workspace.getConfiguration('cpmIde').get<string>('target') ?? 'Generic';
		if (target !== 'MicroBeast') {
			return;
		}

		this._onActivity.fire('MicroBeast target - running ALWRITE…');
		await this.selectDrive('A');
		const start = this.inputBuffer.length;
		this.writeRaw('ALWRITE\r');
		await this.waitForPrompt(start, 15000);
		await this.waitForIdle(500, 5000);

		const response = this.inputBuffer.slice(start);
		this._onActivity.fire(/error/i.test(response)
			? `ALWRITE reported an error: ${response.trim()}`
			: 'ALWRITE completed');
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
			if (!await this.pipReceiveLine('A', hexFileName, line, i > 0)) {
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
				if (!await this.waitForExpectedFileSize('A', hexFileName, expectedSoFar, 3, 400)) {
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
		if (!await this.waitForExpectedFileSize('A', hexFileName, expectedRecords)) {
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
		this._onActivity.fire(`Converting ${hexFileName} to ${REMOTE_CCP_FILENAME} with LOAD…`);
		const loadStart = this.inputBuffer.length;
		this.writeRaw('LOAD REMOTCCP\r');
		await this.waitForPrompt(loadStart, 15000);
		await this.waitForIdle(500, 5000);

		const loadResponse = this.inputBuffer.slice(loadStart);
		if (/error/i.test(loadResponse)) {
			this._onActivity.fire(`LOAD reported an error converting ${hexFileName}: ${loadResponse.trim()} - leaving it in place for inspection`);
			return false;
		}

		const installed = await this.hasFileOnDrive('A', REMOTE_CCP_FILENAME);
		this._onActivity.fire(installed
			? `${REMOTE_CCP_FILENAME} installed on A: ${via}`
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

		await this.selectDrive('A');
		this._onActivity.fire(`Sending ${REMOTE_CCP_FILENAME} via XMODEM…`);
		// No /F here (unlike the regular file-transfer path) - this only
		// ever runs when REMOTCCP.COM is confirmed missing (see
		// ensureRemoteCcpOnDrive), so there's nothing to overwrite and no
		// "Overwrite (Y/N)?" prompt to skip.
		this.writeRaw(`XMODEM ${REMOTE_CCP_FILENAME} /R\r`);
		// Give the CCP a moment to load and launch XMODEM.COM before we send.
		await new Promise(resolve => setTimeout(resolve, 300));

		try {
			await this.xmodem.send(this.getSerialLink(), fileContent, REMOTE_CCP_FILENAME);
		} catch (error) {
			this._onActivity.fire(`XMODEM send failed: ${error instanceof Error ? error.message : error} - leaving any partial ${REMOTE_CCP_FILENAME} in place for inspection`);
			return false;
		}

		const installed = await this.hasFileOnDrive('A', REMOTE_CCP_FILENAME);
		this._onActivity.fire(installed
			? `${REMOTE_CCP_FILENAME} installed on A: via XMODEM`
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

		await this.selectDrive('A');

		// Clear any stale REMOTCCP.HEX left by an earlier failed attempt
		// first, so ED opens it as a genuinely NEW FILE rather than editing
		// whatever's already there - unlike leaving a failed attempt's own
		// files in place for inspection, this is just making sure a new
		// attempt starts from a clean slate.
		this.writeRaw(`ERA A:${hexFileName}\r`);
		await this.waitForIdle(300, 3000);

		this._onActivity.fire(`Starting ED to insert ${hexFileName}…`);
		const edStart = this.inputBuffer.length;
		this.writeRaw(`ED A:${hexFileName}\r`);
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
		this._onActivity.fire(`Sending PIP command to receive ${REMOTE_CCP_FILENAME} on A:…`);
		await this.selectDrive('A');
		this.writeRaw(`PIP A:${REMOTE_CCP_FILENAME}=RDR:[O]\r`);
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
		// One unbroken write, not chunked - see installRemoteCcpViaHex's
		// matching comment.
		this.writeRaw(fileContent);
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

		const installed = await this.hasFileOnDrive('A', REMOTE_CCP_FILENAME);
		this._onActivity.fire(installed
			? `${REMOTE_CCP_FILENAME} installed on A:`
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
	 * Manually sends just the PIP receive command - the terminal's "Send PIP
	 * command" action. Independent of remoteCcpDisabled: triggering this
	 * action is the user explicitly asking for Remote CCP traffic regardless
	 * of that toggle.
	 */
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
	 * sendRemoteCcpPipCommand). Independent of remoteCcpDisabled for the
	 * same reason as sendRemoteCcpPipCommand.
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
		// No ".COM" here - the CCP appends that itself when it searches for
		// a command, and typing it explicitly makes most CCPs fail to find
		// the match at all (reported as "REMOTCCP.COM?", CP/M's unknown-
		// command error) rather than just being harmlessly redundant.
		this.writeRaw(`${REMOTE_CCP_COMMAND}\r`);
		// Wait for the echo/CR-LF/load-time chatter to genuinely settle
		// before listening for the version byte - REMOTCCP.COM prints no
		// prompt of its own to waitForPrompt() on, and a fixed delay here
		// races loading the .COM off disk (which, like every other disk
		// operation on this hardware, can take well over what seems like a
		// safe guess). Starting to listen too early swallows a leftover
		// echo/CRLF byte as if it were the version byte, leaving the real
		// one unconsumed and desyncing every subsequent read by one byte.
		await this.waitForIdle(300, 5000);

		const client = new RemoteCcpClient(this.getSerialLink());
		try {
			// Generous budget: waitForStartup() deliberately waits out an
			// 8s settle window (possibly more than once) to confirm startup
			// chatter has truly settled, not just grabbing the first byte
			// it sees - the overall budget needs enough room for several
			// such windows, not just one.
			const versionByte = await client.waitForStartup(40000);
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
	 * Remote CCP isn't available at all, so callers can fall back to their
	 * older CCP-command/XMODEM path; a failure partway through `work` itself
	 * still throws normally. Must be called from within withExclusiveAccess.
	 */
	private async withRemoteCcp<T>(drive: string, work: (client: RemoteCcpClient) => Promise<T>): Promise<T | undefined> {
		if (this.remoteCcpDisabled || this.remoteCcpAvailable === false) {
			return undefined;
		}

		const client = await this.launchRemoteCcp(drive);
		if (!client) {
			this.remoteCcpAvailable = false;
			return undefined;
		}
		this.remoteCcpAvailable = true;

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
		await this.waitForIdle(500, 6000);
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

	async transferFileFromDevice(fileName: string, drive: string): Promise<boolean> {
		if (!this.port?.isOpen) {
			vscode.window.showErrorMessage('Serial port not connected');
			return false;
		}

		const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
		if (!workspaceFolder) {
			vscode.window.showErrorMessage('Open a workspace folder to receive the file into');
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
			await this.withExclusiveAccess(`Receiving ${fileName} from device…`, async () => {
				const viaRemoteCcp = await this.withRemoteCcp(drive, async (client) => {
					const fileContent = await client.getFile(remoteFileName);
					fs.writeFileSync(savePath, fileContent);
					return true;
				});
				if (viaRemoteCcp) {
					return;
				}

				// Remote CCP unavailable - fall back to XMODEM.
				if (!await this.ensureXModemOnDrive(drive)) {
					throw new Error(
						`XMODEM.COM not found on drive ${drive}: and no copy available on A: - ` +
						`install it on the device first`
					);
				}

				// ensureXModemOnDrive() leaves `drive` selected as the CCP's
				// current drive.
				this.writeRaw(`XMODEM ${remoteFileName} /S\r`);
				// Give the CCP a moment to load and launch XMODEM.COM before
				// we start the receive handshake.
				await new Promise(resolve => setTimeout(resolve, 300));

				// XModem.receive() already strips the trailing CTRL-Z padding
				// XMODEM uses to fill out the last block - no further trimming
				// needed (or correct: this used to search for NUL, the wrong
				// pad byte, with slice math that could zero out the whole
				// buffer whenever a stray 0x00 happened to appear near the end).
				const fileContent = await this.xmodem.receive(this.getSerialLink(), remoteFileName);
				fs.writeFileSync(savePath, fileContent);
			});
			this._onActivity.fire(`Received ${fileName}`);
			vscode.window.showInformationMessage(`File ${fileName} received from device`);
			return true;
		} catch (error) {
			this._onActivity.fire(`Failed to receive ${fileName}`);
			vscode.window.showErrorMessage(`Transfer failed: ${error}`);
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
	 * user has already started `XMODEM <file> /R` themselves at the CP/M
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
				// Skip this drive and keep scanning the rest.
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
	async scanDrivesAndFilesViaRemoteCcp(): Promise<Map<string, string[]> | undefined> {
		if (!this.port?.isOpen) {
			return undefined;
		}

		return this.withRemoteCcp('A', async (client) => {
			const result = new Map<string, string[]>();
			this._onActivity.fire('Remote CCP: scanning drives…');
			const drives = await client.driveList((letter) => {
				this._onActivity.fire(`Found drive ${letter}:`);
			});
			this._onActivity.fire(`Remote CCP: found ${drives.length} drive(s)`);

			for (const drive of drives) {
				await client.setDrive(drive);
				const files = await client.listFiles();
				result.set(drive, files.map((f) => f.name));
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
	async listFilesViaRemoteCcp(drive: string): Promise<string[] | undefined> {
		if (!this.port?.isOpen) {
			return undefined;
		}

		return this.withRemoteCcp(drive, async (client) => {
			const files = await client.listFiles();
			return files.map((f) => f.name);
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
