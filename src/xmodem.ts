/**
 * Minimal read/write contract XModem needs from the serial connection.
 * Deliberately not the raw `SerialPort` - reads must flow through the
 * connection's single paused-mode reader rather than a competing
 * `port.on('data', ...)` listener, which would flip the stream back into
 * flowing mode and start dropping bytes.
 */
export interface SerialLink {
	write(data: Buffer): void;
	onData(listener: (data: Buffer) => void): { dispose(): void };
}

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
	private static readonly TIMEOUT = 10000;
	private static readonly MAX_RETRIES = 10;
	private static readonly BLOCK_SIZE = 128;
	private static readonly BLOCK_SIZE_1K = 1024;

	async send(link: SerialLink, data: Buffer, fileName: string): Promise<void> {
		return new Promise((resolve, reject) => {
			this.doSend(link, data, fileName)
				.then(resolve)
				.catch(reject);
		});
	}

	async receive(link: SerialLink, fileName: string): Promise<Buffer> {
		return new Promise((resolve, reject) => {
			this.doReceive(link, fileName)
				.then(resolve)
				.catch(reject);
		});
	}

	private async doSend(link: SerialLink, data: Buffer, fileName: string): Promise<void> {
		// Send XMODEM send command
		// Wait for NAK from receiver
		// Send blocks until complete

		let blockNum = 1;
		let offset = 0;
		let retryCount = 0;

		// Wait for initial NAK
		const initialNak = await this.waitForByte(link, [XModem.NAK], XModem.TIMEOUT);
		if (initialNak === undefined) {
			throw new Error('No response from receiver');
		}

		while (offset < data.length) {
			const blockData = Buffer.alloc(XModem.BLOCK_SIZE);
			const bytesToRead = Math.min(XModem.BLOCK_SIZE, data.length - offset);
			data.copy(blockData, 0, offset, offset + bytesToRead);

			// Pad with CTRL-Z
			for (let i = bytesToRead; i < XModem.BLOCK_SIZE; i++) {
				blockData[i] = XModem.CTRLZ;
			}

			// Build block
			const block = Buffer.alloc(132);
			block[0] = XModem.SOH;
			block[1] = blockNum & 0xff;
			block[2] = (~blockNum) & 0xff;
			blockData.copy(block, 3);
			block[131] = this.calculateChecksum(blockData);

			// Send block with retries
			let acked = false;
			retryCount = 0;

			while (!acked && retryCount < XModem.MAX_RETRIES) {
				link.write(block);
				const response = await this.waitForByte(link, [XModem.ACK, XModem.NAK], XModem.TIMEOUT);

				if (response === XModem.ACK) {
					acked = true;
					blockNum++;
					offset += bytesToRead;
				} else if (response === XModem.NAK) {
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

	private async doReceive(link: SerialLink, fileName: string): Promise<Buffer> {
		const chunks: Buffer[] = [];
		let blockNum = 1;
		let retryCount = 0;

		// Send initial NAK to start transfer
		link.write(Buffer.from([XModem.NAK]));

		while (true) {
			const byte = await this.waitForByte(link, [XModem.SOH, XModem.STX, XModem.EOT], XModem.TIMEOUT);

			if (byte === XModem.EOT) {
				// End of transmission
				link.write(Buffer.from([XModem.ACK]));
				break;
			} else if (byte === XModem.SOH || byte === XModem.STX) {
				// Read block header
				const blockSizeBytes = byte === XModem.STX ? 2 : 1;
				const blockSize = byte === XModem.STX ? XModem.BLOCK_SIZE_1K : XModem.BLOCK_SIZE;

				const header = await this.readBytes(link, blockSizeBytes + 2);
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

				// Valid block, add to output
				chunks.push(blockData);
				link.write(Buffer.from([XModem.ACK]));
				blockNum++;
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

	private async waitForByte(link: SerialLink, expectedBytes: number[], timeout: number): Promise<number | undefined> {
		return new Promise((resolve) => {
			const subscription = link.onData((data: Buffer) => {
				for (const byte of data) {
					if (expectedBytes.includes(byte)) {
						clearTimeout(timeoutHandle);
						subscription.dispose();
						resolve(byte);
						return;
					}
				}
			});

			const timeoutHandle = setTimeout(() => {
				subscription.dispose();
				resolve(undefined);
			}, timeout);
		});
	}

	private async readBytes(link: SerialLink, count: number): Promise<Buffer | undefined> {
		const buffer = Buffer.alloc(count);
		let bytesRead = 0;

		return new Promise((resolve) => {
			const subscription = link.onData((data: Buffer) => {
				const toCopy = Math.min(count - bytesRead, data.length);
				data.copy(buffer, bytesRead, 0, toCopy);
				bytesRead += toCopy;

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
