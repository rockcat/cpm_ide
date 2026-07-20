const DRIVE_PREFIX = /^[A-Za-z]:\s*/;

/**
 * Parses CP/M DIR output into "NAME.EXT" filenames.
 *
 * Each entry is a fixed-width CP/M FCB field - 8-char name, 1 separator
 * space, 3-char extension - with up to 4 entries per line joined by " : "
 * and each line prefixed with "X: " for the drive letter. Parsing by fixed
 * column position (rather than splitting on whitespace) is what correctly
 * handles short/blank extensions, e.g. a file named "KEY" with none.
 */
export function parseDirResponse(response: string): string[] {
	const files: string[] = [];

	for (const rawLine of response.split(/\r\n|\r|\n/)) {
		if (!DRIVE_PREFIX.test(rawLine)) {
			continue;
		}
		const withoutPrefix = rawLine.replace(DRIVE_PREFIX, '');

		for (const entry of withoutPrefix.split(' : ')) {
			const name = entry.slice(0, 8).trim();
			const ext = entry.slice(9, 12).trim();
			if (name) {
				files.push(ext ? `${name}.${ext}` : name);
			}
		}
	}

	return files;
}
