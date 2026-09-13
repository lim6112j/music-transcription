import type { NoteEvent } from './transcribe';

export interface MeasureItem {
  keys: string[]; // VexFlow pitch specs, e.g. ['c/4', 'e/4']
  duration: string; // VexFlow duration code incl. rests, e.g. 'q', 'hd', 'qr'
  isRest: boolean;
  voice: number; // voice layer this item belongs to (0 = primary)
  accidentals: Array<string | null>; // per-key accidental symbol or null
  tieToNext: boolean;
  tieFromPrev: boolean;
}

export interface ScoreSettings {
  tempo: number; // BPM (quarter note = 1 beat)
  beatsPerMeasure: number; // e.g. 4 for 4/4
  clef: 'auto' | 'treble' | 'bass';
  keySpec: string; // VexFlow key signature spec, e.g. 'C', 'G', 'Bb', 'Am'
}

export interface BuiltScore {
  measures: MeasureItem[][];
  settings: ScoreSettings;
  totalMeasures: number;
}

const DUR_BEATS: Array<[number, string]> = [
  [4, 'w'],
  [3, 'hd'],
  [2, 'h'],
  [1.5, 'qd'],
  [1, 'q'],
  [0.75, '8d'],
  [0.5, '8'],
  [0.25, '16'],
];

const QUANTUM = 0.25; // sixteenth note
const EPS = 1e-6;
const MAX_MEASURES = 400;
const MAX_VOICES = 2; // single-stave engraving limit; excess layers clip instead of stack

function beatsOf(duration: string): number {
  const base = duration.replace('r', '');
  const found = DUR_BEATS.find(([, code]) => code === base);
  return found ? found[0] : 0;
}

function pickDuration(maxBeats: number): [number, string] | null {
  for (const [beats, code] of DUR_BEATS) {
    if (beats <= maxBeats + EPS) return [beats, code];
  }
  return null;
}

// ---------- Tempo estimation ----------

export function estimateTempo(events: NoteEvent[]): number {
  const onsets = Array.from(new Set(events.map((e) => e.startTimeSeconds))).sort((a, b) => a - b);
  if (onsets.length < 4) return 120;
  let bestBpm = 120;
  let bestErr = Infinity;
  for (let bpm = 70; bpm <= 180; bpm += 0.5) {
    let err = 0;
    for (const t of onsets) {
      const beats = (t * bpm) / 60;
      const frac = beats / QUANTUM;
      err += Math.abs(frac - Math.round(frac));
    }
    err /= onsets.length;
    if (err < bestErr - 1e-9) {
      bestErr = err;
      bestBpm = bpm;
    }
  }
  return Math.round(bestBpm);
}

// ---------- Key estimation (Krumhansl-Schmuckler) ----------

const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
const PC_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];

function correlation(a: number[], b: number[]): number {
  const n = a.length;
  const ma = a.reduce((s, v) => s + v, 0) / n;
  const mb = b.reduce((s, v) => s + v, 0) / n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] - ma;
    const y = b[i] - mb;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  const denom = Math.sqrt(da * db);
  return denom === 0 ? 0 : num / denom;
}

export function estimateKeySpec(events: NoteEvent[], tempo: number): string {
  if (events.length === 0) return 'C';
  const hist = new Array(12).fill(0);
  for (const e of events) {
    const beats = Math.max(QUANTUM, (e.durationSeconds * tempo) / 60);
    hist[((e.pitchMidi % 12) + 12) % 12] += beats;
  }
  let best = 'C';
  let bestScore = -Infinity;
  for (let tonic = 0; tonic < 12; tonic++) {
    const rotated = hist.map((_, i) => hist[(i + tonic) % 12]);
    const majorScore = correlation(rotated, MAJOR_PROFILE);
    const minorScore = correlation(rotated, MINOR_PROFILE);
    if (majorScore > bestScore) {
      bestScore = majorScore;
      best = PC_NAMES[tonic];
    }
    if (minorScore > bestScore) {
      bestScore = minorScore;
      // both profiles share the same tonic, so the minor result is the
      // parallel minor (C tonic -> 'Cm'), not the relative minor
      best = `${PC_NAMES[tonic]}m`;
    }
  }
  return best;
}

