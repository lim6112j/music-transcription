// Key-aware pitch spelling: converts MIDI numbers to VexFlow key specs that
// respect the key signature (flat keys spell Db, not C#) and decides which
// accidental glyphs must be printed.

export type KeyAccidental = '#' | 'b' | '';

const BASE_PC: Record<string, number> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };
// circle-of-fifths order, for building key signature maps
const SHARP_ORDER = ['f', 'c', 'g', 'd', 'a', 'e', 'b'];
const FLAT_ORDER = ['b', 'e', 'a', 'd', 'g', 'c', 'f'];
// letter search order — no musical meaning, just determinism
const LETTERS = ['c', 'd', 'e', 'f', 'g', 'a', 'b'];
// chromatic pitch classes have no natural letter; their conventional spellings
const SHARP_SPELLINGS: Record<number, string> = { 1: 'c#', 3: 'd#', 6: 'f#', 8: 'g#', 10: 'a#' };
const FLAT_SPELLINGS: Record<number, string> = { 1: 'db', 3: 'eb', 6: 'gb', 8: 'ab', 10: 'bb' };

// every key-name spelling the app can produce (KEY_OPTIONS + estimateKeySpec),
// including enharmonics the profile table lacks ('Db', 'G#')
const PC_LOOKUP: Record<string, number> = {
  C: 0,
  'C#': 1,
  Db: 1,
  D: 2,
  'D#': 3,
  Eb: 3,
  E: 4,
  F: 5,
  'F#': 6,
  Gb: 6,
  G: 7,
  'G#': 8,
  Ab: 8,
  A: 9,
  'A#': 10,
  Bb: 10,
  B: 11,
  Cb: 11,
};

// accidental count per major-key tonic pitch class
const SHARPS_BY_PC: Record<number, number> = { 7: 1, 2: 2, 9: 3, 4: 4, 11: 5, 6: 6, 1: 7 };
const FLATS_BY_PC: Record<number, number> = { 5: 1, 10: 2, 3: 3, 8: 4, 1: 5, 6: 6, 11: 7 };
// major tonics whose standard spelling is flat and unambiguous (F, Bb, Eb, Ab)
const FLAT_MAJORS = new Set([5, 10, 3, 8]);

const OFFSET_BY_ACC: Record<KeyAccidental, number> = { '#': 1, b: -1, '': 0 };

export function isMinorKey(keySpec: string): boolean {
  return keySpec.length > 1 && keySpec.endsWith('m');
}

/** The tonic pitch class of the key's relative major (its signature). */
function majorTonicPc(keySpec: string): number {
  const root = isMinorKey(keySpec) ? keySpec.slice(0, -1) : keySpec;
  const pc = PC_LOOKUP[root];
  return pc === undefined ? 0 : isMinorKey(keySpec) ? (pc + 3) % 12 : pc;
}

/** Flat keys spell chromatic tones as flats, sharp keys as sharps. */
export function preferFlatsFor(keySpec: string): boolean {
  if (keySpec.includes('b')) return true;
  if (keySpec.includes('#')) return false;
  return FLAT_MAJORS.has(majorTonicPc(keySpec));
}

export function keySignatureMap(keySpec: string): Record<string, KeyAccidental> {
  const map: Record<string, KeyAccidental> = { c: '', d: '', e: '', f: '', g: '', a: '', b: '' };
  const majorPc = majorTonicPc(keySpec);
  const preferFlats = preferFlatsFor(keySpec);
  // the root's own spelling decides between enharmonic key signatures
  // (C# major = 7 sharps, Db major = 5 flats)
  const count = preferFlats ? FLATS_BY_PC[majorPc] : (SHARPS_BY_PC[majorPc] ?? FLATS_BY_PC[majorPc]);
  const order = preferFlats ? FLAT_ORDER : SHARP_ORDER;
  const symbol: KeyAccidental = preferFlats ? 'b' : '#';
  for (let i = 0; i < (count ?? 0); i++) map[order[i]] = symbol;
  return map;
}

/** Staff position of a key: signed accidental count and mode. */
export function keyFifths(keySpec: string): { fifths: number; mode: 'major' | 'minor' } {
  const majorPc = majorTonicPc(keySpec);
  const preferFlats = preferFlatsFor(keySpec);
  const count = preferFlats ? FLATS_BY_PC[majorPc] : (SHARPS_BY_PC[majorPc] ?? FLATS_BY_PC[majorPc]);
  return {
    fifths: preferFlats ? -(count ?? 0) : (count ?? 0),
    mode: isMinorKey(keySpec) ? 'minor' : 'major',
  };
}

/**
 * Spell a MIDI number for the given key context. Scale tones spell exactly as
 * the key signature does (no printed glyph); natural tones whose letter is
 * altered by the signature get a natural; remaining chromatic tones spell
 * flat in flat keys and sharp in sharp keys. Returns the VexFlow key spec
 * ('db/4') plus the glyph to print, null when the signature covers it.
 */
export function spellMidi(
  midi: number,
  keyMap: Record<string, KeyAccidental>,
  preferFlats: boolean,
): { key: string; accidental: string | null } {
  const pc = ((midi % 12) + 12) % 12;
  // 1. a tone the key signature already spells — matches the signature, no glyph
  for (const letter of LETTERS) {
    const acc = keyMap[letter];
    const letterPc = (BASE_PC[letter] + OFFSET_BY_ACC[acc] + 12) % 12;
    if (letterPc === pc) return { key: `${letter}${acc}/${octaveOf(midi, acc)}`, accidental: null };
  }
  // 2. a natural tone whose letter carries the key's accidental — print a natural
  for (const letter of LETTERS) {
    if (keyMap[letter] !== '' && BASE_PC[letter] === pc) {
      return { key: `${letter}/${octaveOf(midi, '')}`, accidental: 'n' };
    }
  }
  // 3. chromatic tone with no natural letter — spell per the key's preference
  const name = preferFlats ? FLAT_SPELLINGS[pc] : (SHARP_SPELLINGS[pc] ?? FLAT_SPELLINGS[pc]);
  const acc: KeyAccidental = name.endsWith('#') ? '#' : name.endsWith('b') ? 'b' : '';
  const letter = name[0];
  const glyph = name.length > 1 && keyMap[letter] !== acc ? acc : null;
  return { key: `${name}/${octaveOf(midi, acc)}`, accidental: glyph };
}

function octaveOf(midi: number, acc: KeyAccidental): number {
  // letter-relative octave: B# belongs to the octave below the equal-tempered
  // pitch, Cb to the one above
  return Math.floor((midi - OFFSET_BY_ACC[acc]) / 12) - 1;
}

export function keysToMidi(key: string): number {
  // reverse of spellMidi: 'db/4' -> 61, 'bb/4' -> 70, 'b/3' -> 59
  const [name, oct] = key.split('/');
  const base = BASE_PC[name[0]] ?? 0;
  return base + (name.length > 1 ? (name[1] === '#' ? 1 : -1) : 0) + (parseInt(oct, 10) + 1) * 12;
}
