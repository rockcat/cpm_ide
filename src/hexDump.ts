export function formatHexDump(data: Buffer): string {
	const hex = Array.from(data).map(b => b.toString(16).padStart(2, '0')).join(' ');
	const ascii = Array.from(data).map(b => (b >= 0x20 && b < 0x7f) ? String.fromCharCode(b) : '.').join('');
	return `${hex}  |${ascii}|`;
}
