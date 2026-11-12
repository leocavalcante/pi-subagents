import assert from 'node:assert/strict';
import test from 'node:test';
import { jiti } from './pi-runtime.mjs';
const { DEFAULT_PROGRESS_UPDATE_INTERVAL_MS, ProgressUpdateLimiter } = await jiti.import('../progress.ts');

test('progress limiter emits immediately and then no more often than its interval', () => {
  const limiter = new ProgressUpdateLimiter();
  assert.equal(DEFAULT_PROGRESS_UPDATE_INTERVAL_MS, 100);
  assert.equal(limiter.shouldUpdate(10), true, 'the first update is immediate');
  assert.equal(limiter.shouldUpdate(10), false);
  assert.equal(limiter.shouldUpdate(109.99), false);
  assert.equal(limiter.shouldUpdate(110), true, 'an update is allowed at the interval boundary');
  assert.equal(limiter.shouldUpdate(209), false);
  assert.equal(limiter.shouldUpdate(210), true);
});

test('progress limiter accepts a deterministic clock and validates its inputs', () => {
  let now = 5;
  const limiter = new ProgressUpdateLimiter(25);
  assert.equal(limiter.shouldUpdate(now), true);
  now = 29;
  assert.equal(limiter.shouldUpdate(now), false);
  now = 30;
  assert.equal(limiter.shouldUpdate(now), true);
  assert.throws(() => new ProgressUpdateLimiter(-1), /interval/);
  assert.throws(() => new ProgressUpdateLimiter(Infinity), /interval/);
  assert.throws(() => limiter.shouldUpdate(NaN), /time/);
});

test('a forced final update flushes pending progress and starts a fresh interval', () => {
  const limiter = new ProgressUpdateLimiter(100);
  assert.equal(limiter.shouldUpdate(0), true);
  assert.equal(limiter.shouldUpdate(20), false);
  assert.equal(limiter.shouldUpdate(20, true), true);
  assert.equal(limiter.shouldUpdate(119), false);
  assert.equal(limiter.shouldUpdate(120), true);
});
