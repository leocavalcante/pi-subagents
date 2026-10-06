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