// ---------- Clef detection ----------

export function detectClef(events: NoteEvent[]): 'treble' | 'bass' {
  if (events.length === 0) return 'treble';
  const sorted = events.map((e) => e.pitchMidi).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  return median < 58 ? 'bass' : 'treble';
}

// ---------- Pitch / key signature helpers ----------

const PITCH_NAMES = ['c', 'c#', 'd', 'd#', 'e', 'f', 'f#', 'g', 'g#', 'a', 'a#', 'b'];
const BASE_PC: Record<string, number> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };
const SHARP_ORDER = ['f', 'c', 'g', 'd', 'a', 'e', 'b'];
const FLAT_ORDER = ['b', 'e', 'a', 'd', 'g', 'c', 'f'];

// every key-name spelling the app can produce (KEY_OPTIONS + estimateKeySpec),
// including enharmonics PC_NAMES lacks ('Db', 'G#')
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

function keySignatureMap(keySpec: string): Record<string, '#' | 'b' | ''> {
  const map: Record<string, '#' | 'b' | ''> = { c: '', d: '', e: '', f: '', g: '', a: '', b: '' };
  const isMinor = keySpec.length > 1 && keySpec.endsWith('m');
  const root = isMinor ? keySpec.slice(0, -1) : keySpec;
  const pc = PC_LOOKUP[root];
  if (pc === undefined) return map;
  const majorPc = isMinor ? (pc + 3) % 12 : pc; // minor keys use their relative major's signature
  // the root's own spelling decides between enharmonic key signatures
  // (C# major = 7 sharps, Db major = 5 flats)
  const preferFlats = root.includes('b') || (!root.includes('#') && FLAT_MAJORS.has(majorPc));
  const count = preferFlats ? FLATS_BY_PC[majorPc] : (SHARPS_BY_PC[majorPc] ?? FLATS_BY_PC[majorPc]);
  const order = preferFlats ? FLAT_ORDER : SHARP_ORDER;
  const symbol: '#' | 'b' = preferFlats ? 'b' : '#';
  for (let i = 0; i < (count ?? 0); i++) map[order[i]] = symbol;
  return map;
}

function midiToKeySpec(midi: number): string {
  const name = PITCH_NAMES[((midi % 12) + 12) % 12];
  const octave = Math.floor(midi / 12) - 1;
  return `${name}/${octave}`;
}

function accidentalFor(midi: number, keyMap: Record<string, '#' | 'b' | ''>): string | null {
  const pc = ((midi % 12) + 12) % 12;
  const name = PITCH_NAMES[pc];
  const letter = name[0];
  const keyAcc = keyMap[letter];
  const hasAccidentalInName = name.length > 1;
  const noteAcc = hasAccidentalInName ? (name[1] === '#' ? '#' : 'b') : '';
  if (noteAcc === keyAcc) return null; // matches what the key signature provides
  if (!hasAccidentalInName && keyAcc === '') return null;
  if (!hasAccidentalInName && keyAcc !== '') return 'n'; // natural cancels the key signature
  return noteAcc;
}

// ---------- Segmentation ----------

/**
 * Split a note starting at absolute beat position with given length into
 * segments that respect measure boundaries and avoid crossing the middle of
 * a measure (unless starting exactly at the measure start).
 */
