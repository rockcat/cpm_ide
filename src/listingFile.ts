export interface ListingLine {
	address: number;
	text: string;
}

// Common Z80/8080 assembler listing layout: an optional line-number field,
// then a 4-hex-digit address, followed by whitespace or a colon (e.g.
// "0100  3E 05        LD A,5" or "  12  0100: 3E05    LD A,5"). Lines with
// no recognizable leading address (blank lines, comments, EQUs that emit no
// code) are skipped rather than guessed at.
const ADDRESS_PATTERN = /^\s*(?:\d+[:\s]+)?([0-9A-Fa-f]{4})[:\s]/;

export function parseListingFile(content: string): ListingLine[] {
	const lines: ListingLine[] = [];
	for (const rawLine of content.split(/\r\n|\r|\n/)) {
		const match = ADDRESS_PATTERN.exec(rawLine);
		if (match) {
			lines.push({ address: parseInt(match[1], 16), text: rawLine });
		}
	}
	return lines;
}
