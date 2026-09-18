// Measure-fill invariants for buildScore: in N/4 time every voice's items in
// every measure must sum to exactly N beats — no silent holes.
// Run: node --test --experimental-strip-types src/transcribe/notation.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildScore, type BuiltScore, type MeasureItem } from './notation.ts';
import type { NoteEvent } from './transcribe.ts';

const EPS = 1e-9;

/** Events specified directly in beats (tempo 120 → 1 beat = 0.5 s). */
function beatsToEvents(specs: Array<[number, number, number]>): NoteEvent[] {
  return specs.map(([start, dur, midi]) => ({
    pitchMidi: midi,
    startTimeSeconds: start * 0.5,
    durationSeconds: dur * 0.5,
    amplitude: 0.8,
  }));
}

function shortVoiceMeasures(score: BuiltScore, beatsPerMeasure: number): string[] {
  const bad: string[] = [];
  score.measures.forEach((items: MeasureItem[], mi) => {
    const sums = new Map<string, number>();
    for (const it of items) {
      const key = `${it.hand}:${it.layer}`;
      sums.set(key, (sums.get(key) ?? 0) + it.beats);
    }
    for (const [voice, sum] of sums) {
      if (Math.abs(sum - beatsPerMeasure) > EPS) {
        bad.push(
          `m${mi + 1}v${voice}=${sum.toFixed(4)} [${items
            .filter((i) => `${i.hand}:${i.layer}` === voice)
            .map((i) => `${i.duration}${i.isRest ? 'r' : ''}${i.tuplet ? 't' : ''}@${i.beats}`)
            .join(' ')}]`,
        );
      }
    }
    if (items.length === 0) bad.push(`m${mi + 1}: empty`);
  });
  return bad;
}

function assertFullMeasures(specs: Array<[number, number, number]>, label: string, bpmMeasure = 4) {
  const score = buildScore(beatsToEvents(specs), {
    tempo: 120,
    beatsPerMeasure: bpmMeasure,
    clef: 'auto',
    keySpec: 'C',
  });
  const bad = shortVoiceMeasures(score, bpmMeasure);
  assert.deepEqual(bad, [], `${label}: measures not filled to ${bpmMeasure} beats`);
}

test('gap of 13/12 beats fills the measure exactly (greedy used to strand 1/12)', () => {
  assertFullMeasures(
    [
      [0, 1, 72],
      [1 + 13 / 12, 1, 74],
    ],
    '13/12 gap',
  );
});

test('note starting 1/12 before the midpoint no longer truncates the back half', () => {
  // used to render 1.917 beats: chain died at the 1/12 window before beat 2
  assertFullMeasures(
    [
      [2 - 1 / 12, 1, 72],
    ],
    'note before midpoint',
  );
});

test('realistic overlap case keeps both voices full', () => {
  // minimal repro from randomized search: second voice used to sum 1.917
  assertFullMeasures(
    [
      [0, 2, 89],
      [0.5, 0.75, 74],
      [1 + 2 / 12, 2 + 2 / 12, 75],
      [2 + 8 / 12, 2 + 2 / 12, 75],
    ],
    'two-hand overlap',
  );
});

test('more randomized minimal repros stay full', () => {
  const cases: Array<Array<[number, number, number]>> = [
    [
      [0, 2.5, 84],
      [1.25, 1 / 3, 78],
      [2 + 1 / 12, 0.75, 86],
      [2.25, 2 + 2 / 12, 64],
    ],
    [
      [0, 2.417, 76],
      [0.417, 1 + 1 / 3, 77],
    ],
    [
      [0, 1.167, 78],
      [1 + 1 / 12, 0.75, 65],
      [2 + 1 / 12, 1 / 6, 68],
    ],
    [
      [0, 1.667, 86],
      [0.833, 1 + 1 / 12, 82],
      [2.25, 2 + 5 / 12, 65],
    ],
  ];
  cases.forEach((specs, i) => assertFullMeasures(specs, `repro #${i + 1}`));
});

test('a 1/12-beat note survives and its measure still fills', () => {
  const score = buildScore(
    beatsToEvents([
      [1, 1 / 12, 72],
    ]),
    { tempo: 120, beatsPerMeasure: 4, clef: 'auto', keySpec: 'C' },
  );
  const notes = score.measures.flat().filter((i) => !i.isRest);
  assert.ok(notes.length > 0, 'short note vanished from the score');
  assert.deepEqual(shortVoiceMeasures(score, 4), []);
});

test('seeded realistic 800-note stream fills every measure in both voices', () => {
  let seed = 42;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return seed / 2 ** 31;
  };
  const specs: Array<[number, number, number]> = [];
  let t = 0;
  for (let i = 0; i < 800; i++) {
    const dur = [0.25, 0.5, 0.75, 1, 1.5, 2][Math.floor(rand() * 6)] * (0.85 + rand() * 0.3);
    specs.push([t, Math.max(1 / 12, dur), 60 + Math.floor(rand() * 24)]);
    t += dur * (0.8 + rand() * 0.5);
  }
  for (let i = 0; i < 120; i++) {
    specs.push([rand() * t, 1 + rand() * 3, 36 + Math.floor(rand() * 18)]);
  }
  specs.sort((a, b) => a[0] - b[0]);
  assertFullMeasures(specs, 'realistic stream');
});

test('arbitrary Basic-Pitch-like durations fill every measure', () => {
  let seed = 7;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return seed / 2 ** 31;
  };
  const specs: Array<[number, number, number]> = [];
  let t = 0;
  for (let i = 0; i < 400; i++) {
    specs.push([t, 0.3 + rand() * 1.9, 64 + Math.floor(rand() * 20)]);
    t += 0.2 + rand() * 0.8;
  }
  assertFullMeasures(specs, 'basic-pitch stream');
});

