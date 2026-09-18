// Hand-split heuristics in hands.ts.
// Run: node --test --experimental-strip-types src/transcribe/hands.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handOf, handSplitPoint } from './hands.ts';
import type { NoteEvent } from './transcribe.ts';

function note(midi: number): NoteEvent {
  return { pitchMidi: midi, startTimeSeconds: 0, durationSeconds: 0.5, amplitude: 0.8 };
}

test('a clear register gap between bass and melody becomes the split point', () => {
  const events = [48, 50, 52, 53, 72, 74, 76, 79].map(note);
  const split = handSplitPoint(events);
  // widest gap in the window: 53 -> 72, midpoint 62.5
  assert.equal(split, 62.5);
  assert.equal(handOf(53, split), 1);
  assert.equal(handOf(72, split), 0);
});

test('gaps whose midpoint is outside the middle-C window are ignored', () => {
  // gap 31 -> 45 has midpoint 38, below the search window
  const events = [31, 45, 46, 47].map(note);
  assert.equal(handSplitPoint(events), 60);
});

test('contiguous writing falls back to middle C', () => {
  const events = [55, 56, 57, 58, 59, 60, 61, 62].map(note);
  assert.equal(handSplitPoint(events), 60);
});

test('middle C itself belongs to the lower hand', () => {
  assert.equal(handOf(60, 60), 1);
  assert.equal(handOf(61, 60), 0);
});

test('a single-hand score keeps all notes in one hand', () => {
  const events = [72, 74, 76, 77].map(note);
  const split = handSplitPoint(events);
  const hands = new Set(events.map((e) => handOf(e.pitchMidi, split)));
  assert.equal(hands.size, 1);
});
