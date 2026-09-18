import type { Hand } from './hands';

/**
 * A chord group already placed in a hand and voice layer, still carrying the
 * raw (sustained) end time it had in the audio.
 */
export interface SustainGroup {
  start: number; // beats from score start (quantized)
  end: number; // beats — raw sustained end, not the notated value
  pitches: number[];
  amplitude: number; // max member amplitude, for dynamics
  hand: Hand;
  layer: 0 | 1;
}

export interface PedalSpan {
  startBeat: number;
  endBeat: number;
}

// sustain exceeding the written value by at least this much reads as pedal,
// not as a deliberately held note
const PEDAL_MIN_EXCESS_BEATS = 1;
// pedal moments closer than this merge into a single marking
const PEDAL_MERGE_GAP_BEATS = 0.25;
// a later attack within this distance reads as the same melodic line, so a
// ringing note is trimmed to it even across voice layers; farther attacks
// belong to independent lines (accompaniment under a held note)
const NEAR_PITCH_SEMITONES = 5;
const EPS = 1e-6;

function minPitchDistance(a: number[], b: number[]): number {
  let min = Infinity;
  for (const x of a) {
    for (const y of b) {
      const d = Math.abs(x - y);
      if (d < min) min = d;
    }
  }
  return min;
}

/**
 * Rewrite sustained durations the way a transcriber would: each chord lasts
 * until the next attack in its voice layer, or — for same-line writing —
 * until the next near-pitch attack in the same hand (pedal resonance is
 * notated with Ped. marks, never as tie chains). Held notes with no later
 * attack in their layer keep their full length — a final chord stays whole.
 * Where the raw sustain exceeds the written value by PEDAL_MIN_EXCESS_BEATS
 * the excess contributes to a pedal span. Pure — input is not modified.
 */
export function trimSustain(groups: SustainGroup[]): {
  groups: Array<SustainGroup>;
  pedals: PedalSpan[];
} {
  const byLayer = new Map<string, SustainGroup[]>();
  const byHand = new Map<Hand, SustainGroup[]>();
  for (const g of groups) {
    const layerKey = `${g.hand}:${g.layer}`;
    const layerList = byLayer.get(layerKey);
    if (layerList) layerList.push(g);
    else byLayer.set(layerKey, [g]);
    const handList = byHand.get(g.hand);
    if (handList) handList.push(g);
    else byHand.set(g.hand, [g]);
  }

  // first same-hand onset whose pitch is close enough to be the same line
  const nextNear = new Map<SustainGroup, number>();
  for (const handGroups of byHand.values()) {
    const sorted = [...handGroups].sort((a, b) => a.start - b.start);
    for (let i = 0; i < sorted.length; i++) {
      let found = Infinity;
      for (let j = i + 1; j < sorted.length; j++) {
        if (sorted[j].start <= sorted[i].start + EPS) continue;
        if (minPitchDistance(sorted[i].pitches, sorted[j].pitches) < NEAR_PITCH_SEMITONES) {
          found = sorted[j].start;
          break;
        }
      }
      nextNear.set(sorted[i], found);
    }
  }

  const trimmed: Array<SustainGroup> = [];
  const excesses: PedalSpan[] = [];
  for (const layerGroups of byLayer.values()) {
    const sorted = [...layerGroups].sort((a, b) => a.start - b.start);
    // nextOnset[i]: the first group onset strictly after sorted[i].start
    const nextOnset = new Array<number>(sorted.length).fill(Infinity);
    for (let i = sorted.length - 2; i >= 0; i--) {
      nextOnset[i] =
        sorted[i + 1].start > sorted[i].start + EPS ? sorted[i + 1].start : nextOnset[i + 1];
    }
    for (let i = 0; i < sorted.length; i++) {
      const g = sorted[i];
      const writtenEnd = Math.min(g.end, nextOnset[i], nextNear.get(g) ?? Infinity);
      const written = { ...g, end: Math.max(writtenEnd, g.start) };
      if (g.end - written.end >= PEDAL_MIN_EXCESS_BEATS - EPS) {
        excesses.push({ startBeat: g.start, endBeat: g.end });
      }
      trimmed.push(written);
    }
  }
  return { groups: trimmed, pedals: mergeSpans(excesses) };
}

function mergeSpans(spans: PedalSpan[]): PedalSpan[] {
  const sorted = [...spans].sort((a, b) => a.startBeat - b.startBeat);
  const merged: PedalSpan[] = [];
  for (const span of sorted) {
    const last = merged[merged.length - 1];
    if (last && span.startBeat <= last.endBeat + PEDAL_MERGE_GAP_BEATS + EPS) {
      merged[merged.length - 1] = { ...last, endBeat: Math.max(last.endBeat, span.endBeat) };
    } else {
      merged.push({ ...span });
    }
  }
  return merged;
}
