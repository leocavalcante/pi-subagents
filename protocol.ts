import { protocolUsageError } from "./usage.ts";
import { isWellFormedUnicode } from "./unicode.ts";

/** Bound JSON structure breadth and nesting before parsing untrusted child records. */
export const MAX_JSON_STRUCTURE_TOKENS = 65_536;
const ILL_FORMED_UNICODE_ERROR = "Subagent JSON event contains an ill-formed Unicode string.";
const NON_FINITE_NUMBER_ERROR = "Subagent JSON event contains a number outside the finite JavaScript range.";

/** Scan every raw JSON number so duplicate keys cannot hide an overflowing value. */
function scanJsonNumber(line: string, start: number): { end: number; value: number } | undefined {
	let end = start;
	if (line.charCodeAt(end) === 45) end++; // Optional minus sign.
	const integerStart = end;
	const firstIntegerDigit = line.charCodeAt(end);
	if (firstIntegerDigit === 48) end++;
	else if (firstIntegerDigit >= 49 && firstIntegerDigit <= 57) {
		do end++; while (line.charCodeAt(end) >= 48 && line.charCodeAt(end) <= 57);
	} else return undefined;
	if (end === integerStart) return undefined;

	if (line.charCodeAt(end) === 46) {
		end++;
		const fractionStart = end;
		while (line.charCodeAt(end) >= 48 && line.charCodeAt(end) <= 57) end++;
		if (end === fractionStart) return undefined;
	}
	const exponent = line.charCodeAt(end);
	if (exponent === 69 || exponent === 101) {
		end++;
		const sign = line.charCodeAt(end);
		if (sign === 43 || sign === 45) end++;
		const exponentStart = end;
		while (line.charCodeAt(end) >= 48 && line.charCodeAt(end) <= 57) end++;
		if (end === exponentStart) return undefined;
	}

	const next = line.charCodeAt(end);
	if (end < line.length && next !== 9 && next !== 10 && next !== 13 && next !== 32 &&
		next !== 44 && next !== 93 && next !== 125) return undefined;
	return { end, value: Number(line.slice(start, end)) };
}

function hexEscapeCodeUnit(line: string, start: number): number | undefined {
	if (start + 4 > line.length) return undefined;
	let value = 0;
	for (let index = start; index < start + 4; index++) {
		const code = line.charCodeAt(index);
		const digit = code >= 48 && code <= 57 ? code - 48
			: code >= 65 && code <= 70 ? code - 55
				: code >= 97 && code <= 102 ? code - 87 : -1;
		if (digit < 0) return undefined;
		value = (value << 4) | digit;
	}
	return value;
}

export function parseChildEvent(line: string): unknown {
	let depth = 0;
	let structuralTokens = 0;
	let inString = false;
	let escaped = false;
	for (let i = 0; i < line.length; i++) {
		const code = line.charCodeAt(i);
		if (inString) {
			if (escaped) {
				escaped = false;
				if (code === 117) { // Validate escaped UTF-16 before JSON.parse can discard duplicate fields.
					const codeUnit = hexEscapeCodeUnit(line, i + 1);
					if (codeUnit !== undefined && codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
						throw new RangeError(ILL_FORMED_UNICODE_ERROR);
					}
					if (codeUnit !== undefined && codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
						const lowEscape = i + 5;
						const lowCodeUnit = line.charCodeAt(lowEscape) === 92 && line.charCodeAt(lowEscape + 1) === 117
							? hexEscapeCodeUnit(line, lowEscape + 2) : undefined;
						if (lowCodeUnit === undefined || lowCodeUnit < 0xdc00 || lowCodeUnit > 0xdfff) {
							throw new RangeError(ILL_FORMED_UNICODE_ERROR);
						}
						i += 10; // Skip the validated low-surrogate escape.
					}
				}
			} else if (code === 92) escaped = true; // Backslash.
			else if (code === 34) inString = false; // Quote.
			else if (code >= 0xd800 && code <= 0xdbff) {
				if (i + 1 >= line.length) throw new RangeError(ILL_FORMED_UNICODE_ERROR);
				const lowSurrogate = line.charCodeAt(i + 1);
				if (lowSurrogate < 0xdc00 || lowSurrogate > 0xdfff) throw new RangeError(ILL_FORMED_UNICODE_ERROR);
				i++; // Raw JSON text may contain a well-formed surrogate pair.
			} else if (code >= 0xdc00 && code <= 0xdfff) throw new RangeError(ILL_FORMED_UNICODE_ERROR);
			continue;
		}
		if (code === 45 || (code >= 48 && code <= 57)) {
			const number = scanJsonNumber(line, i);
			if (number) {
				if (!Number.isFinite(number.value)) throw new RangeError(NON_FINITE_NUMBER_ERROR);
				i = number.end - 1;
				continue;
			}
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
	if (invalidData === "unicode") throw new RangeError(ILL_FORMED_UNICODE_ERROR);
	if (invalidData === "number") {
		// Keep a post-parse defense in depth for values such as overflowing exponents.
		throw new RangeError(NON_FINITE_NUMBER_ERROR);
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
