import type { NoteEvent } from './transcribe';

export type Hand = 0 | 1; // 0 = upper hand (treble staff), 1 = lower hand (bass staff)

// midpoints of candidate register gaps must fall in this window (D3..G4) —
// splits far outside it would put an entire hand on ledger lines anyway
const SPLIT_SEARCH_LOW = 50;
const SPLIT_SEARCH_HIGH = 70;
// a register gap must be at least this wide to be trusted as the hand boundary
const MIN_SPLIT_GAP_SEMITONES = 3;
// dense or monophonic writing shows no usable gap — split at middle C
const FALLBACK_SPLIT_MIDI = 60;

/**
 * Choose the pitch that separates the hands: the midpoint of the widest
 * register gap inside the middle-C search window, or middle C itself when
 * the writing is too contiguous to show one. Computed once per piece so
 * hand→staff assignment stays consistent across measures.
 */
export function handSplitPoint(events: NoteEvent[]): number {
  const pitches = [...new Set(events.map((e) => e.pitchMidi))].sort((a, b) => a - b);
  let bestGap = 0;
  let split = FALLBACK_SPLIT_MIDI;
  for (let i = 0; i < pitches.length - 1; i++) {
    const lo = pitches[i];
    const hi = pitches[i + 1];
    const mid = (lo + hi) / 2;
    if (mid < SPLIT_SEARCH_LOW || mid > SPLIT_SEARCH_HIGH) continue;
    if (hi - lo > bestGap) {
      bestGap = hi - lo;
      split = mid;
    }
  }
  return bestGap >= MIN_SPLIT_GAP_SEMITONES ? split : FALLBACK_SPLIT_MIDI;
}

export function handOf(pitchMidi: number, split: number): Hand {
  return pitchMidi > split ? 0 : 1;
}
