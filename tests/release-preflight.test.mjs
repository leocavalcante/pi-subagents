import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { inspectNpm, verifyStableRelease } from '../.github/scripts/check-release-package.mjs';

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

test('release workflow gates publishing on preflight and matrix tests while testing prereleases', () => {
  const workflow = publishWorkflow.replace(/\r\n/g, '\n');
  assert.match(workflow, /^  preflight:\n    if: github\.event\.release\.prerelease == false$/m,
    'stable releases must run the registry and metadata preflight');
  assert.match(workflow,
    /^  test:\n    needs: preflight\n    if: always\(\) && \(needs\.preflight\.result == 'success' \|\| needs\.preflight\.result == 'skipped'\)$/m,
    'matrix tests must follow preflight and still run for prereleases');
  assert.match(workflow,
    /^  publish:\n    needs: \[preflight, test\]\n    if: github\.event\.release\.prerelease == false$/m,
    'stable publishing must require both successful preflight and matrix tests');
});

test('npm inspection uses an explicit bounded registry request', () => {
  let invocation;
  const status = inspectNpm(packageJson.name, (...args) => {
    invocation = args;
    return { status: 0, stderr: '' };
  });

  assert.equal(status, 'available');
  assert.deepEqual(invocation, [
    'npm', [
      'view', packageJson.name, 'version', '--json',
      '--registry=https://registry.npmjs.org',
      '--fetch-retries=0',
      '--fetch-timeout=15000',
    ], { encoding: 'utf8' },
  ]);
});

test('npm inspection distinguishes missing packages from unavailable registry states', () => {
  for (const stderr of ['npm error E404: Not Found', '404 Not Found']) {
    assert.equal(inspectNpm(packageJson.name, () => ({ status: 1, stderr })), 'missing');
  }
  for (const result of [
    { status: 1, stderr: 'npm error E401: Unauthorized' },
    { status: 1, stderr: '' },
    { status: null, error: new Error('spawn failed') },
    { status: 0, error: new Error('spawn failed') },
  ]) {
    assert.equal(inspectNpm(packageJson.name, () => result), 'unavailable');
  }
  assert.equal(inspectNpm(packageJson.name, () => { throw new Error('spawn failed'); }), 'unavailable');
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
