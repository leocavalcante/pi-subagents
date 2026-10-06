import { usageError } from "./usage.ts";

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
	return JSON.parse(line);
}

/** Validate fields consumed from finalized assistant messages, without echoing payloads. */
function isObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

const STOP_REASONS = new Set(["stop", "length", "toolUse", "error", "aborted", "deferred"]);

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

	if (usageError(message.usage)) return "malformed assistant usage";
	return undefined;
}
