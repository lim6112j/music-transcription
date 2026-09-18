// Key-aware pitch spelling in spelling.ts.
// Run: node --test --experimental-strip-types src/transcribe/spelling.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keyFifths, keySignatureMap, keysToMidi, preferFlatsFor, spellMidi } from './spelling.ts';

function spell(midi: number, keySpec: string): { key: string; accidental: string | null } {
  return spellMidi(midi, keySignatureMap(keySpec), preferFlatsFor(keySpec));
}

test('Eb major spells scale tones without glyphs', () => {
  assert.deepEqual(spell(63, 'Eb'), { key: 'eb/4', accidental: null }); // Eb
  assert.deepEqual(spell(65, 'Eb'), { key: 'f/4', accidental: null }); // F
  assert.deepEqual(spell(58, 'Eb'), { key: 'bb/3', accidental: null }); // Bb
  assert.deepEqual(spell(68, 'Eb'), { key: 'ab/4', accidental: null }); // Ab
});

test('Eb major spells chromatic tones as flats, printing only off-signature glyphs', () => {
  assert.deepEqual(spell(61, 'Eb'), { key: 'db/4', accidental: 'b' }); // Db is off-signature
  assert.deepEqual(spell(66, 'Eb'), { key: 'gb/4', accidental: 'b' }); // Gb
  assert.deepEqual(spell(63 + 12, 'Eb'), { key: 'eb/5', accidental: null });
});

test('naturals of signature letters print a natural sign', () => {
  assert.deepEqual(spell(64, 'Eb'), { key: 'e/4', accidental: 'n' }); // E natural
  assert.deepEqual(spell(59, 'Eb'), { key: 'b/3', accidental: 'n' }); // B natural
});

test('C major spells chromatic tones as sharps', () => {
  assert.deepEqual(spell(61, 'C'), { key: 'c#/4', accidental: '#' });
  assert.deepEqual(spell(63, 'C'), { key: 'd#/4', accidental: '#' });
  assert.deepEqual(spell(70, 'C'), { key: 'a#/4', accidental: '#' });
});

test('G major prints a natural for F natural', () => {
  assert.deepEqual(spell(65, 'G'), { key: 'f/4', accidental: 'n' });
  assert.deepEqual(spell(66, 'G'), { key: 'f#/4', accidental: null }); // covered by signature
});

test('minor keys use their relative-major signature for spelling', () => {
  // C minor: three flats
  assert.deepEqual(spell(63, 'Cm'), { key: 'eb/4', accidental: null });
  assert.deepEqual(spell(61, 'Cm'), { key: 'db/4', accidental: 'b' });
  // A minor: no accidentals, chromatics spell sharp
  assert.deepEqual(spell(61, 'Am'), { key: 'c#/4', accidental: '#' });
});

test('Bb major spells Bb without a glyph', () => {
  assert.deepEqual(spell(70, 'Bb'), { key: 'bb/4', accidental: null });
});

test('key fifths cover every KEY_OPTIONS entry', () => {
  const expected: Record<string, number> = {
    C: 0, G: 1, D: 2, A: 3, E: 4, B: 5, 'F#': 6,
    F: -1, Bb: -2, Eb: -3, Ab: -4, Db: -5,
    Am: 0, Em: 1, Bm: 2, 'F#m': 3, 'C#m': 4, 'G#m': 5,
    Dm: -1, Gm: -2, Cm: -3, Fm: -4, Bbm: -5, Ebm: -6,
  };
  for (const [key, fifths] of Object.entries(expected)) {
    assert.equal(keyFifths(key).fifths, fifths, `${key} should have ${fifths} fifths`);
  }
  assert.equal(keyFifths('Cm').mode, 'minor');
  assert.equal(keyFifths('Eb').mode, 'major');
});

test('keysToMidi round-trips flat and sharp spellings', () => {
  assert.equal(keysToMidi('db/4'), 61);
  assert.equal(keysToMidi('bb/4'), 70);
  assert.equal(keysToMidi('c#/4'), 61);
  assert.equal(keysToMidi('b/3'), 59);
  assert.equal(keysToMidi('e/4'), 64);
});
