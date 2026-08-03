import { TransferCancelledError } from './transferQueue';

/**
 * Minimal read/write contract protocol implementations (XModem, Slide) need
 * from the serial connection. Deliberately not the raw `SerialPort` - reads
 * must flow through the connection's single paused-mode reader rather than
 * a competing `port.on('data', ...)` listener, which would flip the stream
 * back into flowing mode and start dropping bytes.
 */
export interface SerialLink {
	write(data: Buffer): void;
	onData(listener: (data: Buffer) => void): { dispose(): void };
	/** Waits until previously written bytes have actually gone out. Only meaningful for a link backed by a real port. */
	drain?(): Promise<void>;
	/** Discards buffered input/output at the OS/driver level. Only meaningful for a link backed by a real port. */
	flush?(): Promise<void>;
	/** Actual baud rate of the underlying connection, if known. */
	baudRate?(): number;
}

/** Reports cumulative bytes transferred so far. */
export type XModemProgressFn = (bytesTransferred: number) => void;
/** Polled between blocks; returning true aborts the transfer with TransferCancelledError. */
export type XModemIsCancelledFn = () => boolean;

/**
 * XMODEM protocol implementation for CP/M file transfer
 * Supports XMODEM and XMODEM-1K variants
 */
export class XModem {
	private static readonly SOH = 0x01;
	private static readonly STX = 0x02;
	private static readonly EOT = 0x04;
	private static readonly ACK = 0x06;
	private static readonly NAK = 0x15;
	private static readonly CAN = 0x18;
	private static readonly CTRLZ = 0x1a;
	/** Requests XMODEM-CRC mode instead of checksum mode; sent by the receiver in place of NAK. */
	private static readonly CRC_MODE = 0x43; // 'C'
	private static readonly TIMEOUT = 10000;
	/**
	 * Some XMODEM.COM builds deliberately stall for tens of seconds before
	 * sending their first handshake byte when the transfer port is the
	 * console - a grace period for a human to start the other side. The
	 * per-block TIMEOUT is too short to survive that; the initial sync wait
	 * gets its own, much more patient budget.
	 */
	private static readonly SYNC_TIMEOUT = 60000;
	private static readonly MAX_RETRIES = 10;
	private static readonly BLOCK_SIZE = 128;
	private static readonly BLOCK_SIZE_1K = 1024;
	private pendingRx: number[] = [];

	async send(
		link: SerialLink,
		data: Buffer,
		fileName: string,
		onProgress?: XModemProgressFn,
		isCancelled?: XModemIsCancelledFn
	): Promise<void> {
		return new Promise((resolve, reject) => {
			this.doSend(link, data, fileName, onProgress, isCancelled)
				.then(resolve)
				.catch(reject);
		});
	}

	async receive(
		link: SerialLink,
		fileName: string,
		onProgress?: XModemProgressFn,
		isCancelled?: XModemIsCancelledFn
	): Promise<Buffer> {
		return new Promise((resolve, reject) => {
			this.doReceive(link, fileName, onProgress, isCancelled)
				.then(resolve)
				.catch(reject);
		});
	}

