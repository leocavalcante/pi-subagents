export const MAX_PAGE_BYTES = 32 * 1024;

export interface OutputSlice {
	text: string;
	offset: number;
	nextOffset: number | null;
	totalBytes: number;
}

export type OutputPager = (offset: number, limit: number) => OutputSlice;

function validateRange(offset: number, limit: number): void {
	if (!Number.isSafeInteger(offset) || offset < 0) throw new RangeError("offset must be a non-negative safe integer.");
	if (!Number.isInteger(limit) || limit < 4 || limit > MAX_PAGE_BYTES) {
		throw new RangeError(`limit must be an integer between 4 and ${MAX_PAGE_BYTES}.`);
	}
}

function sliceBytes(bytes: Buffer, offset: number, limit: number): OutputSlice {
	validateRange(offset, limit);
	if (offset > bytes.length) throw new RangeError("offset exceeds the captured output length.");
	if (offset < bytes.length && (bytes[offset] & 0xc0) === 0x80) {
		throw new RangeError("offset must align with a UTF-8 character boundary. Use nextOffset from the previous page.");
	}
	let end = Math.min(bytes.length, offset + limit);
	while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
	return { text: bytes.subarray(offset, end).toString("utf8"), offset,
		nextOffset: end < bytes.length ? end : null, totalBytes: bytes.length };
}

/**
 * Prepare a reusable byte-indexed pager for a captured output. Encoding once
 * lets late and sequential page requests avoid rescanning the UTF-16 prefix.
 */
function pagerForBytes(bytes: Buffer): OutputPager {
	return (offset, limit) => sliceBytes(bytes, offset, limit);
}

export function createOutputPager(text: string): OutputPager {
	return pagerForBytes(Buffer.from(text, "utf8"));
}

/** Byte offsets and page ends must fall on UTF-8 character boundaries. */
export function sliceOutput(text: string, offset: number, limit: number): OutputSlice {
	validateRange(offset, limit);
	return sliceBytes(Buffer.from(text, "utf8"), offset, limit);
}
