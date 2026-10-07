import assert from 'node:assert/strict';
import test from 'node:test';
import { jiti } from './pi-runtime.mjs';
const { createOutputPager, sliceOutput } = await jiti.import('../paging.ts');

test('UTF-8 output pages reconstruct multibyte text without replacement characters', () => {
  const original = 'abc😀é漢字\n'.repeat(50);
  for (const limit of [4, 5, 7, 31, 32768]) {
    let offset = 0, text = '';
    do {
      const page = sliceOutput(original, offset, limit);
      assert.ok(Buffer.byteLength(page.text) <= limit);
      assert.equal(page.text.includes('\uFFFD'), false);
      assert.equal(page.offset, offset);
      text += page.text;
      if (page.nextOffset === null) break;
      assert.ok(page.nextOffset > offset);
      offset = page.nextOffset;
    } while (true);
    assert.equal(text, original);
  }
});

test('end offsets and empty output return a final empty page', () => {
  assert.deepEqual(sliceOutput('', 0, 4), { text: '', offset: 0, nextOffset: null, totalBytes: 0 });
  assert.deepEqual(sliceOutput('é', 2, 4), { text: '', offset: 2, nextOffset: null, totalBytes: 2 });
});

test('reusable pager encodes once and serves late sequential pages without prefix scans', () => {
  const size = 8 * 1024 * 1024;
  const original = 'x'.repeat(size);
  const originalFrom = Buffer.from;
  const encoded = [];
  Buffer.from = (value, ...args) => {
    if (typeof value === 'string') encoded.push(Buffer.byteLength(value));
    return originalFrom(value, ...args);
  };
  try {
    const pager = createOutputPager(original);
    const first = pager(size - 2048, 1024);
    const second = pager(first.nextOffset, 1024);
    assert.equal(first.text, 'x'.repeat(1024));
    assert.equal(first.nextOffset, size - 1024);
    assert.equal(second.text, 'x'.repeat(1024));
    assert.equal(second.nextOffset, null);
    assert.equal(second.totalBytes, size);
    assert.deepEqual(encoded, [size], 'the source is encoded once even when reading at the end');
  } finally {
    Buffer.from = originalFrom;
  }
});

test('paging malformed UTF-16 preserves Buffer UTF-8 replacement behavior', () => {
  const original = '\ud800A\udc00😀';
  const expected = Buffer.from(original, 'utf8').toString('utf8');
  const pager = createOutputPager(original);
  let offset = 0, text = '';
  do {
    const page = pager(offset, 4);
    assert.ok(Buffer.byteLength(page.text, 'utf8') <= 4);
    text += page.text;
    if (page.nextOffset === null) break;
    offset = page.nextOffset;
  } while (true);
  assert.equal(text, expected);
  assert.throws(() => pager(8, 4), /boundary/);
});

test('invalid ranges and offsets inside a character fail without payload excerpts', () => {
  for (const offset of [-1, 1.5, Infinity, 5, 1, 2, 3]) assert.throws(() => sliceOutput('😀', offset, 4), /offset/);
  for (const limit of [0, 1, 3, 4.5, Infinity, 32769]) assert.throws(() => sliceOutput('private text', 0, limit), /limit/);
});
