export const MAX_PAGE_BYTES = 32 * 1024;

export interface OutputSlice {
	text: string;
	offset: number;
	nextOffset: number | null;
	totalBytes: number;
}

/** Byte offsets and page ends must fall on UTF-8 character boundaries. */
export function sliceOutput(text: string, offset: number, limit: number): OutputSlice {
	if (!Number.isSafeInteger(offset) || offset < 0) throw new RangeError("offset must be a non-negative safe integer.");
	if (!Number.isInteger(limit) || limit < 4 || limit > MAX_PAGE_BYTES) {
		throw new RangeError(`limit must be an integer between 4 and ${MAX_PAGE_BYTES}.`);
	}
	const bytes = Buffer.from(text, "utf8");
	if (offset > bytes.length) throw new RangeError("offset exceeds the captured output length.");
	if (offset < bytes.length && (bytes[offset] & 0xc0) === 0x80) {
		throw new RangeError("offset must align with a UTF-8 character boundary. Use nextOffset from the previous page.");
	}
	let end = Math.min(bytes.length, offset + limit);
	while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
	return { text: bytes.subarray(offset, end).toString("utf8"), offset,
		nextOffset: end < bytes.length ? end : null, totalBytes: bytes.length };
}