	private async doSend(
		link: SerialLink,
		data: Buffer,
		fileName: string,
		onProgress?: XModemProgressFn,
		isCancelled?: XModemIsCancelledFn
	): Promise<void> {
		this.pendingRx = [];

		let blockNum = 1;
		let offset = 0;
		let retryCount = 0;

		// The receiver announces its mode with the first handshake byte: NAK
		// for classic checksum mode, or 'C' to request XMODEM-CRC. Everything
		// after - the retry signal and the block trailer - follows whichever
		// mode it picked.
		//
		// Unlike NAK, 'C' (0x43) is an ordinary printable letter, and CP/M
		// XMODEM programs print human-readable startup banners - e.g.
		// "Receiving via CON with CRCs" - before they start actually
		// requesting a transfer. A bare scan for byte value 0x43 fires the
		// instant it sees the 'C' in "CON", well before the receiver has
		// finished its banner and is genuinely ready, so we'd start sending
		// into a receiver that isn't listening yet. waitForIsolatedByte()
		// requires the match to stand alone - not buried in a burst of
		// other bytes - which banner text never does but the real,
		// standalone, periodically-repeated handshake byte always does.
		const initialByte = await this.waitForIsolatedByte(link, [XModem.NAK, XModem.CRC_MODE], 400, XModem.SYNC_TIMEOUT);
		if (initialByte === undefined) {
			throw new Error('No response from receiver');
		}
		const crcMode = initialByte === XModem.CRC_MODE;

		while (offset < data.length) {
			if (isCancelled?.()) {
				throw new TransferCancelledError(fileName);
			}
			const blockData = Buffer.alloc(XModem.BLOCK_SIZE);
			const bytesToRead = Math.min(XModem.BLOCK_SIZE, data.length - offset);
			data.copy(blockData, 0, offset, offset + bytesToRead);

			// Pad with CTRL-Z
			for (let i = bytesToRead; i < XModem.BLOCK_SIZE; i++) {
				blockData[i] = XModem.CTRLZ;
			}

			// Build block
			const block = Buffer.alloc(crcMode ? 133 : 132);
			block[0] = XModem.SOH;
			block[1] = blockNum & 0xff;
			block[2] = (~blockNum) & 0xff;
			blockData.copy(block, 3);
			if (crcMode) {
				const crc = this.calculateCrc16(blockData);
				block[131] = (crc >> 8) & 0xff;
				block[132] = crc & 0xff;
			} else {
				block[131] = this.calculateChecksum(blockData);
			}

			// Send block with retries
			let acked = false;
			retryCount = 0;

			while (!acked && retryCount < XModem.MAX_RETRIES) {
				link.write(block);
				// In CRC mode, a retry request repeats 'C' rather than NAK.
				const response = await this.waitForByte(link, [XModem.ACK, XModem.NAK, XModem.CRC_MODE], XModem.TIMEOUT);

				if (response === XModem.ACK) {
					acked = true;
					blockNum++;
					offset += bytesToRead;
					onProgress?.(offset);
				} else if (response === XModem.NAK || response === XModem.CRC_MODE) {
					retryCount++;
				} else {
					throw new Error('Timeout waiting for ACK/NAK');
				}
			}

			if (!acked) {
				throw new Error('Block transfer failed after retries');
			}
		}

		// Send EOT
		link.write(Buffer.from([XModem.EOT]));
		const finalAck = await this.waitForByte(link, [XModem.ACK], XModem.TIMEOUT);
		if (finalAck !== XModem.ACK) {
			throw new Error('Failed to complete transfer');
		}
	}

