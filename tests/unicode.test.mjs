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

test('Unicode 17 canonical ordering and composition do not depend on Node ICU data', () => {
  // U+1ACF has CCC 230 in Unicode 17 but is unassigned in Node 22.19's Unicode 16 tables.
  const first = 'a\u0315\u0300\u05ae\u1acf' + 'b';
  const canonicallyEquivalent = 'a\u05ae\u0300\u1acf\u0315' + 'b';
  assert.equal(caseFoldUnicode(first), caseFoldUnicode(canonicallyEquivalent));
  assert.equal(caseFoldUnicode(first), '\u00e0\u05ae\u1acf\u0315b');

  // Every newly assigned nonzero CCC in Unicode 17 must reorder consistently with older marks.
  const unicode17Marks = [
    ...Array.from({ length: 15 }, (_, index) => 0x1acf + index),
    ...Array.from({ length: 12 }, (_, index) => 0x1ae0 + index),
    0x10efa, 0x10efb, 0x1e6e3, 0x1e6e6, 0x1e6ee, 0x1e6ef, 0x1e6f5,
  ];
  for (const codePoint of unicode17Marks) {
    const mark = String.fromCodePoint(codePoint);
    assert.equal(caseFoldUnicode(`a\u0315${mark}b`), caseFoldUnicode(`a${mark}\u0315b`),
      `U+${codePoint.toString(16).toUpperCase()} canonical order`);
  }

  // The Unicode 17 CCC 220 mark must not block a later CCC 230 composition.
  assert.equal(caseFoldUnicode('a\u1add\u0300'), '\u00e0\u1add');
  assert.equal(caseFoldUnicode('café').includes(caseFoldUnicode('e')), false,
    'NFC keys must preserve literal substring sensitivity to accents');
});

test('well-formed Unicode accepts scalar values and rejects isolated UTF-16 surrogates', () => {
  for (const value of ['', 'ASCII', 'café', '😀', '\ud800\udc00']) assert.equal(isWellFormedUnicode(value), true);
  for (const value of ['\ud800', '\udc00', 'a\ud800b', '\udc00\ud800']) {
    assert.equal(isWellFormedUnicode(value), false);
  }
});
