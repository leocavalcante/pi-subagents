import { randomUUID } from "node:crypto";

const MAX_DIAGNOSTIC_BYTES = 2048;
const DEFAULT_PROCESS_POOL_WAITERS = 32;
export const MAX_JOB_WAIT_MS = 60_000;
export const DEFAULT_JOB_WAIT_MS = 30_000;

function boundedDiagnostic(text: string, limit = MAX_DIAGNOSTIC_BYTES): string {
	// A short UTF-16 prefix is sufficient for the byte cap. Avoid encoding an
	// arbitrarily large thrown message just to keep its first few characters.
	const bytes = Buffer.from(text.slice(0, limit + 1), "utf8");
	if (text.length <= limit && bytes.length <= limit) return text;
	const notice = "\n[diagnostic truncated]";
	let end = limit - Buffer.byteLength(notice);
	while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
	return bytes.subarray(0, end).toString("utf8") + notice;
}

function describeThrown(error: unknown): string {
	try {
		return boundedDiagnostic(error instanceof Error ? String(error.message) : String(error));
	} catch {
		return "Unable to describe thrown value.";
	}
}

export type JobState = "running" | "canceling" | "completed" | "failed" | "canceled";

export interface JobSnapshot<T> {
	id: string;
	label: string;
	state: JobState;
	notify: boolean;
	startedAt: string;
	finishedAt?: string;
	latest?: T;
	error?: string;
	outputEvicted?: boolean;
}

export interface JobWaitResult<T> {
	job: JobSnapshot<T>;
	timedOut: boolean;
}

export interface JobRetention<T> {
	maxBytes: number;
	measure: (result: T) => number;
}

interface Job<T, Observation> {
	snapshot: JobSnapshot<T>;
	controller: AbortController;
	done: Promise<void>;
	retainedBytes: number;
	observation?: Observation;
	waiters: Set<() => void>;
}

/** Session-owned jobs. Turn cancellation deliberately does not own these controllers. */
export class JobManager<T, Observation = never> {
	private jobs = new Map<string, Job<T, Observation>>();
	private closed = false;

	constructor(
		private onComplete: (job: JobSnapshot<T>) => void,
		private isFailed: (result: T) => boolean,
		private maxActive = 8,
		private maxRetained = 32,
		private retention?: JobRetention<T>,
		private summarize?: (result: T) => Observation | undefined,
	) {
		if (!Number.isInteger(maxActive) || maxActive < 1) throw new Error("Active job limit must be a positive integer.");
		if (!Number.isInteger(maxRetained) || maxRetained < 0) throw new Error("Retained job limit must be a non-negative integer.");
		if (retention && (!Number.isInteger(retention.maxBytes) || retention.maxBytes < 0)) {
			throw new Error("Retained byte limit must be a non-negative integer.");
		}
	}