	private async doReceive(
		link: SerialLink,
		fileName: string,
		onProgress?: XModemProgressFn,
		isCancelled?: XModemIsCancelledFn
	): Promise<Buffer> {
		this.pendingRx = [];
		const chunks: Buffer[] = [];
		let bytesReceived = 0;
		let blockNum = 1;
		let retryCount = 0;
		let firstFrameByte: number | undefined;

		// Send the initial NAK repeatedly until the CP/M side is actually ready.
		// Some XMODEM programs print startup chatter first - or deliberately
		// stall for tens of seconds when the transfer port is the console,
		// giving a human time to start the other side - and a single NAK can
		// be lost before the sender enters its send loop.
		const startTime = Date.now();
		while (Date.now() - startTime < XModem.SYNC_TIMEOUT) {
			link.write(Buffer.from([XModem.NAK]));
			const preamble = await this.waitForByte(link, [XModem.SOH, XModem.STX, XModem.EOT], 1000);
			if (preamble === XModem.SOH || preamble === XModem.STX || preamble === XModem.EOT) {
				if (preamble === XModem.EOT) {
					// The sender is already at EOT before we've seen a single
					// data block - it finished (or gave up) before this
					// receiver's listener attached. Silently "succeeding"
					// with an empty file here would hide that timing miss;
					// surface it so the user knows to retry.
					link.write(Buffer.from([XModem.ACK]));
					throw new Error(
						'Sender had already reached end-of-transfer before any data arrived - ' +
						'start the receive before the device starts sending, then retry.'
					);
				}
				firstFrameByte = preamble;
				break;
			}
		}

		// If the loop timed out without any sender response, continue into the
		// regular receive loop which will fail with the normal timeout path.

		while (true) {
			if (isCancelled?.()) {
				throw new TransferCancelledError(fileName);
			}
			const byte = firstFrameByte ?? await this.waitForByte(link, [XModem.SOH, XModem.STX, XModem.EOT], XModem.TIMEOUT);
			firstFrameByte = undefined;

			if (byte === XModem.EOT) {
				// End of transmission
				link.write(Buffer.from([XModem.ACK]));
				break;
			} else if (byte === XModem.SOH || byte === XModem.STX) {
				// Read block header
				const blockSize = byte === XModem.STX ? XModem.BLOCK_SIZE_1K : XModem.BLOCK_SIZE;

				const header = await this.readBytes(link, 2);
				if (!header) {
					link.write(Buffer.from([XModem.NAK]));
					retryCount++;
					if (retryCount > XModem.MAX_RETRIES) {
						throw new Error('Transfer failed');
					}
					continue;
				}

				const recvBlockNum = header[0];
				const recvBlockNumComp = header[1];

				// Verify block number
				if (((recvBlockNum + recvBlockNumComp) & 0xff) !== 0xff) {
					link.write(Buffer.from([XModem.NAK]));
					continue;
				}

				// Read block data
				const blockData = await this.readBytes(link, blockSize);
				if (!blockData) {
					link.write(Buffer.from([XModem.NAK]));
					continue;
				}

				// Read checksum
				const checksumByte = await this.readBytes(link, 1);
				if (!checksumByte) {
					link.write(Buffer.from([XModem.NAK]));
					continue;
				}

				const receivedChecksum = checksumByte[0];
				const calculatedChecksum = this.calculateChecksum(blockData);

				if (receivedChecksum !== calculatedChecksum) {
					link.write(Buffer.from([XModem.NAK]));
					continue;
				}

				// Accept the expected block; a repeat of the previous block
				// number means our ACK for it was lost and the sender
				// retransmitted - re-ACK without appending a duplicate. Any
				// other block number is a protocol desync.
				const expected = blockNum & 0xff;
				const previous = (blockNum - 1) & 0xff;
				if (recvBlockNum === expected) {
					chunks.push(blockData);
					blockNum++;
					bytesReceived += blockData.length;
					onProgress?.(bytesReceived);
				} else if (recvBlockNum !== previous) {
					throw new Error(`Unexpected block number ${recvBlockNum} (expected ${expected})`);
				}
				link.write(Buffer.from([XModem.ACK]));
				retryCount = 0;
			}
		}

		// Combine chunks and remove padding
		const data = Buffer.concat(chunks);
		let endIdx = data.length - 1;
		while (endIdx >= 0 && data[endIdx] === XModem.CTRLZ) {
			endIdx--;
		}

		return data.slice(0, endIdx + 1);
	}

	private calculateChecksum(data: Buffer): number {
		let sum = 0;
		for (const byte of data) {
			sum = (sum + byte) & 0xff;
		}
		return sum;
	}

	/** Standard CRC-16/XMODEM (poly 0x1021, init 0), used for the CRC-mode block trailer. */
	private calculateCrc16(data: Buffer): number {
		let crc = 0;
		for (const byte of data) {
			crc ^= byte << 8;
			for (let i = 0; i < 8; i++) {
				crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
			}
		}
		return crc;
	}

