export interface ListingLine {
	address: number;
	text: string;
}

// Common Z80/8080 assembler listing layout: an optional line-number field,
// then a 4-hex-digit address, followed by whitespace or a colon, then the
// bytes actually assembled at that address (e.g. zasm's
// "0100: 0E09          LD C,9" - address, colon, hex bytes padded to a
// fixed column, a tab, then the source). A line with no bytes there - EQU,
// ORG, a label-only or comment line - still gets an "address" in the
// listing (EQU's equated value, ORG's origin), but it isn't a real code
// address: requiring at least one hex byte pair is what tells those apart,
// so e.g. a constant equated to a value that happens to fall between two
// real instructions can't outrank the instruction that's actually there
// for a given PC. The gap between the address and those bytes is matched
// with plain spaces, not \s, so it can't cross the tab into the source
// column and accidentally match hex-looking letters in a mnemonic there
// (e.g. the "BD" in "BDOS").
const ADDRESS_PATTERN = /^\s*(?:\d+[:\s]+)?([0-9A-Fa-f]{4})[:\s][ ]*([0-9A-Fa-f]{2,})/;

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
