/**
 * Converts `data` to Intel HEX text (CR/LF-terminated records, one final
 * ":00000001FF" EOF record) - the format CP/M's LOAD.COM reads to build a
 * .COM file. `baseAddress` should be 0x0100 to match where CP/M always
 * loads a .COM file, so LOAD reconstructs it at the right offsets.
 */
export function toIntelHex(data: Buffer, baseAddress = 0x0100, bytesPerLine = 16): string {
	const lines: string[] = [];
	for (let offset = 0; offset < data.length; offset += bytesPerLine) {
		const chunk = data.subarray(offset, Math.min(offset + bytesPerLine, data.length));
		lines.push(hexRecord(baseAddress + offset, 0x00, chunk));
	}
	lines.push(hexRecord(0, 0x01, Buffer.alloc(0))); // EOF record
	return lines.map(line => line + '\r\n').join('');
}

function hexRecord(address: number, recordType: number, data: Buffer): string {
	const bytes = [data.length, (address >> 8) & 0xff, address & 0xff, recordType, ...data];
	const checksum = (0x100 - (bytes.reduce((sum, b) => sum + b, 0) & 0xff)) & 0xff;
	return ':' + [...bytes, checksum].map(b => b.toString(16).toUpperCase().padStart(2, '0')).join('');
}
