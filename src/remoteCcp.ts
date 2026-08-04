import { SerialLink } from './xmodem';
import { TransferCancelledError } from './transferQueue';

const ACK = 0x06;
const NAK = 0x15;
const ETX = 0x03;
const EOT = 0x04;
const CR = 0x0d;
const LF = 0x0a;

export interface RemoteCcpFile {
	name: string;
	recordCount: number;
}

/**
 * Client for the Remote CCP protocol - see specs/Remote CCP
 * Specification.md and remote/remotccp.asm.
 *
 * Talks to an ALREADY-RUNNING REMOTCCP.COM session over the shared serial
 * link. Callers are responsible for launching it (write "REMOTCCP.COM\r",
 * then waitForStartup()) and quitting it (quit()) before releasing
 * exclusive access to the line - this class only speaks the command
 * protocol, it doesn't manage the CCP around it.
 *
 * Unlike the CCP-driven scanning/XMODEM flows elsewhere in this codebase,
 * Remote CCP's command loop is synchronous and single-threaded on the
 * device: it never reads the next command line until it's completely done
 * processing the current one. Commands can simply be sent back-to-back with
 * no idle-timeout guessing needed - the entire reason this protocol exists.
 */
export class RemoteCcpClient {
	private pendingRx: number[] = [];
	private waiters: Array<(byte: number) => void> = [];
	private readonly subscription: { dispose(): void };

	constructor(private readonly link: SerialLink) {
		this.subscription = link.onData((data: Buffer) => {
			for (const byte of data) {
				const waiter = this.waiters.shift();
				if (waiter) {
					waiter(byte);
				} else {
					this.pendingRx.push(byte);
				}
			}
		});
	}

	dispose(): void {
		this.subscription.dispose();
	}

