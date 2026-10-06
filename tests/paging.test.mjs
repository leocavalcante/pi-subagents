import assert from 'node:assert/strict';
import test from 'node:test';
import { jiti } from './pi-runtime.mjs';
const { sliceOutput } = await jiti.import('../paging.ts');

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

test('invalid ranges and offsets inside a character fail without payload excerpts', () => {
  for (const offset of [-1, 1.5, Infinity, 5, 1, 2, 3]) assert.throws(() => sliceOutput('😀', offset, 4), /offset/);
  for (const limit of [0, 1, 3, 4.5, Infinity, 32769]) assert.throws(() => sliceOutput('private text', 0, limit), /limit/);
});