	private async waitForByte(link: SerialLink, expectedBytes: number[], timeout: number): Promise<number | undefined> {
		for (let i = 0; i < this.pendingRx.length; i++) {
			const byte = this.pendingRx[i];
			if (expectedBytes.includes(byte)) {
				this.pendingRx = this.pendingRx.slice(i + 1);
				return byte;
			}
		}
		this.pendingRx = [];

		return new Promise((resolve) => {
			const subscription = link.onData((data: Buffer) => {
				for (let i = 0; i < data.length; i++) {
					const byte = data[i];
					if (expectedBytes.includes(byte)) {
						if (i + 1 < data.length) {
							this.pendingRx.push(...Array.from(data.slice(i + 1)));
						}
						clearTimeout(timeoutHandle);
						subscription.dispose();
						resolve(byte);
						return;
					}
				}

				this.pendingRx.push(...Array.from(data));
			});

			const timeoutHandle = setTimeout(() => {
				subscription.dispose();
				resolve(undefined);
			}, timeout);
		});
	}

	/**
	 * Like waitForByte(), but only accepts a match that arrives in
	 * isolation - nothing queued immediately before or after it. See the
	 * call site in doSend() for why: CP/M XMODEM programs print
	 * human-readable startup banners before they actually start requesting
	 * a transfer, and those banners can coincidentally contain the same
	 * byte value as the real handshake character (e.g. the 'C' in "CON").
	 * The genuine handshake is sent standalone and repeated at intervals,
	 * so a real match is followed by quiet; a false match from banner text
	 * is immediately followed by more text.
	 */
	private async waitForIsolatedByte(
		link: SerialLink,
		expectedBytes: number[],
		settleMs: number,
		timeoutMs: number
	): Promise<number | undefined> {
		const deadline = Date.now() + timeoutMs;

		while (true) {
			const remaining = deadline - Date.now();
			if (remaining <= 0) {
				return undefined;
			}

			const candidate = await this.waitForByte(link, expectedBytes, remaining);
			if (candidate === undefined) {
				return undefined;
			}

			// Anything already queued right behind the match (same chunk,
			// or a chunk that had already arrived) means this was noise
			// inside a burst, not a standalone occurrence.
			if (this.pendingRx.length > 0) {
				continue;
			}

			// Peek for anything arriving within the settle window. An
			// empty expectedBytes list never "matches", so this simply
			// waits out the window while routing any incoming bytes into
			// pendingRx for the next iteration to see.
			await this.waitForByte(link, [], Math.max(0, Math.min(settleMs, deadline - Date.now())));
			if (this.pendingRx.length === 0) {
				return candidate;
			}
			// else: more data arrived during the settle window - noise
			// from banner text; loop and keep scanning past it.
		}
	}

	private async readBytes(link: SerialLink, count: number): Promise<Buffer | undefined> {
		const buffer = Buffer.alloc(count);
		let bytesRead = 0;

		if (this.pendingRx.length > 0) {
			const fromPending = Math.min(count, this.pendingRx.length);
			for (let i = 0; i < fromPending; i++) {
				buffer[i] = this.pendingRx[i];
			}
			bytesRead = fromPending;
			this.pendingRx = this.pendingRx.slice(fromPending);
			if (bytesRead >= count) {
				return buffer;
			}
		}

		return new Promise((resolve) => {
			const subscription = link.onData((data: Buffer) => {
				const toCopy = Math.min(count - bytesRead, data.length);
				data.copy(buffer, bytesRead, 0, toCopy);
				bytesRead += toCopy;

				if (toCopy < data.length) {
					this.pendingRx.push(...Array.from(data.slice(toCopy)));
				}

				if (bytesRead >= count) {
					clearTimeout(timeoutHandle);
					subscription.dispose();
					resolve(buffer);
				}
			});

			const timeoutHandle = setTimeout(() => {
				subscription.dispose();
				resolve(undefined);
			}, XModem.TIMEOUT);
		});
	}
}
