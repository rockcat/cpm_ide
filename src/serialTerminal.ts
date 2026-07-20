import * as vscode from 'vscode';
import SerialPort from 'serialport';
import * as fs from 'fs';
import * as path from 'path';
import { XModem, SerialLink } from './xmodem';
import { formatHexDump } from './hexDump';
import { parseDirResponse } from './cpmDirParser';

export class SerialTerminal {
	private port: SerialPort | undefined;
	private xmodem: XModem;
	private readonly log: vscode.OutputChannel;
	private promptRegex = /[A-P]>/;
	private inputBuffer = '';
	private hiddenCommandInProgress = false;
	private lastDataTime = 0;
	/** Forces trace logging on regardless of the `enableSerialTrace` setting - used by runCommsTest. */
	private forceTrace = false;
	/** Best-known current CCP drive, tracked from the last "X>" prompt seen. */
	private currentDrive: string | undefined;

	private _onData = new vscode.EventEmitter<string>();
	readonly onData = this._onData.event;

	private _onRawData = new vscode.EventEmitter<Buffer>();
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

	constructor() {
		this.xmodem = new XModem();
		this.log = vscode.window.createOutputChannel('CP/M IDE: Serial Trace');
	}

	get isOpen(): boolean {
		return this.port?.isOpen ?? false;
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
		if (this.port?.isOpen) {
			this.port.close();
			this._onActivity.fire('Disconnected');
		}
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
				this.writeRaw(`${driveBefore}:\r`);
				await this.waitForIdle(150, 800);
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
		this._onRawData.fire(data);

		const promptMatches = text.match(/[A-P]>/g);
		if (promptMatches) {
			this.currentDrive = promptMatches[promptMatches.length - 1][0];
		}

		if (!this.hiddenCommandInProgress) {
			this._onData.fire(text);
		}
	}

	/**
	 * Facade handed to XModem so its reads go through this connection's
	 * single paused-mode reader instead of attaching a competing
	 * `port.on('data', ...)` listener of its own.
	 */
	private getSerialLink(): SerialLink {
		return {
			write: (data: Buffer) => this.writeRaw(data),
			onData: (listener: (data: Buffer) => void) => this.onRawData(listener),
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

	async showConfiguration() {
		vscode.commands.executeCommand('cpmIde.serialTerminal.focus');
	}

	async transferFileToDevice(localFilePath: string) {
		if (!this.port?.isOpen) {
			vscode.window.showErrorMessage('Serial port not connected');
			return;
		}

		const fileName = path.basename(localFilePath);
		const fileContent = fs.readFileSync(localFilePath);

		try {
			await this.withExclusiveAccess(
				`Sending ${fileName} to device…`,
				() => this.xmodem.send(this.getSerialLink(), fileContent, fileName)
			);
			this._onActivity.fire(`Sent ${fileName}`);
			vscode.window.showInformationMessage(`File ${fileName} transferred to device`);
		} catch (error) {
			this._onActivity.fire(`Failed to send ${fileName}`);
			vscode.window.showErrorMessage(`Transfer failed: ${error}`);
		}
	}

	/**
	 * Confirms XMODEM.COM is present on `drive`, copying it from A: (the
	 * conventional CP/M system drive) via PIP first if it's missing there.
	 * Must be called from within `withExclusiveAccess`. Leaves `drive`
	 * selected as the CCP's current drive.
	 */
	private async ensureXModemOnDrive(drive: string): Promise<boolean> {
		if ((await this.getDirListing(drive)).includes('XMODEM.COM')) {
			return true;
		}

		if (drive === 'A') {
			return false;
		}

		this._onActivity.fire(`XMODEM.COM not found on ${drive}: - checking A: for a copy…`);
		if (!(await this.getDirListing('A')).includes('XMODEM.COM')) {
			return false;
		}

		this._onActivity.fire(`Copying XMODEM.COM from A: to ${drive}:…`);
		this.writeRaw(`PIP ${drive}:=A:XMODEM.COM\r`);
		await this.waitForIdle(500, 8000);

		const copied = (await this.getDirListing(drive)).includes('XMODEM.COM');
		this._onActivity.fire(copied ? `XMODEM.COM copied to ${drive}:` : `Failed to copy XMODEM.COM to ${drive}:`);
		return copied;
	}

	async transferFileFromDevice(fileName: string, drive: string) {
		if (!this.port?.isOpen) {
			vscode.window.showErrorMessage('Serial port not connected');
			return;
		}

		const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
		if (!workspaceFolder) {
			vscode.window.showErrorMessage('Open a workspace folder to receive the file into');
			return;
		}

		const savePath = path.join(workspaceFolder.uri.fsPath, fileName);
		if (fs.existsSync(savePath)) {
			const choice = await vscode.window.showWarningMessage(
				`${fileName} already exists in the workspace. Overwrite it?`,
				{ modal: true },
				'Overwrite'
			);
			if (choice !== 'Overwrite') {
				return;
			}
		}

		try {
			await this.withExclusiveAccess(`Receiving ${fileName} from device…`, async () => {
				if (!await this.ensureXModemOnDrive(drive)) {
					throw new Error(
						`XMODEM.COM not found on drive ${drive}: and no copy available on A: - ` +
						`install it on the device first`
					);
				}

				// ensureXModemOnDrive() leaves `drive` selected as the CCP's
				// current drive.
				this.writeRaw(`XMODEM ${fileName} /S\r`);
				// Give the CCP a moment to load and launch XMODEM.COM before
				// we start the receive handshake.
				await new Promise(resolve => setTimeout(resolve, 300));

				const fileContent = await this.xmodem.receive(this.getSerialLink(), fileName);
				fs.writeFileSync(savePath, fileContent);
			});
			this._onActivity.fire(`Received ${fileName}`);
			vscode.window.showInformationMessage(`File ${fileName} received from device`);
		} catch (error) {
			this._onActivity.fire(`Failed to receive ${fileName}`);
			vscode.window.showErrorMessage(`Transfer failed: ${error}`);
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

		this._onActivity.fire('Scanning drives A-P…');
		for (let i = 0; i < 16; i++) {
			const driveLetter = String.fromCharCode(65 + i); // A-P
			try {
				const start = this.inputBuffer.length;
				// CP/M's console reads a command line up to a bare CR - a
				// trailing LF is never consumed and sits in the device's
				// receive buffer, where a later "key pending?" check (e.g.
				// DIR's abort-on-keypress) can misread it as a keypress.
				this.writeRaw(`${driveLetter}:\r`);
				// Drive select only echoes a short prompt, so a non-responding
				// drive shouldn't cost the full multi-second idle timeout.
				await this.waitForIdle(150, 800);
				const response = this.inputBuffer.slice(start);

				if (this.promptRegex.test(response)) {
					drives.push(driveLetter);
					this._onActivity.fire(`Found drive ${driveLetter}:`);
				}
			} catch (error) {
				// Skip this drive and keep scanning the rest.
			}
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
		this.writeRaw(`${drive}:\r`);
		await this.waitForIdle(150, 800);

		const start = this.inputBuffer.length;
		this.writeRaw('DIR\r');
		await this.waitForIdle();
		const response = this.inputBuffer.slice(start);

		const files = parseDirResponse(response);
		this._onActivity.fire(`${drive}: ${files.length} file(s) found`);

		return files;
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
