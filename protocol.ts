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

	const usage = message.usage;
	const isCount = (value: unknown) => value === undefined ||
		(typeof value === "number" && Number.isFinite(value) && value >= 0);
	if (usage !== undefined && (!isObject(usage) ||
		![usage.input, usage.output, usage.cacheRead, usage.cacheWrite, usage.totalTokens].every(isCount) ||
		(usage.cost !== undefined && (!isObject(usage.cost) || !isCount(usage.cost.total))))) {
		return "malformed assistant usage";
	}
	return undefined;
}