function splitIntoSegments(
  start: number,
  length: number,
  beatsPerMeasure: number,
): Array<{ start: number; beats: number }> {
  const segments: Array<{ start: number; beats: number }> = [];
  let pos = start;
  let remaining = length;
  let guard = 0;
  while (remaining > EPS && guard++ < 64) {
    const measureIndex = Math.floor(pos / beatsPerMeasure + EPS);
    const measureStart = measureIndex * beatsPerMeasure;
    const measureEnd = measureStart + beatsPerMeasure;
    const half = measureStart + beatsPerMeasure / 2;
    let cap = measureEnd - pos;
    const atMeasureStart = Math.abs(pos - measureStart) < EPS;
    if (!atMeasureStart && pos < half - EPS) {
      cap = Math.min(cap, half - pos);
    }
    const pick = pickDuration(Math.min(remaining, cap));
    if (!pick) break;
    const [beats] = pick;
    segments.push({ start: pos, beats });
    pos += beats;
    remaining -= beats;
  }
  return segments;
}

function measureIndexOf(seg: { start: number }, beatsPerMeasure: number): number {
  return Math.floor(seg.start / beatsPerMeasure + EPS);
}

interface OnsetGroup {
  start: number;
  end: number;
  pitches: number[];
}

function makeItems(
  segments: Array<{ start: number; beats: number }>,
  keys: string[],
  isRest: boolean,
  keyMap: Record<string, '#' | 'b' | ''>,
  voice: number,
): MeasureItem[] {
  return segments.map((seg, i) => {
    const dur = DUR_BEATS.find(([b]) => Math.abs(b - seg.beats) < EPS)?.[1] ?? 'q';
    return {
      keys: isRest ? ['b/4'] : keys,
      duration: isRest ? `${dur}r` : dur,
      isRest,
      voice,
      accidentals: isRest ? [] : keys.map((_, k) => accidentalFor(keysToMidi(keys[k]), keyMap)),
      // a chain longer than one segment means its parts are tied together
      tieToNext: !isRest && i < segments.length - 1,
      tieFromPrev: !isRest && i > 0,
    };
  });
}

function keysToMidi(key: string): number {
  // reverse of midiToKeySpec
  const [name, oct] = key.split('/');
  const base = BASE_PC[name[0]] ?? 0;
  return base + (name.length > 1 ? (name[1] === '#' ? 1 : -1) : 0) + (parseInt(oct, 10) + 1) * 12;
}

/**
 * Build items for a whole segment chain and place each item into the measure
 * its segment belongs to, so ties across measure boundaries stay intact.
 */
function appendItems(
  measures: MeasureItem[][],
  segments: Array<{ start: number; beats: number }>,
  keys: string[],
  isRest: boolean,
  keyMap: Record<string, '#' | 'b' | ''>,
  voice: number,
  beatsPerMeasure: number,
): void {
  const items = makeItems(segments, keys, isRest, keyMap, voice);
  segments.forEach((seg, i) => {
    const mi = measureIndexOf(seg, beatsPerMeasure);
    if (mi >= 0 && mi < measures.length) measures[mi].push(items[i]);
  });
}

// ---------- Main builder ----------

