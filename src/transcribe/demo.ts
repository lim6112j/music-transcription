import type { NoteEvent } from './transcribe';

// Synthetic two-hand score for development/visual checks — load the app with
// ?demo to render it without running the transcription model. 4 bars of 4/4
// in Eb major at 120 BPM (1 beat = 0.5 s): [startBeat, durBeats, midi].
const SPECS: Array<[number, number, number, number]> = [
  // right hand: melody with eighths, a held ring, and one real triplet
  [0, 1, 75, 0.8],
  [1, 1, 79, 0.8],
  [2, 0.5, 82, 0.8],
  [2.5, 0.5, 80, 0.8],
  [3, 1, 79, 0.8],
  [4, 3, 79, 0.8], // rings past the next attacks — trimmed, emits pedal
  [5.5, 0.5, 77, 0.8],
  [6, 0.5, 75, 0.8],
  [6.5, 0.5, 74, 0.8],
  [7, 1, 75, 0.8],
  [8, 1 / 3, 79, 0.8],
  [8 + 1 / 3, 1 / 3, 82, 0.8],
  [8 + 2 / 3, 1 / 3, 84, 0.8],
  [9, 1, 82, 0.8],
  [10, 0.5, 79, 0.8],
  [10.5, 0.5, 77, 0.8],
  [11, 1, 75, 0.8],
  [12, 2, 74, 0.8],
  [14, 1, 72, 0.8],
  [15, 1, 75, 0.8],
  // left hand: quarter walk, a held whole note, final dotted half
  [0, 1, 39, 0.5],
  [1, 1, 46, 0.5],
  [2, 1, 51, 0.5],
  [3, 1, 46, 0.5],
  [4, 1, 43, 0.5],
  [5, 1, 46, 0.5],
  [6, 1, 48, 0.5],
  [7, 1, 46, 0.5],
  [8, 4, 39, 0.5],
  [12, 1, 51, 0.5],
  [13, 1, 46, 0.5],
  [14, 1, 43, 0.5],
  [15, 3, 39, 0.5],
];

export const DEMO_EVENTS: NoteEvent[] = SPECS.map(([start, dur, midi, amp]) => ({
  pitchMidi: midi,
  startTimeSeconds: start * 0.5,
  durationSeconds: dur * 0.5,
  amplitude: amp,
}));
