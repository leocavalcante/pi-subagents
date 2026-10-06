import { randomUUID } from "node:crypto";

const MAX_DIAGNOSTIC_BYTES = 2048;

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
	startedAt: string;
	finishedAt?: string;
	latest?: T;
	error?: string;
	outputEvicted?: boolean;
}

export interface JobRetention<T> {
	maxBytes: number;
	measure: (result: T) => number;
}

interface Job<T> {
	snapshot: JobSnapshot<T>;
	controller: AbortController;
	done: Promise<void>;
	retainedBytes: number;
}

/** Session-owned jobs. Turn cancellation deliberately does not own these controllers. */
export class JobManager<T> {
	private jobs = new Map<string, Job<T>>();
	private closed = false;

	constructor(
		private onComplete: (job: JobSnapshot<T>) => void,
		private isFailed: (result: T) => boolean,
		private maxActive = 8,
		private maxRetained = 32,
		private retention?: JobRetention<T>,
	) {
		if (!Number.isInteger(maxActive) || maxActive < 1) throw new Error("Active job limit must be a positive integer.");
		if (!Number.isInteger(maxRetained) || maxRetained < 0) throw new Error("Retained job limit must be a non-negative integer.");
		if (retention && (!Number.isInteger(retention.maxBytes) || retention.maxBytes < 0)) {
			throw new Error("Retained byte limit must be a non-negative integer.");
		}
	}

	start(label: string, run: (signal: AbortSignal, update: (result: T) => void) => Promise<T>): JobSnapshot<T> {
		if (this.closed) throw new Error("Background jobs are unavailable after session shutdown.");
		const active = [...this.jobs.values()].filter((j) => !j.snapshot.finishedAt).length;
		if (active >= this.maxActive) throw new Error(`Too many active background jobs. Max is ${this.maxActive}.`);
		const snapshot: JobSnapshot<T> = {
			id: randomUUID(),
			label,
			state: "running",
			startedAt: new Date().toISOString(),
		};
		const job: Job<T> = {
			snapshot,
			controller: new AbortController(),
			done: Promise.resolve(),
			retainedBytes: 0,
		};
		this.jobs.set(snapshot.id, job);
		// Defer execution so registration and the launch result precede completion delivery.
		job.done = Promise.resolve().then(async () => {
			try {
				job.controller.signal.throwIfAborted();
				snapshot.latest = await run(job.controller.signal, (result) => {
					if (!snapshot.finishedAt) snapshot.latest = result;
				});
				snapshot.state = job.controller.signal.aborted
					? "canceled"
					: this.isFailed(snapshot.latest)
						? "failed"
						: "completed";
			} catch (error) {
				snapshot.error = describeThrown(error);
				snapshot.state = job.controller.signal.aborted ? "canceled" : "failed";
			} finally {
				snapshot.finishedAt = new Date().toISOString();
				// Keep finished entries in completion order, not launch order.
				this.jobs.delete(snapshot.id);
				this.jobs.set(snapshot.id, job);
				if (!this.closed) {
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
			}
		});
		return { ...snapshot };
	}

	get(id: string): JobSnapshot<T> | undefined {
		const job = this.jobs.get(id);
		return job ? { ...job.snapshot } : undefined;
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

	private evictOutput(job: Job<T>): void {
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
export class ProcessPool {
	private active = 0;
	private waiters: Array<() => void> = [];

	constructor(private limit: number) {
		if (!Number.isInteger(limit) || limit < 1) throw new Error("Process limit must be a positive integer.");
	}

	async acquire(signal?: AbortSignal): Promise<() => void> {
		signal?.throwIfAborted();
		if (this.active < this.limit) {
			this.active++;
		} else {
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
