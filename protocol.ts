import { protocolUsageError } from "./usage.ts";
import { isWellFormedUnicode } from "./unicode.ts";

/** Bound JSON structure breadth and nesting before parsing untrusted child records. */
export const MAX_JSON_STRUCTURE_TOKENS = 65_536;

export function parseChildEvent(line: string): unknown {
	let depth = 0;
	let structuralTokens = 0;
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
			if (++structuralTokens > MAX_JSON_STRUCTURE_TOKENS) {
				throw new RangeError(`Subagent JSON structure exceeded ${MAX_JSON_STRUCTURE_TOKENS} tokens.`);
			}
		} else if (code === 93 || code === 125) depth--;
		else if (code === 44 || code === 58) { // Comma or colon outside strings.
			if (++structuralTokens > MAX_JSON_STRUCTURE_TOKENS) {
				throw new RangeError(`Subagent JSON structure exceeded ${MAX_JSON_STRUCTURE_TOKENS} tokens.`);
			}
		}
	}
	const value: unknown = JSON.parse(line);
	const invalidData = invalidJsonData(value);
	if (invalidData === "unicode") {
		throw new RangeError("Subagent JSON event contains an ill-formed Unicode string.");
	}
	if (invalidData === "number") {
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
function invalidJsonData(value: unknown): "unicode" | "number" | undefined {
	if (typeof value === "string") return isWellFormedUnicode(value) ? undefined : "unicode";
	if (typeof value === "number") return Number.isFinite(value) ? undefined : "number";
	if (Array.isArray(value)) {
		for (const item of value) {
			const invalid = invalidJsonData(item);
			if (invalid) return invalid;
		}
	}
	if (isObject(value)) {
		for (const key in value) {
			if (!Object.hasOwn(value, key)) continue;
			if (!isWellFormedUnicode(key)) return "unicode";
			const invalid = invalidJsonData(value[key]);
			if (invalid) return invalid;
		}
	}
	return undefined;
}

const CAPTURED_MESSAGE_ROLES = new Set(["assistant", "user", "toolResult"]);

/** Capture only messages used to build a subagent result; Pi's AgentMessage roles are extensible. */
export function isCapturedMessageRole(role: unknown): boolean {
	return typeof role === "string" && CAPTURED_MESSAGE_ROLES.has(role);
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