	private readByte(timeoutMs = 10000): Promise<number> {
		const buffered = this.pendingRx.shift();
		if (buffered !== undefined) {
			return Promise.resolve(buffered);
		}

		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				const idx = this.waiters.indexOf(done);
				if (idx >= 0) {
					this.waiters.splice(idx, 1);
				}
				reject(new Error('Remote CCP: timed out waiting for a response'));
			}, timeoutMs);

			const done = (byte: number) => {
				clearTimeout(timer);
				resolve(byte);
			};
			this.waiters.push(done);
		});
	}

	private async readBytes(count: number, timeoutMs?: number): Promise<Buffer> {
		const bytes = new Array<number>(count);
		for (let i = 0; i < count; i++) {
			bytes[i] = await this.readByte(timeoutMs);
		}
		return Buffer.from(bytes);
	}

	private writeLine(line: string): void {
		this.link.write(Buffer.from(line + '\r', 'ascii'));
	}

	/**
	 * Waits for REMOTCCP.COM to actually be up and reads its startup version
	 * byte. `echoLength` is the exact byte count of the console's
	 * character-echo of the launch command itself (including its
	 * terminating CR) - entirely predictable, since it's just what was
	 * typed being reflected back (see launchRemoteCcp()'s comment). What the
	 * CCP prints after that and before actually running the .COM isn't as
	 * fixed - some CCPs emit a single CR/LF, others more - so rather than
	 * also hardcoding that count (which desyncs the version-byte read by
	 * however many bytes the guess is off by), every CR/LF byte after the
	 * echo is skipped and the first byte that isn't one of those is taken as
	 * the version byte.
	 *
	 * Each byte gets the full `timeoutMs` budget individually (not shared
	 * across all of them) - loading the .COM off disk before the CCP's
	 * trailing CR/LF, or before the version byte itself, can each take
	 * several seconds on slower hardware, and a shared/shrinking budget
	 * risks timing out mid-gap on whichever byte happens to be slowest.
	 *
	 * Returns the version byte (BDOS function 12's L register, e.g. 0x22
	 * for CP/M 2.2).
	 */
	async waitForStartup(echoLength: number, timeoutMs = 40000): Promise<number> {
		await this.readBytes(echoLength, timeoutMs);
		let byte: number;
		do {
			byte = await this.readByte(timeoutMs);
		} while (byte === CR || byte === LF);
		return byte;
	}

	async quit(): Promise<void> {
		this.writeLine('Q');
		await this.readByte(); // ACK
		await this.waitForCcpPrompt();
	}

	/**
	 * Drains and discards bytes after Q's ACK until the CCP's own prompt
	 * (a drive letter A-P followed by '>') reappears, or timeoutMs elapses.
	 * REMOTCCP.COM's exit and the CCP's warm boot back to its command loop
	 * happen on the device after the ACK, outside the Remote CCP protocol
	 * proper - nothing else reads those bytes. Left unconsumed, quit() would
	 * return while the device is still mid-exit, and whatever runs next
	 * (withExclusiveAccess releasing, or the next command) could see that
	 * trailing "A>" noise or - worse - write into the device before it's
	 * actually back at a prompt reading its console, the same class of bug
	 * fixed for hasFileOnDrive()'s DIR check.
	 */
	private async waitForCcpPrompt(timeoutMs = 8000): Promise<void> {
		// Drive letter, optionally followed by a 1-2 digit user-area number -
		// CP/M 3/MP/M shows e.g. "A2>" for a non-zero user area, not just "A>".
		const promptPattern = /[A-P]\d{0,2}>/;
		let tail = '';
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			let byte: number;
			try {
				byte = await this.readByte(deadline - Date.now());
			} catch {
				return; // best-effort, same as quit()'s own callers
			}
			tail = (tail + String.fromCharCode(byte)).slice(-6);
			if (promptPattern.test(tail)) {
				return;
			}
		}
	}

	async currentDrive(): Promise<string> {
		this.writeLine('DC');
		const letter = await this.readByte();
		await this.readByte(); // EOT
		return String.fromCharCode(letter);
	}

	async diskGet(): Promise<string> {
		this.writeLine('DG');
		const letter = await this.readByte();
		return String.fromCharCode(letter);
	}

	/**
	 * Selecting a drive can involve real disk I/O (mounting/seeking) that
	 * takes a while - wait for the device's ACK confirming the select is
	 * actually done, rather than sending the next command immediately and
	 * risking it arriving before the device is ready to read it.
	 */
	async setDrive(letter: string): Promise<void> {
		this.writeLine(`DS${letter.toUpperCase()}`);
		// Generous budget: drive selects on this hardware have been observed
		// to occasionally take upwards of 10s (matching every other
		// disk-I/O-bound operation in this protocol) - a tighter timeout
		// here reproduces the exact "gave up right as the real response
		// arrived" race seen with the earlier fixed delays.
		await this.readByte(30000);
	}

	async driveList(onDriveFound?: (letter: string) => void): Promise<string[]> {
		this.writeLine('DL');
		const drives: string[] = [];
		while (true) {
			const byte = await this.readByte();
			if (byte === EOT) {
				return drives;
			}
			const letter = String.fromCharCode(byte);
			drives.push(letter);
			onDriveFound?.(letter);
		}
	}

	/** Drives BDOS reports as read-only (BDOS 29 DRV_ROVEC), same wire shape as driveList(). */
	async readOnlyDriveList(): Promise<string[]> {
		this.writeLine('DR');
		const drives: string[] = [];
		while (true) {
			const byte = await this.readByte();
			if (byte === EOT) {
				return drives;
			}
			drives.push(String.fromCharCode(byte));
		}
	}

	/**
	 * Lists files on the current drive. Like the CCP's own DIR, a file
	 * spanning multiple extents appears once per extent - matching
	 * cpmDirParser's existing behavior rather than merging them, so callers
	 * that already tolerate that (the CP/M Files tree) don't need to change.
	 */
	async listFiles(): Promise<RemoteCcpFile[]> {
		this.writeLine('FL');
		const files: RemoteCcpFile[] = [];
		while (true) {
			const first = await this.readByte();
			if (first === EOT) {
				return files;
			}
			const name = Buffer.concat([Buffer.from([first]), await this.readBytes(7)]).toString('ascii').trimEnd();
			await this.readByte(); // '.'
			const ext = (await this.readBytes(3)).toString('ascii').trimEnd();
			await this.readByte(); // '|'
			const rcHex = (await this.readBytes(2)).toString('ascii');
			await this.readByte(); // '|'

			files.push({
				name: ext ? `${name}.${ext}` : name,
				recordCount: parseInt(rcHex, 16),
			});
		}
	}

	/**
	 * Fetches a file's contents. CP/M doesn't track an exact byte length for
	 * files that aren't a whole number of 128-byte records - like any CP/M
	 * transfer, the last block may include some trailing padding beyond the
	 * file's real content; this is a filesystem characteristic, not
	 * something this protocol can resolve on its own.
	 *
	 * Returns an empty buffer both for a missing file and a genuinely empty
	 * one - the wire protocol can't tell those apart (FG_MISS in the
	 * assembly sends the same bare EOT either way). Check listFiles() first
	 * if that distinction matters.
	 */
	async getFile(
		fileName: string,
		onProgress?: (bytesReceived: number) => void,
		isCancelled?: () => boolean
	): Promise<Buffer> {
		this.writeLine(`FG${fileName}`);
		const chunks: Buffer[] = [];
		let totalBytes = 0;

		while (true) {
			if (isCancelled?.()) {
				throw new TransferCancelledError(fileName);
			}
			const first = await this.readByte(60000);
			if (first === EOT) {
				return Buffer.concat(chunks);
			}
			if (first === ETX) {
				throw new Error(`Remote CCP gave up sending ${fileName} after too many errors`);
			}

			const hex = Buffer.concat([Buffer.from([first]), await this.readBytes(257, 10000)]).toString('ascii');
			const data = Buffer.from(hex.slice(0, 256), 'hex');
			const expectedChecksum = parseInt(hex.slice(256, 258), 16);

			if (checksum(data) === expectedChecksum) {
				chunks.push(data);
				totalBytes += data.length;
				onProgress?.(totalBytes);
				this.link.write(Buffer.from([ACK]));
			} else {
				this.link.write(Buffer.from([NAK]));
			}
		}
	}

	/** Writes `data` to `fileName` on the device, replacing it if it already exists. */
	async putFile(
		fileName: string,
		data: Buffer,
		onProgress?: (bytesSent: number) => void,
		isCancelled?: () => boolean
	): Promise<void> {
		this.writeLine(`FP${fileName}`);

		// F_DELETE/F_MAKE are real disk I/O and can take a while - wait for
		// the device's explicit "file ready" ACK rather than guessing a
		// delay and racing it (blasting block data at a device that's still
		// mid-creation is exactly how earlier attempts at this silently
		// desynced). ETX here means creation itself failed.
		const ready = await this.readByte(30000);
		if (ready === ETX) {
			throw new Error(`Remote CCP couldn't create ${fileName} (disk or directory full?)`);
		}
		if (ready !== ACK) {
			throw new Error(`Remote CCP: unexpected response waiting for ${fileName} to be ready (0x${ready.toString(16)})`);
		}

		const padded = padTo128(data);

		for (let offset = 0; offset < padded.length; offset += 128) {
			if (isCancelled?.()) {
				throw new TransferCancelledError(fileName);
			}
			const block = padded.subarray(offset, offset + 128);
			const hex = block.toString('hex').toUpperCase() + toHex2(checksum(block));

			let acked = false;
			let retries = 0;
			while (!acked) {
				this.link.write(Buffer.from(hex, 'ascii'));
				// Generous budget: F_WRITE is real disk I/O, subject to the
				// same occasional multi-second slowness as drive selects and
				// file creation elsewhere in this protocol.
				const response = await this.readByte(30000);
				if (response === ACK) {
					acked = true;
				} else if (response === NAK) {
					retries++;
					if (retries > 10) {
						throw new Error(`Remote CCP: too many retries sending a block of ${fileName}`);
					}
				} else if (response === ETX) {
					throw new Error(`Remote CCP aborted receiving ${fileName}`);
				}
			}
			onProgress?.(offset + block.length);
		}

		this.link.write(Buffer.from([EOT]));
	}
}

function checksum(data: Buffer): number {
	let sum = 0;
	for (const byte of data) {
		sum = (sum + byte) & 0xff;
	}
	return sum;
}

function toHex2(byte: number): string {
	return byte.toString(16).toUpperCase().padStart(2, '0');
}

function padTo128(data: Buffer): Buffer {
	const remainder = data.length % 128;
	if (remainder === 0) {
		return data;
	}
	const out = Buffer.alloc(data.length + (128 - remainder), 0x1a);
	data.copy(out, 0);
	return out;
}
