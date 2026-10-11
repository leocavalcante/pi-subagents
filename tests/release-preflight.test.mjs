import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyStableRelease } from '../.github/scripts/check-release-package.mjs';

const packageJson = { name: '@leocavalcante/pi-subagents', version: '0.1.0' };

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
