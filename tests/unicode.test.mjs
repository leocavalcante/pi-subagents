import assert from 'node:assert/strict';
import test from 'node:test';
import { jiti } from './pi-runtime.mjs';

const { caseFoldUnicode, isWellFormedUnicode } = await jiti.import('../unicode.ts');

test('Unicode 17 default full case folding is canonical, locale-independent, and handles expansions', () => {
  for (const [input, expected] of [
    ['Straße', 'strasse'],
    ['ſtraße', 'strasse'],
    ['Oﬃce', 'office'],
    ['ϐeta', 'βeta'],
    ['ΟΣ', 'οσ'],
    ['cafe\u0301', 'café'],
    ['Iİı', 'ii\u0307ı'],
  ]) assert.equal(caseFoldUnicode(input), expected, JSON.stringify(input));
});

test('well-formed Unicode accepts scalar values and rejects isolated UTF-16 surrogates', () => {
  for (const value of ['', 'ASCII', 'café', '😀', '\ud800\udc00']) assert.equal(isWellFormedUnicode(value), true);
  for (const value of ['\ud800', '\udc00', 'a\ud800b', '\udc00\ud800']) {
    assert.equal(isWellFormedUnicode(value), false);
  }
});
