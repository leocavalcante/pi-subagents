import * as fs from "node:fs";

interface TemporaryDirectoryCleanupState {
	directories: Set<string>;
	cleanupRegistered: boolean;
}

const temporaryDirectoryCleanupKey = Symbol.for("@leocavalcante/pi-subagents/temporary-directory-cleanup");
const temporaryDirectoryCleanupState = ((globalThis as any)[temporaryDirectoryCleanupKey] ??= {
	directories: new Set<string>(), cleanupRegistered: false,
}) as TemporaryDirectoryCleanupState;

/** Last-resort cleanup for temporary prompt/supervisor files left by transient filesystem errors. */
export function cleanupTemporaryDirectories(): void {
	for (const directory of temporaryDirectoryCleanupState.directories) {
		try {
			fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
			temporaryDirectoryCleanupState.directories.delete(directory);
		} catch {
			// Never expose temporary paths or prompt contents in diagnostics.
		}
	}
}

if (!temporaryDirectoryCleanupState.cleanupRegistered) {
	temporaryDirectoryCleanupState.cleanupRegistered = true;
	process.once("exit", cleanupTemporaryDirectories);
}

export function trackTemporaryDirectory(directory: string): void {
	temporaryDirectoryCleanupState.directories.add(directory);
}

export async function removeTemporaryDirectory(directory: string): Promise<void> {
	try {
		// Node retries transient Windows lock/permission errors when recursive removal is enabled.
		await fs.promises.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		temporaryDirectoryCleanupState.directories.delete(directory);
	} catch {
		// Keep it registered so process exit gets one final synchronous cleanup attempt.
	}
}
