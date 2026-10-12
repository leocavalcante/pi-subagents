/** Output bounds for structured agent-discovery metadata. */
export const MAX_AGENT_LISTING_PATH_BYTES = 4 * 1024;
export const MAX_AGENT_LISTING_DIAGNOSTIC_MESSAGE_BYTES = 512;

const TRUNCATION_NOTICE = "…[truncated]";

/** Keep structured metadata useful while bounding arbitrary filesystem and diagnostic strings. */
export function truncateAgentListingText(value: string, maxBytes: number): string {
	if (!Number.isInteger(maxBytes) || maxBytes < Buffer.byteLength(TRUNCATION_NOTICE, "utf8")) {
		throw new RangeError("Agent listing text limit is too small.");
	}
	// Avoid scanning or encoding an oversized input beyond the bounded prefix.
	if (value.length <= maxBytes && Buffer.byteLength(value, "utf8") <= maxBytes) return value;
	const noticeBytes = Buffer.byteLength(TRUNCATION_NOTICE, "utf8");
	let end = maxBytes - noticeBytes;
	const bytes = Buffer.from(value.slice(0, end + 2), "utf8");
	while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
	return bytes.subarray(0, end).toString("utf8") + TRUNCATION_NOTICE;
}
