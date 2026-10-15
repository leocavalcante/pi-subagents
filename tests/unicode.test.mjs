import assert from 'node:assert/strict';
import test from 'node:test';
import { jiti } from './pi-runtime.mjs';

const { isWellFormedUnicode } = await jiti.import('../unicode.ts');

test('well-formed Unicode accepts scalar values and rejects isolated UTF-16 surrogates', () => {
  for (const value of ['', 'ASCII', 'café', '😀', '\ud800\udc00']) assert.equal(isWellFormedUnicode(value), true);
  for (const value of ['\ud800', '\udc00', 'a\ud800b', '\udc00\ud800']) {
    assert.equal(isWellFormedUnicode(value), false);
  }
});
