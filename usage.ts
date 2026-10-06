import type { Usage } from "@earendil-works/pi-ai";

const TOKEN_FIELDS = ["input", "output", "cacheRead", "cacheWrite", "totalTokens", "cacheWrite1h", "reasoning"] as const;
const COST_FIELDS = ["input", "output", "cacheRead", "cacheWrite", "total"] as const;

function isObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Validate only consumed fields, without including provider payloads in diagnostics. */
export function usageError(value: unknown): string | undefined {
	if (value === undefined) return undefined;
	const valid = (count: unknown) => count === undefined ||
		(typeof count === "number" && Number.isFinite(count) && count >= 0);
	if (!isObject(value) || !TOKEN_FIELDS.every((field) => valid(value[field]))) return "malformed usage";
	const cost = value.cost;
	if (cost !== undefined && (!isObject(cost) || !COST_FIELDS.every((field) => valid(cost[field])))) {
		return "malformed usage";
	}
	return undefined;
}

function finiteSum(values: number[]): number {
	const total = values.reduce((sum, value) => sum + value, 0);
	if (!Number.isFinite(total)) throw new RangeError("Subagent usage totals exceed finite numeric limits.");
	return total;
}

/** Older streams may omit fields; preserve explicit totals and optional subset counters. */
export function normalizeUsage(value: unknown): Usage {
	if (usageError(value)) throw new TypeError("Malformed subagent usage.");
	const raw = value as Partial<Usage> | undefined;
	const cost = {
		input: raw?.cost?.input ?? 0,
		output: raw?.cost?.output ?? 0,
		cacheRead: raw?.cost?.cacheRead ?? 0,
		cacheWrite: raw?.cost?.cacheWrite ?? 0,
		total: raw?.cost?.total ?? finiteSum(COST_FIELDS.filter((field) => field !== "total").map((field) => raw?.cost?.[field] ?? 0)),
	};
	const result: Usage = {
		input: raw?.input ?? 0, output: raw?.output ?? 0,
		cacheRead: raw?.cacheRead ?? 0, cacheWrite: raw?.cacheWrite ?? 0,
		totalTokens: raw?.totalTokens ?? finiteSum([raw?.input ?? 0, raw?.output ?? 0, raw?.cacheRead ?? 0, raw?.cacheWrite ?? 0]),
		cost,
	};
	if (raw?.cacheWrite1h !== undefined) result.cacheWrite1h = raw.cacheWrite1h;
	if (raw?.reasoning !== undefined) result.reasoning = raw.reasoning;
	return result;
}

/** Returns a fresh total. Failed additions never corrupt already captured usage. */
export function sumUsage(values: Iterable<Usage>): Usage {
	const total = normalizeUsage(undefined);
	for (const value of values) {
		for (const field of TOKEN_FIELDS) {
			if (total[field] !== undefined || value[field] !== undefined) {
				total[field] = finiteSum([total[field] ?? 0, value[field] ?? 0]);
			}
		}
		for (const field of COST_FIELDS) total.cost[field] = finiteSum([total.cost[field], value.cost[field]]);
	}
	return total;
}
