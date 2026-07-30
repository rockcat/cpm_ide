import { SerialLink } from './xmodem';

const ACK = 0x06;
const NAK = 0x15;
const ETX = 0x03;
const EOT = 0x04;

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
	 * Resolves `true` if no byte arrives within `ms` - `false` as soon as one
	 * does, pushing it back to the front of pendingRx unconsumed (so it's
	 * exactly as if this check never happened).
	 */
	private waitQuiet(ms: number): Promise<boolean> {
		return new Promise((resolve) => {
			const probe = (byte: number) => {
				clearTimeout(timer);
				this.pendingRx.unshift(byte);
				resolve(false);
			};
			const timer = setTimeout(() => {
				const idx = this.waiters.indexOf(probe);
				if (idx >= 0) {
					this.waiters.splice(idx, 1);
				}
				resolve(true);
			}, ms);
			this.waiters.push(probe);
		});
	}

	/**
	 * Waits for REMOTCCP.COM to actually be up and idle in its command loop.
	 * A freshly-launched session's startup chatter isn't just "the version
	 * byte": the CCP's own trailing CR/LF (printed before it's even
	 * finished loading the .COM off disk) can straggle in a good while
	 * after the echoed launch command, followed eventually - sometimes
	 * seconds later on slower disk I/O - by the real version byte. Grabbing
	 * whichever byte arrives first and assuming it's the version byte
	 * leaves the real one unconsumed, desyncing every read after it by one
	 * byte. Discarding bytes until the line has been genuinely quiet for a
	 * stretch sidesteps needing to identify which byte was "the" version
	 * byte at all - once quiet, the command loop is just waiting for us.
	 *
	 * Returns the version byte (BDOS function 12's L register, e.g. 0x22
	 * for CP/M 2.2) - by construction, whichever byte was read in the loop
	 * iteration right before quiet was confirmed is the real one, since
	 * everything read in earlier iterations turned out to have more data
	 * following it (i.e. was still just startup chatter).
	 */
	async waitForStartup(timeoutMs = 40000): Promise<number> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			const byte = await this.readByte(deadline - Date.now());
			// Observed on real hardware: a stray leftover byte can be
			// followed by a further gap - over 3.7s at least once - before
			// the genuine version byte arrives (loading the .COM off disk).
			// A too-short settle window declaring "done" mid-gap is exactly
			// how a later read (e.g. getFile's first block) ends up
			// consuming the real version byte as if it were file data,
			// permanently desyncing every checksum after it - this needs
			// real margin above the worst gap seen so far, not just enough
			// to cover it exactly.
			//
			// Always the full 8s, never shrunk to whatever time happens to
			// be left before the deadline: a shrinking window can be fooled
			// by a steady-but-not-actually-quiet stream (e.g. a crashed or
			// corrupted REMOTCCP.COM emitting garbage every second or two,
			// comfortably under a full settle window but longer than an
			// almost-exhausted one) into looking "quiet" just because the
			// window checked was too short to catch the next byte - exactly
			// how a misbehaving device on real hardware once got mistaken
			// for a genuinely idle one. Overshooting timeoutMs by up to one
			// full settle window is a fine trade for not doing that again;
			// the outer loop's own deadline check still catches a
			// genuinely-idle-forever case (the settle call always resolves
			// eventually) as a hard timeout, just not exactly at timeoutMs.
			if (await this.waitQuiet(8000)) {
				return byte;
			}
		}
		throw new Error('Remote CCP: timed out waiting for startup to settle');
	}

	async quit(): Promise<void> {
		this.writeLine('Q');
		await this.readByte(); // ACK
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
	async getFile(fileName: string, onProgress?: (bytesReceived: number) => void): Promise<Buffer> {
		this.writeLine(`FG${fileName}`);
		const chunks: Buffer[] = [];
		let totalBytes = 0;

		while (true) {
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
	async putFile(fileName: string, data: Buffer, onProgress?: (bytesSent: number) => void): Promise<void> {
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
