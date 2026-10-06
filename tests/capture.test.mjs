import assert from 'node:assert/strict';
import test from 'node:test';
import { jiti } from './pi-runtime.mjs';
const { JsonLineCapture, TextCapture, MessageCapture } = await jiti.import('../capture.ts');

test('JSON capture handles chunk boundaries, CRLF, Unicode separators, and final records', () => {
  const lines = [];
  const reader = new JsonLineCapture(line => lines.push(line), () => assert.fail('overflow'), 100);
  reader.append('{"text":"é\u2028');
  reader.append('\u2029"}\r\n');
  reader.append('tail');
  reader.finish();
  reader.finish();
  assert.deepEqual(lines, ['{"text":"é\u2028\u2029"}\r', 'tail']);
});

test('oversized JSON records are discarded until LF without losing following records', () => {
  const lines = [];
  let overflow = 0;
  const reader = new JsonLineCapture(line => lines.push(line), () => overflow++, 8);
  reader.append('éééé'); // Exactly eight UTF-8 bytes.
  reader.append('é');
  for (let i = 0; i < 100; i++) reader.append('x'.repeat(1000));
  reader.append('\nvalid\nsecond');
  reader.finish();
  assert.equal(overflow, 1);
  assert.deepEqual(lines, ['valid', 'second']);
});

test('an oversized unterminated record is not parsed at end of stream', () => {
  let overflow = 0;
  const reader = new JsonLineCapture(() => assert.fail('oversized line parsed'), () => overflow++, 8);
  reader.append('x'.repeat(1000));
  reader.finish();
  assert.equal(overflow, 1);
});

test('stderr stays within its byte cap and does not split Unicode', () => {
  const capture = new TextCapture(64);
  capture.append('é'.repeat(20));
  assert.equal(capture.text, 'é'.repeat(20));
  capture.append('😀'.repeat(20));
  capture.append('ignored tail');
  assert.equal(capture.truncated, true);
  assert.match(capture.text, /stderr capture truncated/);
  assert.ok(Buffer.byteLength(capture.text) <= 64);
  assert.equal(capture.text.includes('\uFFFD'), false);
});

test('tiny diagnostic budgets remain bounded and invalid limits are rejected', () => {
  const capture = new TextCapture(4);
  capture.append('x'.repeat(100));
  assert.ok(Buffer.byteLength(capture.text) <= 4);
  for (const limit of [0, -1, 1.5, Infinity]) {
    assert.throws(() => new TextCapture(limit), /positive integers/);
    assert.throws(() => new JsonLineCapture(() => {}, () => {}, limit), /positive integers/);
    assert.throws(() => new MessageCapture(limit, 1), /positive integers/);
    assert.throws(() => new MessageCapture(10, limit), /positive integers/);
  }
});

test('message history enforces both byte and count budgets and keeps the latest message', () => {
  const history = new MessageCapture(10, 2);
  history.push('first', 4);
  history.push('second', 4);
  history.push('third', 4);
  assert.deepEqual(history.messages, ['second', 'third']);
  assert.equal(history.dropped, 1);
  history.push('final', 8);
  assert.deepEqual(history.messages, ['final']);
  assert.equal(history.dropped, 3);
});
