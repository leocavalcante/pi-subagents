/** Bounded capture for untrusted child-process output. Limits are UTF-8 bytes. */
export const MAX_JSON_RECORD_BYTES = 8 * 1024 * 1024;
export const MAX_STDERR_BYTES = 64 * 1024;
export const MAX_HISTORY_BYTES = 16 * 1024 * 1024;
export const MAX_HISTORY_MESSAGES = 128;

function positiveLimit(limit: number): void {
	if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Capture limits must be positive integers within the safe range.");
}

function utf8Prefix(text: string, maxBytes: number): string {
	// A UTF-16 prefix of maxBytes + 2 code units is enough to cover the byte
	// budget and any surrogate pair at its boundary. Do not encode a discarded
	// child-output tail just to keep its bounded prefix.
	const bytes = Buffer.from(text.slice(0, maxBytes + 2), "utf8");
	if (text.length <= maxBytes && bytes.length <= maxBytes) return text;
	let end = Math.max(0, maxBytes);
	while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
	return bytes.subarray(0, end).toString("utf8");
}

/** Keep a diagnostic prefix while continuing to drain the rest of the stream. */
export class TextCapture {
	private value = "";
	private bytes = 0;
	private truncatedText?: string;
	truncated = false;

	constructor(private limit = MAX_STDERR_BYTES) { positiveLimit(limit); }

	append(text: string): void {
		if (this.truncated) return;
		this.truncatedText = undefined;
		const remaining = this.limit - this.bytes;
		// UTF-8 uses at least one byte per UTF-16 code unit. A longer chunk
		// cannot fit, so do not scan its potentially unbounded discarded tail.
		if (text.length > remaining) {
			this.value += utf8Prefix(text, remaining);
			this.truncated = true;
			return;
		}
		const bytes = Buffer.byteLength(text, "utf8");
		if (bytes <= remaining) {
			this.value += text;
			this.bytes += bytes;
		} else {
			this.value += utf8Prefix(text, remaining);
			this.truncated = true;
		}
	}

	get text(): string {
		if (!this.truncated) return this.value;
		if (this.truncatedText === undefined) {
			const notice = utf8Prefix("\n[stderr capture truncated]", this.limit);
			this.truncatedText = utf8Prefix(this.value, this.limit - Buffer.byteLength(notice)) + notice;
		}
		return this.truncatedText;
	}
}

/** Split only on LF, discard oversized records, and resume at the next LF. */
export class JsonLineCapture {
	private buffer = "";
	private bytes = 0;
	private discarding = false;

	constructor(
		private onLine: (line: string) => void,
		private onOverflow: () => void,
		private limit = MAX_JSON_RECORD_BYTES,
	) { positiveLimit(limit); }

	append(chunk: string): void {
		let start = 0;
		while (start < chunk.length) {
			const end = chunk.indexOf("\n", start);
			const fragment = chunk.slice(start, end < 0 ? undefined : end);
			if (!this.discarding) {
				const remaining = this.limit - this.bytes;
				// UTF-8 uses at least one byte per UTF-16 code unit, so a fragment
				// longer than the remaining byte budget is certainly oversized.
				// Skip scanning the whole fragment just to discard it.
				const bytes = fragment.length > remaining ? undefined : Buffer.byteLength(fragment, "utf8");
				if (bytes === undefined || bytes > remaining) {
					this.buffer = "";
					this.bytes = 0;
					this.discarding = true;
					this.onOverflow();
				} else {
					this.buffer += fragment;
					this.bytes += bytes;
				}
			}
			if (end < 0) return;
			if (!this.discarding) this.onLine(this.buffer);
			this.buffer = "";
			this.bytes = 0;
			this.discarding = false;
			start = end + 1;
		}
	}

	finish(): void {
		if (!this.discarding && this.buffer) this.onLine(this.buffer);
		this.buffer = "";
		this.bytes = 0;
		this.discarding = false;
	}
}

/** Keep recent complete messages without changing aggregate usage accounting. */
export class MessageCapture<T> {
	private entries: Array<{ message: T; bytes: number }> = [];
	private bytes = 0;
	dropped = 0;

	constructor(private byteLimit = MAX_HISTORY_BYTES, private countLimit = MAX_HISTORY_MESSAGES) {
		positiveLimit(byteLimit);
		positiveLimit(countLimit);
	}

	push(message: T, bytes: number): void {
		if (!Number.isSafeInteger(bytes) || bytes < 0) {
			throw new Error("Message size must be a non-negative safe integer.");
		}
		if (bytes > this.byteLimit) {
			this.dropped += this.entries.length + 1;
			this.entries = [];
			this.bytes = 0;
			return;
		}
		// Compare against remaining capacity before addition so the retained-byte
		// total never crosses the safe-integer range, even with large custom limits.
		while (this.entries.length >= this.countLimit || bytes > this.byteLimit - this.bytes) {
			this.bytes -= this.entries.shift()!.bytes;
			this.dropped++;
		}
		this.entries.push({ message, bytes });
		this.bytes += bytes;
	}

	get messages(): T[] {
		return this.entries.map((entry) => entry.message);
	}

	get retainedBytes(): number {
		return this.bytes;
	}
}