	start(label: string, run: (signal: AbortSignal, update: (result: T) => void) => Promise<T>, options: { notify?: boolean } = {}): JobSnapshot<T> {
		if (options.notify !== undefined && typeof options.notify !== "boolean") throw new Error("notify must be a boolean.");
		if (this.closed) throw new Error("Background jobs are unavailable after session shutdown.");
		const active = [...this.jobs.values()].filter((j) => !j.snapshot.finishedAt).length;
		if (active >= this.maxActive) throw new Error(`Too many active background jobs. Max is ${this.maxActive}.`);
		const snapshot: JobSnapshot<T> = {
			id: randomUUID(),
			label,
			state: "running",
			notify: options.notify ?? true,
			startedAt: new Date().toISOString(),
		};
		const job: Job<T, Observation> = {
			snapshot,
			controller: new AbortController(),
			done: Promise.resolve(),
			retainedBytes: 0,
			waiters: new Set(),
		};
		this.jobs.set(snapshot.id, job);
		// Defer execution so registration and the launch result precede completion delivery.
		job.done = Promise.resolve().then(async () => {
			try {
				job.controller.signal.throwIfAborted();
				const result = await run(job.controller.signal, (updated) => {
					if (!snapshot.finishedAt) {
						snapshot.latest = updated;
						this.recordObservation(job, updated);
					}
				});
				snapshot.latest = result;
				this.recordObservation(job, result);
				snapshot.state = job.controller.signal.aborted
					? "canceled"
					: this.isFailed(result)
						? "failed"
						: "completed";
			} catch (error) {
				const canceled = job.controller.signal.aborted;
				// A cooperative runner rejects with the exact abort reason. Keep the
				// canceled state, but do not present that expected control flow as a
				// job failure. Preserve distinct errors raised during cancellation.
				if (!canceled || error !== job.controller.signal.reason) snapshot.error = describeThrown(error);
				snapshot.state = canceled ? "canceled" : "failed";
			} finally {
				snapshot.finishedAt = new Date().toISOString();
				// Keep finished entries in completion order, not launch order.
				this.jobs.delete(snapshot.id);
				this.jobs.set(snapshot.id, job);
				if (!this.closed && snapshot.notify) {
					try {
						this.onComplete({ ...snapshot });
					} catch (error) {
						const delivery = `Completion delivery failed: ${describeThrown(error)}`;
						snapshot.error = snapshot.error
							? boundedDiagnostic(snapshot.error, 1023) + "\n" + boundedDiagnostic(delivery, 1024)
							: boundedDiagnostic(delivery);
					}
				}
				if (this.retention && snapshot.latest !== undefined) {
					try {
						job.retainedBytes = this.retention.measure(snapshot.latest);
						if (!Number.isFinite(job.retainedBytes) || job.retainedBytes < 0) throw new Error("Invalid retention measurement.");
						if (job.retainedBytes > this.retention.maxBytes) this.evictOutput(job);
					} catch {
						snapshot.error ??= "Output retention measurement failed.";
						this.evictOutput(job);
					}
				}
				this.prune();
				for (const notify of job.waiters) notify();
			}
		});
		return { ...snapshot };
	}

	get(id: string): JobSnapshot<T> | undefined {
		const job = this.jobs.get(id);
		return job ? { ...job.snapshot } : undefined;
	}

	/** Return a detached observation; consumers must not be able to mutate retained metadata. */
	getObservation(id: string): Observation | undefined {
		const observation = this.jobs.get(id)?.observation;
		if (observation === undefined) return undefined;
		try {
			return structuredClone(observation);
		} catch {
			// Observations are optional and must never break job inspection.
			return undefined;
		}
	}