test('3/4 and 2/4 time signatures fill exactly too', () => {
  const specs: Array<[number, number, number]> = [
    [0, 1.25, 70],
    [1 + 1 / 12, 0.5, 72],
    [2 + 5 / 12, 1, 67],
  ];
  assertFullMeasures(specs, '3/4', 3);
  assertFullMeasures(specs, '2/4', 2);
});

test('notation stays musical: straight 16ths stay straight', () => {
  // four 16ths on the grid must render as 16ths, not tuplet-16ths
  const score = buildScore(
    beatsToEvents([
      [0, 0.25, 72],
      [0.25, 0.25, 74],
      [0.5, 0.25, 76],
      [0.75, 0.25, 77],
    ]),
    { tempo: 120, beatsPerMeasure: 4, clef: 'auto', keySpec: 'C' },
  );
  const firstVoice = score.measures[0].filter((i) => !i.isRest);
  assert.ok(
    firstVoice.slice(0, 4).every((i) => i.duration === '16' && !i.tuplet),
    `expected straight 16ths, got ${firstVoice.map((i) => `${i.duration}${i.tuplet ? 't' : ''}`).join(' ')}`,
  );
  assert.deepEqual(shortVoiceMeasures(score, 4), []);
});

test('a real triplet still renders as tuplets', () => {
  const score = buildScore(
    beatsToEvents([
      [0, 1 / 3, 72],
      [1 / 3, 1 / 3, 74],
      [2 / 3, 1 / 3, 76],
    ]),
    { tempo: 120, beatsPerMeasure: 4, clef: 'auto', keySpec: 'C' },
  );
  const firstVoice = score.measures[0].filter((i) => !i.isRest);
  assert.ok(
    firstVoice.slice(0, 3).every((i) => i.duration === '8' && i.tuplet),
    `expected triplet 8ths, got ${firstVoice.map((i) => `${i.duration}${i.tuplet ? 't' : ''}`).join(' ')}`,
  );
  assert.deepEqual(shortVoiceMeasures(score, 4), []);
});

test('bass and melody notes land in separate hands (grand staff)', () => {
  const score = buildScore(
    beatsToEvents([
      [0, 2, 45],
      [0, 2, 72],
      [2, 2, 48],
      [2, 2, 74],
    ]),
    { tempo: 120, beatsPerMeasure: 4, clef: 'auto', keySpec: 'C' },
  );
  const hands = new Set(score.measures.flat().map((i) => i.hand));
  assert.deepEqual([...hands].sort(), [0, 1]);
  // each hand's measure sums to a full 4 beats
  assert.deepEqual(shortVoiceMeasures(score, 4), []);
});

test('a sustained note is trimmed to the next onset and emits a pedal span', () => {
  const score = buildScore(
    beatsToEvents([
      [0, 6, 72], // held far past the next attack — pedal resonance
      [1, 1, 74],
      [2, 1, 76],
      [3, 1, 77],
    ]),
    { tempo: 120, beatsPerMeasure: 4, clef: 'auto', keySpec: 'C' },
  );
  const first = score.measures[0].find((i) => !i.isRest)!;
  assert.equal(first.duration, 'q'); // written as one beat, not tied
  assert.equal(first.tieToNext, false);
  assert.ok(score.pedals.length > 0, 'expected a heuristic pedal span');
  assert.equal(score.pedals[0].startBeat, 0);
});

test('a deliberately held final chord keeps its length with no pedal span', () => {
  const score = buildScore(
    beatsToEvents([
      [0, 4, 72],
    ]),
    { tempo: 120, beatsPerMeasure: 4, clef: 'auto', keySpec: 'C' },
  );
  const note = score.measures[0].find((i) => !i.isRest)!;
  assert.equal(note.duration, 'w');
  assert.deepEqual(score.pedals, []);
});

test('an isolated off-grid duration snaps straight instead of faking a triplet', () => {
  const score = buildScore(
    beatsToEvents([
      [0, 0.25, 72],
      [0.25, 0.25, 74],
      [0.5, 1 / 3, 76], // rubato-ish odd duration, no triplet neighbours
      [2, 2, 77],
    ]),
    { tempo: 120, beatsPerMeasure: 4, clef: 'auto', keySpec: 'C' },
  );
  const tuplets = score.measures[0].filter((i) => i.tuplet);
  assert.deepEqual(tuplets, [], 'no tuplet items should exist without triplet evidence');
  assert.deepEqual(shortVoiceMeasures(score, 4), []);
});

test('dynamics mark the opening level and later changes only', () => {
  const specs: Array<[number, number, number]> = [];
  // quiet first half, loud second half
  for (let i = 0; i < 16; i++) specs.push([i * 0.5, 0.45, 72 + (i % 5)]);
  for (let i = 0; i < 16; i++) specs.push([8 + i * 0.5, 0.45, 84 + (i % 5)]);
  const events = specs.map((s) => ({
    ...beatsToEvents([s])[0],
    amplitude: s[0] < 8 ? 0.3 : 0.9,
  }));
  const score = buildScore(events, {
    tempo: 120,
    beatsPerMeasure: 4,
    clef: 'auto',
    keySpec: 'C',
  });
  assert.ok(score.dynamics.length >= 2, `expected a dynamic change, got ${JSON.stringify(score.dynamics)}`);
  assert.equal(score.dynamics[0].measure, 0);
  // the first half is the quiet level, the change lands in the loud half
  assert.ok(score.dynamics[0].mark !== score.dynamics[score.dynamics.length - 1].mark);
});
