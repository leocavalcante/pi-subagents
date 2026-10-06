import assert from 'node:assert/strict';
import test from 'node:test';
import { jiti } from './pi-runtime.mjs';
const { usageError, normalizeUsage, sumUsage } = await jiti.import('../usage.ts');

test('validates every consumed token and cost field without exposing payloads', () => {
  for (const field of ['input', 'output', 'cacheRead', 'cacheWrite', 'cacheWrite1h', 'reasoning', 'totalTokens']) {
    for (const value of [-1, Infinity, NaN, null, 'private']) assert.equal(usageError({ [field]: value }), 'malformed usage');
  }
  for (const field of ['input', 'output', 'cacheRead', 'cacheWrite', 'total']) {
    assert.equal(usageError({ cost: { [field]: 'private' } }), 'malformed usage');
  }
  for (const value of [null, [], { cost: [] }]) assert.ok(usageError(value));
  assert.equal(usageError(undefined), undefined);
  assert.equal(usageError({}), undefined);
});

test('normalizes sparse usage without double-counting optional subsets or overriding totals', () => {
  const usage = normalizeUsage({ input: 1, output: 10, reasoning: 3, cacheRead: 2, cacheWrite: 4, cacheWrite1h: 2,
    cost: { input: 0.25, output: 0.75 } });
  assert.equal(usage.totalTokens, 17);
  assert.equal(usage.cost.total, 1);
  assert.equal(usage.reasoning, 3);
  assert.equal(usage.cacheWrite1h, 2);
  const explicit = normalizeUsage({ input: 5, totalTokens: 0, cost: { input: 1, total: 0 } });
  assert.equal(explicit.totalTokens, 0);
  assert.equal(explicit.cost.total, 0);
});

test('sums usage in fresh objects, preserves optional fields and rejects arithmetic overflow', () => {
  const original = normalizeUsage({ input: 2, reasoning: 1, cacheWrite1h: 0, cost: { total: 0.5 } });
  const copy = structuredClone(original);
  const result = sumUsage([original, original]);
  assert.equal(result.input, 4);
  assert.equal(result.reasoning, 2);
  assert.equal(result.cacheWrite1h, 0);
  assert.equal(result.cost.total, 1);
  assert.deepEqual(original, copy);
  assert.equal(sumUsage([]).reasoning, undefined);
  const huge = normalizeUsage({ input: 1e308 });
  assert.throws(() => sumUsage([huge, huge]), /finite numeric/);
  assert.equal(huge.input, 1e308);
  assert.throws(() => normalizeUsage({ input: 1e308, output: 1e308 }), /finite numeric/);
});
