/** Bound best-effort host updates without throttling child-event capture. */
export const DEFAULT_PROGRESS_UPDATE_INTERVAL_MS = 100;

export class ProgressUpdateLimiter {
	private lastUpdateAt = Number.NEGATIVE_INFINITY;

	constructor(private intervalMs = DEFAULT_PROGRESS_UPDATE_INTERVAL_MS) {
		if (!Number.isFinite(intervalMs) || intervalMs < 0) {
			throw new RangeError("Progress update interval must be a non-negative finite number.");
		}
	}

	shouldUpdate(now: number, force = false): boolean {
		if (!Number.isFinite(now)) throw new RangeError("Progress update time must be finite.");
		if (!force && now - this.lastUpdateAt < this.intervalMs) return false;
		this.lastUpdateAt = now;
		return true;
	}
}
