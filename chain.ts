export const CHAIN_ID_PATTERN = "^[A-Za-z][A-Za-z0-9_-]{0,63}$";
const VALID_ID = new RegExp(CHAIN_ID_PATTERN);
const CONTEXT_PLACEHOLDERS = /\{previous\}|\{steps\.([^{}]*)\}/g;

/** Named outputs can only come from earlier steps; validate the complete request before dispatch. */
export function validateChainReferences(steps: ReadonlyArray<{ id?: unknown; task: string }>): string | undefined {
	const available = new Set<string>();
	for (const [index, step] of steps.entries()) {
		if (step.id !== undefined) {
			if (typeof step.id !== "string" || !VALID_ID.test(step.id)) {
				return `Invalid chain step ID at step ${index + 1}. Use 1–64 characters: a leading ASCII letter, then letters, digits, underscores, or hyphens.`;
			}
			if (available.has(step.id)) return `Duplicate chain step ID at step ${index + 1}. IDs must be unique.`;
		}
		for (const match of step.task.matchAll(CONTEXT_PLACEHOLDERS)) {
			if (match[1] !== undefined && (!VALID_ID.test(match[1]) || !available.has(match[1]))) {
				return `Invalid chain output reference at step ${index + 1}. Reference an ID from an earlier step.`;
			}
		}
		if (typeof step.id === "string") available.add(step.id);
	}
	return undefined;
}

/** One pass: inserted output stays literal, including dollar sequences and other placeholders. */
export function substituteChainContext(task: string, previous: string, outputs: ReadonlyMap<string, string>): string {
	return task.replace(CONTEXT_PLACEHOLDERS, (_match, id: string | undefined) => {
		if (id === undefined) return previous;
		const output = outputs.get(id);
		if (output === undefined) throw new Error("Named chain output is unavailable.");
		return output;
	});
}

/** Check expanded UTF-8 size before allocating the substituted task. */
export function substituteChainContextBounded(
	task: string,
	previous: string,
	outputs: ReadonlyMap<string, string>,
	maxBytes: number,
): string | undefined {
	if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new RangeError("Invalid chain task byte limit.");

	let expandedBytes = Buffer.byteLength(task, "utf8");
	let previousBytes: number | undefined;
	const namedOutputBytes = new Map<string, number>();
	let previousCodeUnit: number | undefined;
	let templateOffset = 0;
	const joinBoundary = (first: number, last: number) => {
		// Separate UTF-8 encodings count two adjacent unpaired surrogates as six
		// bytes; once joined, the pair encodes as four.
		if (previousCodeUnit !== undefined && previousCodeUnit >= 0xd800 && previousCodeUnit <= 0xdbff &&
			first >= 0xdc00 && first <= 0xdfff) expandedBytes -= 2;
		previousCodeUnit = last;
	};
	for (const match of task.matchAll(CONTEXT_PLACEHOLDERS)) {
		const start = match.index;
		if (start === undefined) throw new Error("Chain placeholder position is unavailable.");
		if (start > templateOffset) joinBoundary(task.charCodeAt(templateOffset), task.charCodeAt(start - 1));
		const id = match[1] as string | undefined;
		let replacement: string;
		let replacementBytes: number;
		if (id === undefined) {
			replacement = previous;
			previousBytes ??= Buffer.byteLength(replacement, "utf8");
			replacementBytes = previousBytes;
		} else {
			const output = outputs.get(id);
			if (output === undefined) throw new Error("Named chain output is unavailable.");
			replacement = output;
			let byteLength = namedOutputBytes.get(id);
			if (byteLength === undefined) {
				byteLength = Buffer.byteLength(replacement, "utf8");
				namedOutputBytes.set(id, byteLength);
			}
			replacementBytes = byteLength;
		}
		expandedBytes += replacementBytes - match[0].length;
		if (replacement.length > 0) joinBoundary(replacement.charCodeAt(0), replacement.charCodeAt(replacement.length - 1));
		templateOffset = start + match[0].length;
		if (!Number.isSafeInteger(expandedBytes)) return undefined;
	}
	if (templateOffset < task.length) joinBoundary(task.charCodeAt(templateOffset), task.charCodeAt(task.length - 1));
	if (expandedBytes > maxBytes) return undefined;
	return substituteChainContext(task, previous, outputs);
}
