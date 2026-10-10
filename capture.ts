import { TextDecoder } from "node:util";

/** Bounded capture for untrusted child-process output. Limits are UTF-8 bytes. */
export const MAX_JSON_RECORD_BYTES = 8 * 1024 * 1024;
export const MAX_STDERR_BYTES = 64 * 1024;
export const MAX_CHILD_STDOUT_BYTES = 128 * 1024 * 1024;
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

/** Stop parsing a child stream after its cumulative byte budget, while draining later chunks. */
export class BoundedByteStream {
	private bytes = 0;
	private exceeded = false;

	constructor(
		private limit: number,
		private onChunk: (chunk: Buffer) => void,
		private onLimit: () => void,
	) { positiveLimit(limit); }

	append(chunk: Buffer): void {
		if (this.exceeded) return;
		if (chunk.length > this.limit - this.bytes) {
			this.exceeded = true;
			this.onLimit();
			return;
		}
		this.bytes += chunk.length;
		this.onChunk(chunk);
	}

	get totalBytes(): number {
		return this.bytes;
	}

	get limitExceeded(): boolean {
		return this.exceeded;
	}
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

/** Split LF-delimited records, reject malformed UTF-8, and discard oversized records. */
export class JsonLineCapture {
	private buffer = "";
	private byteFragments: Buffer[] = [];
	private byteTail?: Buffer;
	private byteTailBytes = 0;
	private bytes = 0;
	private discarding = false;
	private mode?: "text" | "bytes";
	private decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

	constructor(
		private onLine: (line: string) => void,
		private onOverflow: () => void,
		private limit = MAX_JSON_RECORD_BYTES,
		private onInvalidUtf8: () => void = () => {},
	) { positiveLimit(limit); }

	append(chunk: string | Buffer): void {
		const isText = typeof chunk === "string" || chunk instanceof String;
		const mode = isText ? "text" : "bytes";
		if (this.mode && this.mode !== mode) throw new Error("JSON capture chunks must keep a consistent encoding.");
		this.mode = mode;
		if (isText) this.appendText(chunk as string);
		else this.appendBytes(chunk as Buffer);
	}

	private clearRecord(): void {
		this.buffer = "";
		this.byteFragments = [];
		this.byteTail = undefined;
		this.byteTailBytes = 0;
		this.bytes = 0;
	}

	private appendText(chunk: string): void {
		let start = 0;
		while (start < chunk.length) {
			const end = chunk.indexOf("\n", start);
			const fragmentEnd = end < 0 ? chunk.length : end;
			if (!this.discarding) {
				const remaining = this.limit - this.bytes;
				const fragmentLength = fragmentEnd - start;
				// UTF-8 uses at least one byte per UTF-16 code unit, so a fragment
				// longer than the remaining byte budget is certainly oversized.
				// Reject it before slicing, since child-output chunks may be huge.
				const fragment = fragmentLength > remaining ? undefined : chunk.slice(start, fragmentEnd);
				const bytes = fragment === undefined ? undefined : Buffer.byteLength(fragment, "utf8");
				if (bytes === undefined || bytes > remaining) {
					this.clearRecord();
					this.discarding = true;
					this.onOverflow();
				} else {
					this.buffer += fragment;
					this.bytes += bytes;
				}
			}
			if (end < 0) return;
			if (!this.discarding) this.onLine(this.buffer);
			this.clearRecord();
			this.discarding = false;
			start = end + 1;
		}
	}

	private appendByteFragment(chunk: Buffer, start: number, end: number): void {
		while (start < end) {
			if (!this.byteTail || this.byteTailBytes === this.byteTail.length) {
				if (this.byteTail) this.byteFragments.push(this.byteTail.subarray(0, this.byteTailBytes));
				this.byteTail = Buffer.allocUnsafe(Math.min(64 * 1024, this.limit - this.bytes));
				this.byteTailBytes = 0;
			}
			const count = Math.min(end - start, this.byteTail.length - this.byteTailBytes);
			chunk.copy(this.byteTail, this.byteTailBytes, start, start + count);
			this.byteTailBytes += count;
			start += count;
		}
	}

	private appendBytes(chunk: Buffer): void {
		let start = 0;
		while (start < chunk.length) {
			const end = chunk.indexOf(0x0a, start);
			const fragmentEnd = end < 0 ? chunk.length : end;
			if (!this.discarding) {
				const fragmentLength = fragmentEnd - start;
				const remaining = this.limit - this.bytes;
				if (fragmentLength > remaining) {
					this.clearRecord();
					this.discarding = true;
					this.onOverflow();
				} else {
					if (fragmentLength > 0) this.appendByteFragment(chunk, start, fragmentEnd);
					this.bytes += fragmentLength;
				}
			}
			if (end < 0) return;
			if (!this.discarding) this.emitByteRecord();
			this.clearRecord();
			this.discarding = false;
			start = end + 1;
		}
	}

	private emitByteRecord(): void {
		let line: string;
		try {
			const fragments = this.byteTailBytes && this.byteTail
				? [...this.byteFragments, this.byteTail.subarray(0, this.byteTailBytes)]
				: this.byteFragments;
			line = this.decoder.decode(Buffer.concat(fragments, this.bytes));
		} catch {
			this.onInvalidUtf8();
			return;
		}
		this.onLine(line);
	}

	finish(): void {
		if (!this.discarding) {
			if (this.mode === "bytes" && this.bytes > 0) this.emitByteRecord();
			else if (this.mode !== "bytes" && this.buffer) this.onLine(this.buffer);
		}
		this.clearRecord();
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

	push(message: T, bytes: number): boolean {
		if (!Number.isSafeInteger(bytes) || bytes < 0) {
			throw new Error("Message size must be a non-negative safe integer.");
		}
		if (bytes > this.byteLimit) {
			this.dropped += this.entries.length + 1;
			this.entries = [];
			this.bytes = 0;
			return false;
		}
		// Compare against remaining capacity before addition so the retained-byte
		// total never crosses the safe-integer range, even with large custom limits.
		while (this.entries.length >= this.countLimit || bytes > this.byteLimit - this.bytes) {
			this.bytes -= this.entries.shift()!.bytes;
			this.dropped++;
		}
		this.entries.push({ message, bytes });
		this.bytes += bytes;
		return true;
	}

	get messages(): T[] {
		return this.entries.map((entry) => entry.message);
	}

	get retainedBytes(): number {
		return this.bytes;
	}
}