	/** Wait for cleanup and retention without polling or retaining timed-out observers. */
	async wait(id: string, timeoutMs = DEFAULT_JOB_WAIT_MS, signal?: AbortSignal): Promise<JobWaitResult<T> | undefined> {
		if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_JOB_WAIT_MS) {
			throw new RangeError(`timeoutMs must be an integer between 1 and ${MAX_JOB_WAIT_MS}.`);
		}
		signal?.throwIfAborted();
		const job = this.jobs.get(id);
		if (!job) return undefined;
		if (job.snapshot.finishedAt) return { job: { ...job.snapshot }, timedOut: false };
		return new Promise<JobWaitResult<T>>((resolve, reject) => {
			const cleanup = () => {
				clearTimeout(timer);
				job.waiters.delete(complete);
				signal?.removeEventListener("abort", abort);
			};
			const complete = () => {
				cleanup();
				resolve({ job: { ...job.snapshot }, timedOut: false });
			};
			const abort = () => {
				cleanup();
				reject(signal?.reason ?? new Error("Job wait aborted."));
			};
			const timer = setTimeout(() => {
				cleanup();
				resolve({ job: { ...job.snapshot }, timedOut: !job.snapshot.finishedAt });
			}, timeoutMs);
			job.waiters.add(complete);
			signal?.addEventListener("abort", abort, { once: true });
		});
	}

	list(): JobSnapshot<T>[] {
		return [...this.jobs.values()].map((j) => ({ ...j.snapshot }));
	}

	cancel(id: string): JobSnapshot<T> | undefined {
		const job = this.jobs.get(id);
		if (!job) return undefined;
		if (!job.snapshot.finishedAt) {
			job.snapshot.state = "canceling";
			job.controller.abort();
		}
		return { ...job.snapshot };
	}

	forget(id: string): boolean {
		const job = this.jobs.get(id);
		if (!job) return false;
		if (!job.snapshot.finishedAt) throw new Error("Cannot forget an active job. Cancel it and wait for cleanup first.");
		return this.jobs.delete(id);
	}

	clearFinished(): number {
		let cleared = 0;
		for (const [id, job] of this.jobs) {
			if (job.snapshot.finishedAt) {
				this.jobs.delete(id);
				cleared++;
			}
		}
		return cleared;
	}

	async shutdown(): Promise<void> {
		this.closed = true; // Never deliver results into a replacement session/runtime.
		for (const job of this.jobs.values()) this.cancel(job.snapshot.id);
		await Promise.allSettled([...this.jobs.values()].map((j) => j.done));
		this.jobs.clear();
	}

	private recordObservation(job: Job<T, Observation>, result: T): void {
		if (!this.summarize) return;
		// A missing or failed summary must invalidate any earlier partial value.
		job.observation = undefined;
		try {
			const observation = this.summarize(result);
			job.observation = observation === undefined ? undefined : structuredClone(observation);
		} catch {
			// Observational metadata must never fail job execution or cleanup.
		}
	}

	private evictOutput(job: Job<T, Observation>): void {
		delete job.snapshot.latest;
		job.snapshot.outputEvicted = true;
		job.retainedBytes = 0;
	}

	private prune(): void {
		const finished = [...this.jobs.values()].filter((j) => j.snapshot.finishedAt);
		for (const job of finished.slice(0, Math.max(0, finished.length - this.maxRetained))) {
			this.jobs.delete(job.snapshot.id);
		}
		if (!this.retention) return;
		const retained = finished.filter((job) => this.jobs.has(job.snapshot.id));
		let bytes = retained.reduce((sum, job) => sum + job.retainedBytes, 0);
		for (const job of retained) {
			if (bytes <= this.retention.maxBytes) break;
			bytes -= job.retainedBytes;
			this.evictOutput(job);
		}
	}
}

/** One process budget shared by all foreground calls and background jobs. */
export class ProcessPoolCapacityError extends Error {
	constructor(maxWaiters: number) {
		super(`Subagent process queue is full (maximum ${maxWaiters} waiting tasks); retry after current work completes.`);
		this.name = "ProcessPoolCapacityError";
	}
}

export class ProcessPool {
	private active = 0;
	private waiters: Array<() => void> = [];

	constructor(private limit: number, private maxWaiters = DEFAULT_PROCESS_POOL_WAITERS) {
		if (!Number.isInteger(limit) || limit < 1) throw new Error("Process limit must be a positive integer.");
		if (!Number.isInteger(maxWaiters) || maxWaiters < 0) throw new Error("Process queue limit must be a non-negative integer.");
	}

	async acquire(signal?: AbortSignal): Promise<() => void> {
		signal?.throwIfAborted();
		if (this.active < this.limit) {
			this.active++;
		} else {
			if (this.waiters.length >= this.maxWaiters) throw new ProcessPoolCapacityError(this.maxWaiters);
			await new Promise<void>((resolve, reject) => {
				const grant = () => {
					signal?.removeEventListener("abort", abort);
					resolve(); // The releasing process transfers its occupied slot.
				};
				const abort = () => {
					this.waiters = this.waiters.filter((w) => w !== grant);
					reject(signal?.reason ?? new Error("Process request canceled."));
				};
				this.waiters.push(grant);
				signal?.addEventListener("abort", abort, { once: true });
			});
		}
		let released = false;
		const release = () => {
			if (released) return;
			released = true;
			const next = this.waiters.shift();
			if (next) next();
			else this.active--;
		};
		if (signal?.aborted) {
			release();
			signal.throwIfAborted();
		}
		return release;
	}
}
