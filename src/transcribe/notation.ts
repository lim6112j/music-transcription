import type { NoteEvent } from './transcribe';

export interface MeasureItem {
  keys: string[]; // VexFlow pitch specs, e.g. ['c/4', 'e/4']
  duration: string; // VexFlow duration code incl. rests, e.g. 'q', 'hd', 'qr'
  isRest: boolean;
  voice: number; // voice layer this item belongs to (0 = primary)
  accidentals: Array<string | null>; // per-key accidental symbol or null
  tieToNext: boolean;
  tieFromPrev: boolean;
  beats: number; // actual duration in beats (differs from nominal for tuplets)
  tuplet: boolean; // part of a 3:2 tuplet group (render with a triplet bracket)
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

const QUANTUM = 1 / 12; // grid unit: 1/12 beat covers straight 16ths (3 units) and triplets (2/4 units)
const CHORD_MERGE_BEATS = 0.125; // onsets closer than this merge into one chord
const EPS = 1e-6;
const MAX_MEASURES = 400;
const MAX_VOICES = 2; // single-stave engraving limit; excess layers clip instead of stack

export function beatsOf(duration: string): number {
  const base = duration.replace('r', '');
  const found = DUR_BEATS.find(([, code]) => code === base);
  return found ? found[0] : 0;
}

interface DurationRep {
  code: string; // VexFlow duration code (nominal)
  beats: number; // actual beats sounded
  tuplet: boolean;
}

// Notatable pieces in 1/12-beat units, ordered for decomposition: straight
// values descending, then triplets descending. Every multiple of 1/12 except
// exactly 1 decomposes into these pieces (2 and 3 alone generate the rest).
const VOCAB: Array<{ twelfths: number; rep: DurationRep }> = [
  { twelfths: 48, rep: { code: 'w', beats: 4, tuplet: false } },
  { twelfths: 36, rep: { code: 'hd', beats: 3, tuplet: false } },
  { twelfths: 24, rep: { code: 'h', beats: 2, tuplet: false } },
  { twelfths: 18, rep: { code: 'qd', beats: 1.5, tuplet: false } },
  { twelfths: 12, rep: { code: 'q', beats: 1, tuplet: false } },
  { twelfths: 9, rep: { code: '8d', beats: 0.75, tuplet: false } },
  { twelfths: 6, rep: { code: '8', beats: 0.5, tuplet: false } },
  { twelfths: 3, rep: { code: '16', beats: 0.25, tuplet: false } },
  { twelfths: 8, rep: { code: 'q', beats: 2 / 3, tuplet: true } },
  { twelfths: 4, rep: { code: '8', beats: 1 / 3, tuplet: true } },
  { twelfths: 2, rep: { code: '16', beats: 1 / 6, tuplet: true } },
];

const MIN_BLOCK_TWELFTHS = 2; // nothing notatable is shorter than a triplet 16th

function pickDuration(maxBeats: number): DurationRep | null {
  // exact straight match first, then largest fit — overflow safety net only;
  // segment sizing goes through decomposeSpan, which never leaves remainders
  const fallback = DUR_BEATS.find(([b]) => b <= maxBeats + EPS);
  return fallback ? { code: fallback[1], beats: fallback[0], tuplet: false } : null;
}

// ---------- Tempo estimation ----------

const MIN_BPM = 70;
const MAX_BPM = 180;
const CENTER_BPM = 120;
const DEFAULT_BPM = 120;
// compare onsets up to this many apart, so skipped beats still contribute
const MAX_PAIR_SPAN = 4;
// IOIs outside this range are noise for pulse-finding purposes
const MIN_IOI_SECONDS = 0.2;
const MAX_IOI_SECONDS = 2.4;
// below this peak-vote share the material has no clear pulse
const MIN_TEMPO_CONFIDENCE = 0.12;

/** All octave-equivalent tempi inside [MIN_BPM, MAX_BPM). */
function octaveCandidates(bpm: number): number[] {
  const kMin = Math.ceil(Math.log2(MIN_BPM / bpm));
  const kMax = Math.floor(Math.log2(MAX_BPM / bpm));
  const out: number[] = [];
  for (let k = kMin; k <= kMax; k++) {
    const candidate = bpm * 2 ** k;
    if (candidate >= MIN_BPM && candidate < MAX_BPM) out.push(candidate);
  }
  return out;
}

/**
 * Estimate tempo from inter-onset intervals: every onset pair votes for the
 * tempo that would make their spacing a whole number of beats (weighted by
 * closeness and note strength), then the strongest vote wins. Unlike a grid
 * scan this cannot lock onto dotted-ratio degenerate solutions.
 */
export function estimateTempo(events: NoteEvent[]): number {
  // strongest amplitude per onset instant
  const onsetAmp = new Map<number, number>();
  for (const e of events) {
    onsetAmp.set(e.startTimeSeconds, Math.max(onsetAmp.get(e.startTimeSeconds) ?? 0, e.amplitude));
  }
  const onsets = [...onsetAmp.keys()].sort((a, b) => a - b);
  if (onsets.length < 4) return DEFAULT_BPM;

  const votes = new Map<number, number>();
  let totalVotes = 0;
  for (let i = 0; i < onsets.length - 1; i++) {
    for (let s = 1; s <= MAX_PAIR_SPAN && i + s < onsets.length; s++) {
      const dt = onsets[i + s] - onsets[i];
      if (dt < MIN_IOI_SECONDS || dt > MAX_IOI_SECONDS) continue;
      const candidates = octaveCandidates(60 / dt);
      if (candidates.length === 0) continue;
      // the perceptually strongest octave is the one closest to the center
      const bpm = candidates.reduce((best, c) =>
        Math.abs(Math.log2(c / CENTER_BPM)) < Math.abs(Math.log2(best / CENTER_BPM)) ? c : best,
      );
      const amp = Math.min(onsetAmp.get(onsets[i])!, onsetAmp.get(onsets[i + s])!);
      const weight = (1 / s) * (0.5 + 0.5 * amp);
      votes.set(bpm, (votes.get(bpm) ?? 0) + weight);
      totalVotes += weight;
    }
  }
  if (totalVotes === 0) return DEFAULT_BPM;

  // smoothed score per 1-BPM bin, then a centroid refinement on the winner
  const score = (bpm: number) =>
    (votes.get(bpm - 1) ?? 0) + (votes.get(bpm) ?? 0) + (votes.get(bpm + 1) ?? 0);
  let peak = 0;
  let best = -Infinity;
  for (const bpm of votes.keys()) {
    const s = score(bpm);
    if (s > best) {
      best = s;
      peak = bpm;
    }
  }
  if (best / totalVotes < MIN_TEMPO_CONFIDENCE) return DEFAULT_BPM;

  const window = [peak - 1, peak, peak + 1].map((b) => [b, votes.get(b) ?? 0] as const);
  const wSum = window.reduce((n, [, w]) => n + w, 0);
  if (wSum === 0) return peak;
  return Math.round(window.reduce((n, [b, w]) => n + b * w, 0) / wSum);
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

// ---------- Editing ----------

const MIN_EVENT_LEN_S = 1e-4;

/**
 * Remove the time span [t0, t1) from an event list: events starting inside
 * are deleted, notes sounding across the boundary are clipped to end at t0,
 * and later events shift left by the span so the remaining measures stay
 * consecutive. Pure — returns a new array.
 */
export function deleteTimeRange(events: NoteEvent[], t0: number, t1: number): NoteEvent[] {
  if (t1 <= t0) return events;
  const span = t1 - t0;
  const out: NoteEvent[] = [];
  for (const e of events) {
    const end = e.startTimeSeconds + e.durationSeconds;
    if (e.startTimeSeconds >= t1) {
      // entirely after the range → close the gap
      out.push({ ...e, startTimeSeconds: e.startTimeSeconds - span });
    } else if (e.startTimeSeconds >= t0) {
      // starts inside the range → deleted
    } else if (end > t0) {
      // started before but sounds into the range → clip the tail
      const clipped = { ...e, durationSeconds: t0 - e.startTimeSeconds };
      if (clipped.durationSeconds >= MIN_EVENT_LEN_S) out.push(clipped);
    } else {
      out.push(e);
    }
  }
  return out;
}

// ---------- Score layout ----------

// item counts (notes+rests) per measure above which a row carries fewer
// measures, so dense music keeps human-readable spacing
const DENSE_MAX = 16;
const DENSE_AVG = 12;
const MEDIUM_MAX = 9;
const MEDIUM_AVG = 6;

/**
 * Pick how many measures to draw per staff row: light scores fit 4 across,
 * dense ones drop to 2 so notes don't cram together.
 */
export function pickMeasuresPerRow(itemCounts: number[]): number {
  if (itemCounts.length === 0) return 4;
  const max = Math.max(...itemCounts);
  const avg = itemCounts.reduce((a, b) => a + b, 0) / itemCounts.length;
  if (max > DENSE_MAX || avg > DENSE_AVG) return 2;
  if (max > MEDIUM_MAX || avg > MEDIUM_AVG) return 3;
  return 4;
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
 * Split a span of `lenTw` twelfths (1/12 beat) starting at absolute twelfth
 * position `startTw` into notatable segments. Respects measure boundaries
 * (pieces never cross a barline) and prefers stopping at the middle of a
 * measure, falling back to a crossing piece only when stopping there would
 * strand an unnotatable remainder. Returns null for spans no combination can
 * express — callers tile the timeline so every span is ≥ 2 twelfths.
 */
function decomposeSpan(
  startTw: number,
  lenTw: number,
  beatsPerMeasure: number,
): Array<{ start: number; rep: DurationRep }> | null {
  const perMeasure = beatsPerMeasure * 12;
  const memo = new Map<string, number | null>();
  // largest notatable piece at posTw with remTw left, 0 = done, null = stuck
  const firstPiece = (posTw: number, remTw: number): number | null => {
    if (remTw === 0) return 0;
    const key = `${posTw}:${remTw}`;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    const into = posTw % perMeasure;
    const toBarline = perMeasure - into;
    const toHalf = into !== 0 && into * 2 < perMeasure ? perMeasure / 2 - into : toBarline;
    let out: number | null = null;
    for (const { twelfths } of VOCAB) {
      if (twelfths > remTw || twelfths > toBarline || twelfths > toHalf) continue;
      if (firstPiece(posTw + twelfths, remTw - twelfths) !== null) {
        out = twelfths;
        break;
      }
    }
    if (out === null && toHalf < toBarline) {
      // the mid-measure split point is unreachable from here — let one
      // piece cross it instead of leaving the rest of the measure blank
      for (const { twelfths } of VOCAB) {
        if (twelfths > remTw || twelfths > toBarline) continue;
        if (firstPiece(posTw + twelfths, remTw - twelfths) !== null) {
          out = twelfths;
          break;
        }
      }
    }
    memo.set(key, out);
    return out;
  };

  const segments: Array<{ start: number; rep: DurationRep }> = [];
  let posTw = startTw;
  let remaining = lenTw;
  while (remaining > 0) {
    const piece = firstPiece(posTw, remaining);
    if (piece === null || piece === 0) return null;
    const rep = VOCAB.find((v) => v.twelfths === piece)!.rep;
    segments.push({ start: posTw / 12, rep });
    posTw += piece;
    remaining -= piece;
  }
  return segments;
}

function measureIndexOf(start: number, beatsPerMeasure: number): number {
  return Math.floor(start / beatsPerMeasure + EPS);
}

interface OnsetGroup {
  start: number;
  end: number;
  pitches: number[];
}

// a contiguous run of the timeline sounding either notes or rest; twelfths
interface TimelineBlock {
  startTw: number;
  endTw: number;
  pitches: number[] | null; // null = rest
}

/**
 * Tile one voice's timeline [0, scoreEndTw) with note/rest blocks. Quantized
 * onsets can leave 1/12-beat slivers the duration vocabulary cannot express,
 * so each sliver is absorbed into a neighbouring block: after a block
 * (sustain or longer rest), before the score end (shorter trailing rest), or
 * — when there is no neighbour at all — by pulling the onset itself. Blocks
 * therefore tile the timeline exactly and are all ≥ 2 twelfths, which is
 * what guarantees every measure fills to the barline.
 */
function tileVoice(gs: OnsetGroup[], scoreEndTw: number, beatsPerMeasure: number): TimelineBlock[] {
  const perMeasure = beatsPerMeasure * 12;
  const blocks: TimelineBlock[] = [];
  let pos = 0; // tiling cursor in twelfths
  for (const g of gs) {
    let s = Math.round(g.start * 12);
    // Pieces never cross a barline, so two block boundaries are unnotatable
    // and the onset is pulled off them (a 41 ms shift, inaudible):
    // — 1 twelfth before a barline: the opening window fits no piece
    // — 1 twelfth after a barline: the tail would strand a 1/12 stub
    const last = blocks[blocks.length - 1];
    if (s % perMeasure === perMeasure - 1) {
      if (last && last.endTw === s && last.pitches && last.endTw - last.startTw <= MIN_BLOCK_TWELFTHS) {
        s = last.startTw; // fold a tiny neighbour into this chord
        blocks.pop();
      } else {
        s -= 1;
        if (last && last.endTw === s + 1) last.endTw -= 1; // trim the neighbour by 1/12
      }
    } else if (s > perMeasure && s % perMeasure === 1) {
      s -= 1;
      if (last && last.endTw === s + 1) last.endTw -= 1;
    }
    const gap = s - pos;
    if (gap === 1 && blocks.length > 0) {
      blocks[blocks.length - 1].endTw += 1; // sustain / tie over the sliver
    } else if (gap > 1) {
      blocks.push({ startTw: pos, endTw: s, pitches: null }); // rest fill
    } else if (gap === 1) {
      s = pos; // leading sliver: pull the note 1/12 beat earlier
    }
    let e = Math.max(Math.round(g.end * 12), s + MIN_BLOCK_TWELFTHS); // notate sub-1/6 notes
    // same boundary rules for tails: no stub after a barline, and no end
    // 1 twelfth short of one — the following rest would open in the dead
    // 1/12 window before the barline
    if (e % perMeasure === 1 || e % perMeasure === perMeasure - 1) e -= 1;
    const prev = blocks[blocks.length - 1];
    if (prev && prev.pitches && prev.endTw > s) {
      // padding collided with the next onset — sound both as one chord
      prev.endTw = Math.max(prev.endTw, e);
      for (const p of g.pitches) if (!prev.pitches.includes(p)) prev.pitches.push(p);
    } else {
      blocks.push({ startTw: s, endTw: e, pitches: [...g.pitches].sort((a, b) => a - b) });
    }
    pos = Math.max(pos, blocks[blocks.length - 1].endTw);
  }
  // trailing rest completes the final measure
  if (pos < scoreEndTw) {
    if (scoreEndTw - pos === 1 && blocks.length > 0) {
      const last = blocks[blocks.length - 1];
      if (last.endTw - last.startTw >= MIN_BLOCK_TWELFTHS + 1) {
        last.endTw -= 1; // give the last twelfth to the rest
      } else {
        last.endTw += 1; // block would become unnotatable — extend it instead
      }
      pos = last.endTw;
    }
    if (pos < scoreEndTw) blocks.push({ startTw: pos, endTw: scoreEndTw, pitches: null });
  }
  return blocks;
}

function makeItems(
  block: TimelineBlock,
  segments: Array<{ start: number; rep: DurationRep }>,
  keyMap: Record<string, '#' | 'b' | ''>,
  voice: number,
): MeasureItem[] {
  const keys = block.pitches === null ? ['b/4'] : block.pitches.map(midiToKeySpec);
  const isRest = block.pitches === null;
  return segments.map((seg, i) => {
    return {
      keys: isRest ? ['b/4'] : keys,
      duration: isRest ? `${seg.rep.code}r` : seg.rep.code,
      isRest,
      voice,
      accidentals: isRest ? [] : keys.map((_, k) => accidentalFor(keysToMidi(keys[k]), keyMap)),
      // a chain longer than one segment means its parts are tied together
      tieToNext: !isRest && i < segments.length - 1,
      tieFromPrev: !isRest && i > 0,
      beats: seg.rep.beats,
      tuplet: seg.rep.tuplet,
    };
  });
}

export function keysToMidi(key: string): number {
  // reverse of midiToKeySpec
  const [name, oct] = key.split('/');
  const base = BASE_PC[name[0]] ?? 0;
  return base + (name.length > 1 ? (name[1] === '#' ? 1 : -1) : 0) + (parseInt(oct, 10) + 1) * 12;
}

/**
 * Build items for a decomposed block and place each item into the measure
 * its segment belongs to, so ties across measure boundaries stay intact.
 */
function appendItems(
  measures: MeasureItem[][],
  block: TimelineBlock,
  segments: Array<{ start: number; rep: DurationRep }>,
  keyMap: Record<string, '#' | 'b' | ''>,
  voice: number,
  beatsPerMeasure: number,
): void {
  const items = makeItems(block, segments, keyMap, voice);
  segments.forEach((seg, i) => {
    const mi = measureIndexOf(seg.start, beatsPerMeasure);
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
    if (last && q.start - last.start < CHORD_MERGE_BEATS + EPS) {
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

  // 5. Tile each voice's timeline with note/rest blocks, then decompose the
  // blocks into notatable segments; tiling guarantees exact measure fills
  const measures: MeasureItem[][] = Array.from({ length: totalMeasures }, () => []);
  const scoreEndTw = totalMeasures * beatsPerMeasure * 12;
  voices.forEach((gs, voice) => {
    for (const block of tileVoice(gs, scoreEndTw, beatsPerMeasure)) {
      const segments = decomposeSpan(block.startTw, block.endTw - block.startTw, beatsPerMeasure);
      if (!segments) continue; // unreachable: tiling yields blocks ≥ 2 twelfths
      appendItems(measures, block, segments, keyMap, voice, beatsPerMeasure);
    }
  });

  // 6. Clamp overflow inside each measure per voice (rounding safety)
  for (let mi = 0; mi < measures.length; mi++) {
    const sums = new Map<number, number>();
    measures[mi] = measures[mi].map((item) => {
      const sum = sums.get(item.voice) ?? 0;
      if (sum + item.beats <= beatsPerMeasure + EPS) {
        sums.set(item.voice, sum + item.beats);
        return item;
      }
      const rep = pickDuration(beatsPerMeasure - sum);
      if (!rep) return item; // no representable duration fits — leave as is
      sums.set(item.voice, sum + rep.beats);
      return { ...item, duration: item.isRest ? `${rep.code}r` : rep.code, beats: rep.beats, tuplet: rep.tuplet };
    });
  }

  return { measures, settings, totalMeasures };
}
