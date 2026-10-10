import assert from 'node:assert/strict';
import test from 'node:test';
import { jiti } from './pi-runtime.mjs';
const { BoundedByteStream, JsonLineCapture, TextCapture, MessageCapture, MAX_CHILD_JSON_RECORDS, MAX_CHILD_STDOUT_BYTES } = await jiti.import('../capture.ts');

test('cumulative byte streams accept the exact limit, then notify once and drain without parsing', () => {
  const chunks = [];
  let overflow = 0;
  const stream = new BoundedByteStream(5, chunk => chunks.push(chunk.toString()), () => overflow++);
  stream.append(Buffer.from('123'));
  stream.append(Buffer.from('45'));
  assert.equal(stream.totalBytes, 5);
  assert.equal(stream.limitExceeded, false);
  stream.append(Buffer.from('6'));
  stream.append(Buffer.from('later chunks are drained but not parsed'));
  assert.deepEqual(chunks, ['123', '45']);
  assert.equal(stream.totalBytes, 5);
  assert.equal(stream.limitExceeded, true);
  assert.equal(overflow, 1);
  assert.equal(MAX_CHILD_JSON_RECORDS, 100_000);
  assert.equal(MAX_CHILD_STDOUT_BYTES, 128 * 1024 * 1024);
});

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

test('JSON record-count limit stops parsing excess blank lines in the same chunk', () => {
  const lines = [];
  let exceeded = 0;
  const reader = new JsonLineCapture(line => lines.push(line), () => assert.fail('record count is not a byte overflow'),
    100, () => {}, 3, () => exceeded++);
  reader.append(Buffer.alloc(100_000, 0x0a));
  reader.append(Buffer.from('ignored\n'));
  reader.finish();
  assert.deepEqual(lines, ['', '', '']);
  assert.equal(exceeded, 1);
});

test('JSON record-count limit includes final unterminated records', () => {
  const lines = [];
  let exceeded = 0;
  const reader = new JsonLineCapture(line => lines.push(line), () => assert.fail('record count is not a byte overflow'),
    100, () => {}, 2, () => exceeded++);
  reader.append('first\nsecond\nthird');
  reader.finish();
  assert.deepEqual(lines, ['first', 'second']);
  assert.equal(exceeded, 1);
});

