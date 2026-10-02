import { randomUUID } from "node:crypto";

export type JobState = "running" | "canceling" | "completed" | "failed" | "canceled";

export interface JobSnapshot<T> {
	id: string;
	label: string;
	state: JobState;
	startedAt: string;
	finishedAt?: string;
	latest?: T;
	error?: string;
}

interface Job<T> {
	snapshot: JobSnapshot<T>;
	controller: AbortController;
	done: Promise<void>;
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
	) {}

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
		};
		this.jobs.set(snapshot.id, job);
		// Defer execution so registration and the launch result precede completion delivery.
		job.done = Promise.resolve().then(async () => {
			try {
				job.controller.signal.throwIfAborted();
				snapshot.latest = await run(job.controller.signal, (result) => {
					snapshot.latest = result;
				});
				snapshot.state = job.controller.signal.aborted
					? "canceled"
					: this.isFailed(snapshot.latest)
						? "failed"
						: "completed";
			} catch (error) {
				snapshot.error = error instanceof Error ? error.message : String(error);
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
						snapshot.error = `Completion delivery failed: ${error instanceof Error ? error.message : String(error)}`;
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

	async shutdown(): Promise<void> {
		this.closed = true; // Never deliver results into a replacement session/runtime.
		for (const job of this.jobs.values()) this.cancel(job.snapshot.id);
		await Promise.allSettled([...this.jobs.values()].map((j) => j.done));
		this.jobs.clear();
	}

	private prune(): void {
		const finished = [...this.jobs.values()].filter((j) => j.snapshot.finishedAt);
		for (const job of finished.slice(0, Math.max(0, finished.length - this.maxRetained))) {
			this.jobs.delete(job.snapshot.id);
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
