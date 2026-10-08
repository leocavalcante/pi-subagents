import { protocolUsageError } from "./usage.ts";

/** Bound structural nesting before parsing, so captured values remain safe to serialize. */
export function parseChildEvent(line: string): unknown {
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = 0; i < line.length; i++) {
		const code = line.charCodeAt(i);
		if (inString) {
			if (escaped) escaped = false;
			else if (code === 92) escaped = true; // Backslash.
			else if (code === 34) inString = false; // Quote.
			continue;
		}
		if (code === 34) inString = true;
		else if (code === 91 || code === 123) { // Array or object opening.
			if (++depth > 128) throw new RangeError("Subagent JSON nesting exceeded 128 levels.");
		} else if (code === 93 || code === 125) depth--;
	}
	const value: unknown = JSON.parse(line);
	if (hasNonFiniteJsonNumber(value)) {
		// JSON.parse can turn a syntactically valid exponent such as 1e400
		// into Infinity, which JSON.stringify later silently changes to null.
		throw new RangeError("Subagent JSON event contains a number outside the finite JavaScript range.");
	}
	return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isTextOrImageContent(part: unknown): boolean {
	if (!isObject(part)) return false;
	if (part.type === "text") return typeof part.text === "string";
	return part.type === "image" && typeof part.data === "string" && typeof part.mimeType === "string";
}

/** Validate user messages captured from child events without echoing payloads. */
export function userMessageError(message: unknown): string | undefined {
	if (!isObject(message) || message.role !== "user") return "malformed user message metadata";
	if (typeof message.content === "string" ||
		(Array.isArray(message.content) && message.content.every(isTextOrImageContent))) return undefined;
	return "malformed user message content";
}

/** The JSON structure scanner bounds recursion to 128 levels. */
function hasNonFiniteJsonNumber(value: unknown): boolean {
	if (typeof value === "number") return !Number.isFinite(value);
	if (Array.isArray(value)) return value.some(hasNonFiniteJsonNumber);
	if (isObject(value)) {
		for (const key in value) {
			if (Object.hasOwn(value, key) && hasNonFiniteJsonNumber(value[key])) return true;
		}
	}
	return false;
}

const STOP_REASONS = new Set(["stop", "length", "toolUse", "error", "aborted", "deferred"]);

/** Validate fields consumed from finalized assistant messages, without echoing payloads. */
export function assistantMessageError(message: unknown): string | undefined {
	if (!isObject(message) || !Array.isArray(message.content) || !message.content.every((part: unknown) => {
		if (!isObject(part)) return false;
		if (part.type === "text") return typeof part.text === "string";
		if (part.type === "thinking") return typeof part.thinking === "string" ||
			(part.redacted === true && part.thinking === undefined);
		return part.type === "toolCall" && typeof part.id === "string" && typeof part.name === "string" && isObject(part.arguments);
	})) return "malformed assistant content";

	if (typeof message.stopReason !== "string" || !STOP_REASONS.has(message.stopReason)) {
		return "missing or invalid terminal assistant stop reason";
	}
	for (const field of ["model", "errorMessage"]) {
		if (message[field] !== undefined && typeof message[field] !== "string") return `malformed assistant ${field}`;
	}

	if (protocolUsageError(message.usage)) return "malformed assistant usage";
	return undefined;
}

/** Validate tool-result fields captured from child events without echoing payloads. */
export function toolResultMessageError(message: unknown): string | undefined {
	if (!isObject(message) || message.role !== "toolResult" ||
		typeof message.toolCallId !== "string" || typeof message.toolName !== "string" ||
		typeof message.isError !== "boolean") return "malformed tool result metadata";
	if (!Array.isArray(message.content) || !message.content.every(isTextOrImageContent)) return "malformed tool result content";
	if (protocolUsageError(message.usage)) return "malformed tool result usage";
	return undefined;
}
