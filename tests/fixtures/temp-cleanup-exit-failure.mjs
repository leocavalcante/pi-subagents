import assert from 'node:assert/strict';
import { syncBuiltinESMExports } from 'node:module';
import fs, { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jiti } from '../pi-runtime.mjs';

const { cleanupTemporaryDirectories, trackTemporaryDirectory } = await jiti.import('../temporary-files.ts');
const directory = mkdtempSync(join(tmpdir(), 'pi-subagents-exit-cleanup-test-'));
writeFileSync(join(directory, 'system-prompt.md'), 'temporary test prompt');
trackTemporaryDirectory(directory);

const originalRmSync = fs.rmSync;
let attempts = 0;
fs.rmSync = (...args) => {
  attempts++;
  if (attempts === 1) throw new Error('simulated temporary file lock');
  return originalRmSync(...args);
};
syncBuiltinESMExports();
try {
  assert.doesNotThrow(cleanupTemporaryDirectories, 'exit cleanup must not abort process shutdown');
  const retainedAfterFailure = existsSync(directory);
  cleanupTemporaryDirectories();
  const removedAfterRetry = !existsSync(directory);
  assert.equal(attempts, 2);
  assert.deepEqual({ retainedAfterFailure, removedAfterRetry }, { retainedAfterFailure: true, removedAfterRetry: true });
  process.stdout.write(JSON.stringify({ attempts, retainedAfterFailure, removedAfterRetry }));
} finally {
  fs.rmSync = originalRmSync;
  syncBuiltinESMExports();
}
