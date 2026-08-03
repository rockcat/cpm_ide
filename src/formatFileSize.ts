/** Formats a byte count as e.g. "0.1K" or "1.2M", rounded to the nearest 0.1 unit. */
export function formatFileSize(bytes: number): string {
	if (bytes >= 1024 * 1024) {
		return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
	}
	return `${(bytes / 1024).toFixed(1)}K`;
}