test('byte JSON capture rejects malformed and truncated UTF-8 records, then recovers', () => {
  const lines = [];
  let invalid = 0;
  let overflow = 0;
  const reader = new JsonLineCapture(line => lines.push(line), () => overflow++, 100, () => invalid++);
  reader.append(Buffer.concat([Buffer.from('first\nbad '), Buffer.from([0xe2])]));
  reader.append(Buffer.concat([Buffer.from([0x28, 0xa1]), Buffer.from('\nvalid\n')]));
  reader.append(Buffer.from([0xf0, 0x9f]));
  reader.finish();
  assert.deepEqual(lines, ['first', 'valid']);
  assert.equal(invalid, 2);
  assert.equal(overflow, 0);
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

test('an oversized record is rejected before slicing its fragment and capture recovers at LF', () => {
  const text = 'x'.repeat(1024 * 1024) + '\nvalid\n';
  const slicedLengths = [];
  const chunk = new String(text);
  const originalSlice = chunk.slice;
  chunk.slice = function(start, end) {
    slicedLengths.push(end === undefined ? this.length - start : end - start);
    return originalSlice.call(this, start, end);
  };

  const lines = [];
  let overflow = 0;
  const reader = new JsonLineCapture(line => lines.push(line), () => overflow++, 8);
  reader.append(chunk);
  assert.equal(overflow, 1);
  assert.deepEqual(lines, ['valid']);
  assert.deepEqual(slicedLengths, [5], 'only the following valid fragment should be sliced');
});

test('an oversized unterminated record is not parsed at end of stream', () => {
  let overflow = 0;
  const reader = new JsonLineCapture(() => assert.fail('oversized line parsed'), () => overflow++, 8);
  reader.append('x'.repeat(1000));
  reader.finish();
  assert.equal(overflow, 1);
});

test('oversized JSON fragments skip needless UTF-8 scans but still count multibyte bytes exactly', () => {
  const lines = [];
  let overflow = 0;
  const reader = new JsonLineCapture(line => lines.push(line), () => overflow++, 8);
  const originalByteLength = Buffer.byteLength;
  const measuredLengths = [];
  Buffer.byteLength = (value, ...args) => {
    if (typeof value === 'string') measuredLengths.push(value.length);
    return originalByteLength(value, ...args);
  };
  try {
    reader.append('x'.repeat(1024 * 1024) + String.fromCharCode(10));
    reader.append('ééé'); // Six bytes; the next two UTF-16 units encode to four bytes.
    reader.append('😀' + String.fromCharCode(10) + 'valid' + String.fromCharCode(10));
    reader.finish();
  } finally {
    Buffer.byteLength = originalByteLength;
  }
  assert.equal(overflow, 2);
  assert.deepEqual(lines, ['valid']);
  assert.ok(measuredLengths.every(length => length <= 8), 'guaranteed oversized fragments should not be byte-scanned');
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

test('stderr truncation scans and encodes only a bounded prefix of an oversized input chunk', () => {
  const capture = new TextCapture(64);
  const input = 'x'.repeat(8 * 1024 * 1024);
  const originalFrom = Buffer.from;
  const originalByteLength = Buffer.byteLength;
  const encodedLengths = [];
  const measuredLengths = [];
  Buffer.from = (value, ...args) => {
    if (typeof value === 'string') encodedLengths.push(value.length);
    return originalFrom(value, ...args);
  };
  Buffer.byteLength = (value, ...args) => {
    if (typeof value === 'string') measuredLengths.push(value.length);
    return originalByteLength(value, ...args);
  };
  try {
    capture.append(input);
    assert.equal(capture.truncated, true);
    assert.ok(encodedLengths.every(length => length <= 66), 'truncation should not encode the discarded tail');
    assert.ok(measuredLengths.every(length => length <= 64), 'truncation should not scan the discarded tail');
    assert.ok(Buffer.byteLength(capture.text) <= 64);
  } finally {
    Buffer.from = originalFrom;
    Buffer.byteLength = originalByteLength;
  }
});

test('truncated stderr output is formatted once despite repeated reads', () => {
  const capture = new TextCapture(64);
  capture.append('x'.repeat(64));
  capture.append('more output');
  const originalFrom = Buffer.from;
  let conversions = 0;
  Buffer.from = (...args) => { conversions++; return originalFrom(...args); };
  try {
    const text = capture.text;
    const formattedConversions = conversions;
    assert.match(text, /stderr capture truncated/);
    assert.equal(capture.text, text);
    capture.append('ignored tail');
    assert.equal(capture.text, text);
    assert.equal(conversions, formattedConversions, 'Repeated reads must not re-encode the retained stderr prefix');
  } finally {
    Buffer.from = originalFrom;
  }
});

test('tiny diagnostic budgets remain bounded and invalid limits are rejected', () => {
  const capture = new TextCapture(4);
  capture.append('x'.repeat(100));
  assert.ok(Buffer.byteLength(capture.text) <= 4);
  for (const limit of [0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => new TextCapture(limit), /positive integers within the safe range/);
    assert.throws(() => new JsonLineCapture(() => {}, () => {}, limit), /positive integers within the safe range/);
    assert.throws(() => new JsonLineCapture(() => {}, () => {}, 8, undefined, limit), /positive integers within the safe range/);
    assert.throws(() => new MessageCapture(limit, 1), /positive integers within the safe range/);
    assert.throws(() => new MessageCapture(10, limit), /positive integers within the safe range/);
  }
});

test('message history rejects invalid weights and preserves exact bounded byte accounting', () => {
  const history = new MessageCapture(10, 2);
  history.push('kept', 5);
  for (const bytes of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => history.push('invalid', bytes), /non-negative safe integer/);
  }
  assert.deepEqual(history.messages, ['kept']);
  assert.equal(history.retainedBytes, 5);
  history.push('replacement', 6);
  assert.deepEqual(history.messages, ['replacement']);
  assert.equal(history.retainedBytes, 6);
  assert.equal(history.dropped, 1);

  const exact = new MessageCapture(Number.MAX_SAFE_INTEGER, 3);
  exact.push('small', 1);
  exact.push('large', Number.MAX_SAFE_INTEGER - 1);
  exact.push('new', Number.MAX_SAFE_INTEGER);
  assert.deepEqual(exact.messages, ['new']);
  assert.equal(exact.retainedBytes, Number.MAX_SAFE_INTEGER);
  assert.equal(exact.dropped, 2);
});

test('message history reports when an oversized current message cannot be retained', () => {
  const history = new MessageCapture(4);
  assert.equal(history.push('kept', 4), true);
  assert.equal(history.push('oversized', 5), false);
  assert.deepEqual(history.messages, []);
  assert.equal(history.retainedBytes, 0);
  assert.equal(history.dropped, 2);
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
