import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { verifyStableRelease } from '../.github/scripts/check-release-package.mjs';

const packageJson = { name: '@leocavalcante/pi-subagents', version: '0.1.0' };
const publishWorkflow = readFileSync(new URL('../.github/workflows/publish.yml', import.meta.url), 'utf8');

function assertReleaseCheckoutsPinned(source) {
  const workflow = source.replace(/\r\n/g, '\n');
  const checkouts = [...workflow.matchAll(/^      - uses: actions\/checkout@[^\n]*\n((?: {8,}[^\n]*\n)*)/gm)];
  assert.equal(checkouts.length, 2, 'preflight and publish each need a checkout');
  for (const [, step] of checkouts) {
    const inputs = step.match(/^        with:\n((?: {10,}[^\n]*\n)*)/m);
    assert.ok(inputs, 'checkout must have explicit inputs');
    assert.match(inputs[1], /^          ref: \$\{\{ github\.sha \}\}$/m,
      'checkout must be pinned to the release event commit');
  }
}

test('release jobs check out the immutable event commit across platform line endings', () => {
  const normalized = publishWorkflow.replace(/\r\n/g, '\n');
  assertReleaseCheckoutsPinned(normalized);
  assertReleaseCheckoutsPinned(normalized.replace(/\n/g, '\r\n'));
});

test('release preflight validates stable version tags before querying npm', () => {
  let queries = 0;
  assert.throws(() => verifyStableRelease(packageJson, 'v0.2.0', () => { queries++; return 'available'; }), /tag matching/);
  assert.equal(queries, 0);
  assert.throws(() => verifyStableRelease({ ...packageJson, version: '0.1.0-beta.1' }, 'v0.1.0-beta.1'), /stable release/);
});

test('release preflight gives bootstrap guidance when the npm package is missing', () => {
  const queries = [];
  assert.throws(() => verifyStableRelease(packageJson, 'v0.1.0', specifier => {
    queries.push(specifier);
    return 'missing';
  }), /not bootstrapped.*CONTRIBUTING/);
  assert.deepEqual(queries, [packageJson.name]);
});

test('release preflight fails closed when npm registry state is unavailable', () => {
  assert.throws(() => verifyStableRelease(packageJson, 'v0.1.0', () => 'unavailable'), /Unable to verify.*registry/);
  assert.throws(() => verifyStableRelease(packageJson, 'v0.1.0', specifier =>
    specifier === packageJson.name ? 'available' : 'unavailable'), /Unable to verify/);
});

test('release preflight rejects an already-published version and accepts a fresh one', () => {
  const queries = [];
  assert.throws(() => verifyStableRelease(packageJson, 'v0.1.0', specifier => {
    queries.push(specifier);
    return 'available';
  }), /already exists on npm/);
  assert.deepEqual(queries, [packageJson.name, `${packageJson.name}@${packageJson.version}`]);

  queries.length = 0;
  assert.doesNotThrow(() => verifyStableRelease(packageJson, 'v0.1.0', specifier => {
    queries.push(specifier);
    return specifier === packageJson.name ? 'available' : 'missing';
  }));
  assert.deepEqual(queries, [packageJson.name, `${packageJson.name}@${packageJson.version}`]);
});
