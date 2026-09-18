// Sustain trimming + heuristic pedal detection in sustain.ts.
// Run: node --test --experimental-strip-types src/transcribe/sustain.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trimSustain, type SustainGroup } from './sustain.ts';

function group(spec: [number, number, number[], 0 | 1, 0 | 1]): SustainGroup {
  const [start, end, pitches, hand, layer] = spec;
  return { start, end, pitches, amplitude: 0.8, hand, layer };
}

test('a note is written as lasting until the next attack in its layer', () => {
  const { groups } = trimSustain([
    group([0, 6, [72], 0, 0]),
    group([1, 1.5, [74], 0, 0]),
  ]);
  assert.equal(groups[0].end, 1); // trimmed from 6 beats to the next onset
  assert.equal(groups[1].end, 1.5);
});

test('a held note with no later attack in its layer is never trimmed', () => {
  const { groups } = trimSustain([group([0, 8, [48], 1, 0])]);
  assert.equal(groups[0].end, 8); // a final chord stays whole
});

test('right-hand activity does not truncate a left-hand hold', () => {
  const { groups } = trimSustain([
    group([0, 4, [45], 1, 0]),
    group([0.5, 1, [72], 0, 0]),
    group([1, 1.5, [74], 0, 0]),
  ]);
  assert.equal(groups.find((g) => g.pitches[0] === 45)!.end, 4);
});

test('voice layers trim independently within a hand', () => {
  // melody layer holds while an inner layer moves every beat
  const { groups } = trimSustain([
    group([0, 4, [79], 0, 0]),
    group([0, 1, [72], 0, 1]),
    group([1, 1, [67], 0, 1]),
    group([2, 1, [64], 0, 1]),
    group([3, 1, [60], 0, 1]),
  ]);
  assert.equal(groups.find((g) => g.pitches[0] === 79)!.end, 4);
  assert.equal(groups.find((g) => g.pitches[0] === 72)!.end, 1);
});

test('long excess sustain produces merged pedal spans', () => {
  const { pedals } = trimSustain([
    group([0, 5, [72], 0, 0]), // written 1 beat — 4 beats of excess
    group([1, 1.5, [74], 0, 0]),
    group([5.2, 9, [76], 0, 0]), // written 6 — 3 beats of excess, gap-adjacent
    group([6, 6.5, [77], 0, 0]),
    group([20, 21.4, [72], 0, 0]), // 0.4-beat excess — below the pedal threshold
    group([20.5, 22, [74], 0, 0]),
  ]);
  assert.equal(pedals.length, 1);
  assert.equal(pedals[0].startBeat, 0);
  assert.equal(pedals[0].endBeat, 9);
});

test('deliberately held notes do not read as pedal', () => {
  const { pedals } = trimSustain([
    group([0, 2, [72], 0, 0]),
    group([2, 2, [74], 0, 0]),
  ]);
  assert.deepEqual(pedals, []);
});

test('trimming never moves a note start', () => {
  const { groups } = trimSustain([
    group([0.25, 3, [60], 0, 0]),
    group([1, 1.5, [64], 0, 0]),
  ]);
  assert.equal(groups[0].start, 0.25);
  assert.ok(groups[0].end > groups[0].start);
});