export function buildScore(events: NoteEvent[], settings: ScoreSettings): BuiltScore {
  const { tempo, beatsPerMeasure } = settings;
  const toBeat = (s: number) => (s * tempo) / 60;
  const keyMap = keySignatureMap(settings.keySpec);

  // 1. Quantize onsets and durations to the sixteenth-note grid
  const quantized = events.map((e) => ({
    pitchMidi: e.pitchMidi,
    start: Math.max(0, Math.round(toBeat(e.startTimeSeconds) / QUANTUM) * QUANTUM),
    dur: Math.max(QUANTUM, Math.round(toBeat(e.durationSeconds) / QUANTUM) * QUANTUM),
  }));
  quantized.sort((a, b) => a.start - b.start || a.pitchMidi - b.pitchMidi);

  // 2. Group near-simultaneous notes into chords
  const groups: OnsetGroup[] = [];
  for (const q of quantized) {
    const last = groups[groups.length - 1];
    if (last && q.start - last.start < QUANTUM / 2 + EPS) {
      last.end = Math.max(last.end, q.start + q.dur);
      if (!last.pitches.includes(q.pitchMidi)) last.pitches.push(q.pitchMidi);
    } else {
      groups.push({ start: q.start, end: q.start + q.dur, pitches: [q.pitchMidi] });
    }
  }
  for (const g of groups) g.pitches.sort((a, b) => a - b);

  // 3. Assign chord groups to voices so no voice ever overlaps itself.
  // Overlapping material (e.g. a held bass note under a melody) becomes a
  // second voice; a third layer clips the earliest-busy voice's tail
  // instead of spawning an unreadable stack of voices on one stave.
  const voiceEnds: number[] = [];
  const voices: OnsetGroup[][] = [];
  for (const g of groups) {
    let vi = voiceEnds.findIndex((end) => end <= g.start + EPS);
    if (vi < 0) {
      if (voices.length < MAX_VOICES) {
        vi = voiceEnds.length;
        voiceEnds.push(0);
        voices.push([]);
      } else {
        // both voices busy: reuse the one freeing up soonest, clipping the
        // tail of the note that occupies it (invariant: only the last group
        // in a voice can extend past g.start)
        vi = voiceEnds.indexOf(Math.min(...voiceEnds));
        const prev = voices[vi][voices[vi].length - 1];
        if (prev && prev.end > g.start) prev.end = Math.max(prev.start + QUANTUM, g.start);
      }
    }
    voices[vi].push(g);
    voiceEnds[vi] = Math.max(voiceEnds[vi], g.end);
  }
  if (voices.length === 0) voices.push([]);

  // 4. Total measures needed
  const lastEnd = voices.reduce(
    (max, gs) => (gs.length > 0 ? Math.max(max, gs[gs.length - 1].end) : max),
    beatsPerMeasure,
  );
  const totalMeasures = Math.min(MAX_MEASURES, Math.max(1, Math.ceil(lastEnd / beatsPerMeasure - EPS)));

  // 5. Lay out each voice measure by measure; gaps become rests
  const measures: MeasureItem[][] = Array.from({ length: totalMeasures }, () => []);
  voices.forEach((gs, voice) => {
    let cursor = 0;
    for (const g of gs) {
      if (g.start > cursor + EPS) {
        appendItems(
          measures,
          splitIntoSegments(cursor, g.start - cursor, beatsPerMeasure),
          [],
          true,
          keyMap,
          voice,
          beatsPerMeasure,
        );
        cursor = g.start;
      }
      const keys = g.pitches.map(midiToKeySpec);
      const noteLen = Math.max(QUANTUM, g.end - g.start);
      const segs = splitIntoSegments(g.start, noteLen, beatsPerMeasure);
      appendItems(measures, segs, keys, false, keyMap, voice, beatsPerMeasure);
      const last = segs[segs.length - 1];
      cursor = Math.max(cursor, last ? last.start + last.beats : g.start);
    }
    // trailing rest completes the final measure
    const scoreEnd = totalMeasures * beatsPerMeasure;
    if (cursor < scoreEnd - EPS) {
      appendItems(
        measures,
        splitIntoSegments(cursor, scoreEnd - cursor, beatsPerMeasure),
        [],
        true,
        keyMap,
        voice,
        beatsPerMeasure,
      );
    }
  });

  // 6. Clamp overflow inside each measure per voice (rounding safety)
  for (let mi = 0; mi < measures.length; mi++) {
    const sums = new Map<number, number>();
    measures[mi] = measures[mi].map((item) => {
      const sum = sums.get(item.voice) ?? 0;
      const beats = beatsOf(item.duration);
      if (sum + beats <= beatsPerMeasure + EPS) {
        sums.set(item.voice, sum + beats);
        return item;
      }
      const [b, code] = pickDuration(Math.max(QUANTUM, beatsPerMeasure - sum)) ?? ([QUANTUM, '16'] as [number, string]);
      sums.set(item.voice, sum + b);
      return { ...item, duration: item.isRest ? `${code}r` : code };
    });
  }

  return { measures, settings, totalMeasures };
}
