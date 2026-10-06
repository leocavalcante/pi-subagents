import assert from 'node:assert/strict';
import test from 'node:test';
import { jiti } from './pi-runtime.mjs';
const { assistantMessageError } = await jiti.import('../protocol.ts');
const message = extra => ({ content: [{ type: 'text', text: 'answer' }], stopReason: 'stop', ...extra });

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
    { usage: { output: -1 } }, { usage: { cost: { total: 'bad' } } }, { usage: null },
    { content: [{ type: 'text', text: null }] }, { content: [{ type: 'toolCall', name: 'bash', arguments: {} }] },
  ]) assert.ok(assistantMessageError(message(extra)));
});
