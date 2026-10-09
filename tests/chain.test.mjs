import assert from 'node:assert/strict';
import test from 'node:test';
import { jiti } from './pi-runtime.mjs';
const { validateChainReferences, substituteChainContext, substituteChainContextBounded } = await jiti.import('../chain.ts');

test('named references accept only earlier unique IDs with a bounded identifier format', () => {
  assert.equal(validateChainReferences([{ id: 'review-1', task: 'first' }, { task: '{steps.review-1} {previous}' }]), undefined);
  assert.equal(validateChainReferences([{ id: 'constructor', task: 'first' }, { task: '{steps.constructor}' }]), undefined);
  for (const chain of [
    [{ id: '', task: 'first' }], [{ id: 'x'.repeat(65), task: 'first' }], [{ id: 42, task: 'first' }],
    [{ id: 'bad.id', task: 'first' }], [{ id: 'same', task: 'first' }, { id: 'same', task: 'second' }],
    [{ id: 'self', task: '{steps.self}' }], [{ task: '{steps.future}' }, { id: 'future', task: 'second' }],
    [{ task: '{steps.unknown}' }], [{ task: '{steps.}' }], [{ task: '{steps.invalid name}' }],
  ]) assert.ok(validateChainReferences(chain));
});

test('bounded substitution counts UTF-8 bytes and retains literal one-pass behavior', () => {
  const namedOutput = '$& {previous}';
  const outputs = new Map([['first', namedOutput]]);
  assert.equal(substituteChainContextBounded('{steps.first}', '', outputs, Buffer.byteLength(namedOutput)), namedOutput);
  assert.equal(substituteChainContextBounded('{previous}', '€', new Map(), 3), '€');
  assert.equal(substituteChainContextBounded('{previous}', '€', new Map(), 2), undefined);
  const high = '\uD83D';
  const low = '\uDE00';
  assert.equal(Buffer.byteLength(high + low, 'utf8'), 4);
  assert.equal(substituteChainContextBounded(`${high}{previous}`, low, new Map(), 4), high + low);
  assert.throws(() => substituteChainContextBounded('x', '', new Map(), -1), /byte limit/);
});

test('oversized repeated context is rejected without materializing the expanded string', () => {
  const template = '{steps.large}'.repeat(100_000);
  const largeOutput = 'x'.repeat(4 * 1024 * 1024);
  const result = substituteChainContextBounded(template, '', new Map([['large', largeOutput]]), 4 * 1024 * 1024);
  assert.equal(result, undefined);
});

test('substitution is literal, one-pass, and keeps unrelated brace syntax unchanged', () => {
  const output = '$& $$ $` $\' {previous} {steps.other}';
  const outputs = new Map([['first', output], ['other', 'must not expand inserted text'], ['constructor', 'safe']]);
  assert.equal(substituteChainContext('{steps.first}|{previous}|{steps.first}|{thing}', 'last', outputs), `${output}|last|${output}|{thing}`);
  assert.equal(substituteChainContext('{steps.constructor}', '', outputs), 'safe');
  assert.equal(substituteChainContext('{steps.empty}', 'not empty', new Map([['empty', '']])), '');
  assert.equal(substituteChainContext('{previous}', '', new Map()), '');
  assert.throws(() => substituteChainContext('{steps.missing}', '', outputs), /unavailable/);
});
