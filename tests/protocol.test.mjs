import assert from 'node:assert/strict';
import test from 'node:test';
import { jiti } from './pi-runtime.mjs';
const { assistantMessageError, isCapturedMessageRole, parseChildEvent, MAX_JSON_STRUCTURE_TOKENS, toolResultMessageError, userMessageError } = await jiti.import('../protocol.ts');
const message = extra => ({ content: [{ type: 'text', text: 'answer' }], stopReason: 'stop', ...extra });

test('captures only result-relevant roles while leaving Pi AgentMessage roles extensible', () => {
  for (const role of ['assistant', 'user', 'toolResult']) assert.equal(isCapturedMessageRole(role), true);
  for (const role of ['system', 'custom', 'bashExecution', 'branchSummary', 'compactionSummary', 'extensionNotice']) {
    assert.equal(isCapturedMessageRole(role), false);
  }
  assert.equal(isCapturedMessageRole(undefined), false);
});

test('JSON nesting is bounded without counting brackets inside escaped strings', () => {
  const value = { text: '[{\\\\\\"'.repeat(300), nested: { ok: true } };
  assert.deepEqual(parseChildEvent(JSON.stringify(value)), value);
  assert.doesNotThrow(() => parseChildEvent('['.repeat(128) + '0' + ']'.repeat(128)));
  assert.throws(() => parseChildEvent('['.repeat(129) + '0' + ']'.repeat(129)), /nesting exceeded 128/);
  assert.throws(() => parseChildEvent('{bad}'), SyntaxError);
});

test('JSON structural breadth is bounded before parsing and punctuation inside strings is ignored', () => {
  const atLimit = `[${'0,'.repeat(MAX_JSON_STRUCTURE_TOKENS - 1)}0]`;
  assert.equal(parseChildEvent(atLimit).length, MAX_JSON_STRUCTURE_TOKENS);

  const overLimit = `[${'0,'.repeat(MAX_JSON_STRUCTURE_TOKENS)}0]`;
  const originalParse = JSON.parse;
  let parsed = false;
  JSON.parse = (...args) => { parsed = true; return originalParse(...args); };
  try {
    assert.throws(() => parseChildEvent(overLimit), /structure exceeded 65536 tokens/);
    assert.equal(parsed, false, 'The breadth check must reject before allocating the parsed tree');
  } finally {
    JSON.parse = originalParse;
  }
  const broadObject = `{${'"key":0,'.repeat(MAX_JSON_STRUCTURE_TOKENS / 2)}"key":0}`;
  assert.throws(() => parseChildEvent(broadObject), /structure exceeded 65536 tokens/);

  const punctuation = `[]{}:,\\"`.repeat(20_000);
  assert.deepEqual(parseChildEvent(JSON.stringify({ text: punctuation })), { text: punctuation });
});

test('rejects JSON strings and keys containing escaped unpaired surrogates', () => {
  const unpaired = String.fromCharCode(0xd800);
  const escapedPair = `${String.fromCharCode(92)}uD800${String.fromCharCode(92)}uDC00`;
  assert.deepEqual(parseChildEvent(JSON.stringify({ text: '😀' })), { text: '😀' });
  assert.deepEqual(parseChildEvent(`{"text":"${escapedPair}"}`), { text: '𐀀' });
  assert.deepEqual(parseChildEvent('{"text":"first","text":"safe"}'), { text: 'safe' });
  assert.throws(() => parseChildEvent(JSON.stringify({ text: unpaired })), /ill-formed Unicode/);
  assert.throws(() => parseChildEvent(JSON.stringify({ nested: [unpaired] })), /ill-formed Unicode/);
  assert.throws(() => parseChildEvent(JSON.stringify({ [unpaired]: 'value' })), /ill-formed Unicode/);
  assert.throws(() => parseChildEvent(`{"text":"${unpaired}"}`), /ill-formed Unicode/);
  assert.throws(() => parseChildEvent(`{"text":${JSON.stringify(unpaired)},"text":"safe"}`),
    /ill-formed Unicode/, 'validate malformed values before JSON.parse overwrites duplicate keys');
});

test('rejects parsed numbers outside the finite JavaScript range at any depth', () => {
  assert.deepEqual(parseChildEvent('{"value":1e308,"nested":[-1e308]}'), { value: 1e308, nested: [-1e308] });
  assert.throws(() => parseChildEvent('{"value":1e400}'), /outside the finite JavaScript range/);
  assert.throws(() => parseChildEvent('{"nested":[{"value":-1e400}]}'), /outside the finite JavaScript range/);
});

test('accepts completed messages, redacted thinking, and arbitrary tool arguments', () => {
  assert.equal(assistantMessageError(message()), undefined);
  assert.equal(assistantMessageError(message({ content: [{ type: 'thinking', redacted: true, thinkingSignature: 'opaque' }] })), undefined);
  assert.equal(assistantMessageError(message({ content: [{ type: 'toolCall', id: 'call', name: 'bash', arguments: { command: 42 } }] })), undefined);
});

test('rejects malformed consumed metadata and non-terminal stop reasons without payload excerpts', () => {
  for (const extra of [{ errorMessage: { private: 'payload' } }, { model: [] }, { stopReason: 'pending' }, { stopReason: undefined }]) {
    const error = assistantMessageError(message(extra));
    assert.ok(error);
    assert.equal(error.includes('payload'), false);
  }
});

test('rejects invalid usage and content while allowing optional usage', () => {
  for (const extra of [
    { usage: { output: -1 } }, { usage: { input: 0.5 } },
    { usage: { totalTokens: Number.MAX_SAFE_INTEGER + 1 } },
    { usage: { cost: { total: 'bad' } } }, { usage: null },
    { content: [{ type: 'text', text: null }] }, { content: [{ type: 'toolCall', name: 'bash', arguments: {} }] },
  ]) assert.ok(assistantMessageError(message(extra)));
});

test('validates user message text and image content before retaining child events', () => {
  assert.equal(userMessageError({ role: 'user', content: 'task' }), undefined);
  assert.equal(userMessageError({ role: 'user', content: [
    { type: 'text', text: 'task' }, { type: 'image', data: 'AA==', mimeType: 'image/png' },
  ] }), undefined);
  for (const malformed of [
    null,
    { role: 'assistant', content: 'task' },
    { role: 'user', content: null },
    { role: 'user', content: [{ type: 'text', text: 42 }] },
    { role: 'user', content: [{ type: 'image', data: 'AA==' }] },
  ]) assert.ok(userMessageError(malformed));
});

test('validates tool-result metadata, content blocks, and nested usage', () => {
  const valid = { role: 'toolResult', toolCallId: 'call', toolName: 'read', content: [{ type: 'text', text: 'ok' }], isError: false };
  assert.equal(toolResultMessageError(valid), undefined);
  assert.equal(toolResultMessageError({ ...valid, content: [{ type: 'image', data: 'AA==', mimeType: 'image/png' }] }), undefined);
  for (const malformed of [
    { ...valid, toolCallId: undefined },
    { ...valid, toolName: null },
    { ...valid, isError: 0 },
    { ...valid, content: null },
    { ...valid, content: [{ type: 'text', text: 42 }] },
    { ...valid, content: [{ type: 'image', data: 'AA==' }] },
    { ...valid, usage: { input: 0.5 } },
    { ...valid, usage: { cost: { total: 'private payload' } } },
  ]) {
    const error = toolResultMessageError(malformed);
    assert.ok(error);
    assert.equal(error.includes('private payload'), false);
  }
});
