import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { promises as fsPromises } from 'node:fs';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { jiti } from './pi-runtime.mjs';

const { cleanupTemporaryDirectories, removeTemporaryDirectory, trackTemporaryDirectory } =
  await jiti.import('../temporary-files.ts');

test('temporary directories remain registered for process-exit cleanup after removal fails', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-subagents-cleanup-test-'));
  writeFileSync(join(directory, 'system-prompt.md'), 'temporary test prompt');
  trackTemporaryDirectory(directory);

  const failedRemoval = Object.assign(new Error('simulated temporary file lock'), { code: 'EPERM' });
  const removal = t.mock.method(fsPromises, 'rm', async () => { throw failedRemoval; });
  try {
    await removeTemporaryDirectory(directory);
    assert.equal(removal.mock.callCount(), 1);
    assert.deepEqual(removal.mock.calls[0].arguments[1], {
      recursive: true, force: true, maxRetries: 5, retryDelay: 100,
    });
    assert.equal(existsSync(directory), true, 'failed immediate removal must remain eligible for exit cleanup');
  } finally {
    removal.mock.restore();
  }

  cleanupTemporaryDirectories();
  assert.equal(existsSync(directory), false, 'fallback cleanup should remove the registered directory');
});

test('exit-time cleanup suppresses filesystem errors and retains directories for retry', () => {
  const fixture = fileURLToPath(new URL('./fixtures/temp-cleanup-exit-failure.mjs', import.meta.url));
  const output = execFileSync(process.execPath, [fixture], { encoding: 'utf8' });
  assert.deepEqual(JSON.parse(output), {
    attempts: 2, retainedAfterFailure: true, removedAfterRetry: true,
  });
});

test.after(() => {
  // Keep the suite tidy if an assertion fails before the explicit fallback runs.
  cleanupTemporaryDirectories();
});
