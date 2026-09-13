import { beatsOf, keysToMidi, type BuiltScore } from '../transcribe/notation';

export interface PlaybackHandle {
  stop(): void;
}

const START_DELAY_S = 0.1;
const MASTER_GAIN = 0.4;
const NOTE_VELOCITY = 0.8;
const ATTACK_S = 0.008;
const RELEASE_S = 0.05;
const MAX_NOTES = 8000;

interface ScheduledNote {
  startBeat: number;
  durationBeats: number;
  midis: number[];
}

/**
 * Recover absolute timing from BuiltScore: each (measure, voice) pair is laid
 * out sequentially and sums exactly to beatsPerMeasure, so walking items in
 * order reconstructs every item's start beat. Tied segments of the same
 * pitch chain are merged into one sounding note.
 */
export function buildNoteSchedule(score: BuiltScore): ScheduledNote[] {
  const { measures, settings } = score;
  const notes: ScheduledNote[] = [];
  const lastByVoice = new Map<number, ScheduledNote>();

  measures.forEach((items, mi) => {
    // keep voices independent: walk each voice's items in order
    const byVoice = new Map<number, typeof items>();
    for (const item of items) {
      const list = byVoice.get(item.voice);
      if (list) list.push(item);
      else byVoice.set(item.voice, [item]);
    }
    for (const voiceItems of byVoice.values()) {
      let beat = mi * settings.beatsPerMeasure;
      for (const item of voiceItems) {
        const beats = beatsOf(item.duration);
        if (!item.isRest && item.keys.length > 0) {
          const prev = notes.length > 0 ? lastByVoice.get(item.voice) : undefined;
          const samePitch =
            prev &&
            item.tieFromPrev &&
            prev.midis.length === item.keys.length &&
            prev.midis.every((m, i) => m === keysToMidi(item.keys[i]));
          if (prev && samePitch) {
            prev.durationBeats += beats; // tie: sustain, don't re-articulate
          } else {
            const note: ScheduledNote = {
              startBeat: beat,
              durationBeats: beats,
              midis: item.keys.map(keysToMidi),
            };
            notes.push(note);
            lastByVoice.set(item.voice, note);
          }
        }
        beat += beats;
      }
    }
  });
  return notes.slice(0, MAX_NOTES);
}

/**
 * Play a BuiltScore through a simple synth voice per note. Must be called
 * from a user gesture so the AudioContext is allowed to start.
 */
export function playScore(
  score: BuiltScore,
  onMeasureChange?: (measureIndex: number) => void,
): PlaybackHandle {
  const ctx = new AudioContext();
  const master = ctx.createGain();
  master.gain.value = MASTER_GAIN;
  master.connect(ctx.destination);

  const spb = 60 / score.settings.tempo;
  const t0 = ctx.currentTime + START_DELAY_S;
  const totalMeasures = score.totalMeasures;
  const measureEnd = t0 + totalMeasures * score.settings.beatsPerMeasure * spb;

  for (const note of buildNoteSchedule(score)) {
    const start = t0 + note.startBeat * spb;
    const end = start + note.durationBeats * spb;
    for (const midi of note.midis) {
      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.value = 440 * 2 ** ((midi - 69) / 12);
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(NOTE_VELOCITY, start + ATTACK_S);
      gain.gain.exponentialRampToValueAtTime(0.0001, Math.max(end, start + ATTACK_S + 0.05));
      osc.connect(gain).connect(master);
      osc.start(start);
      osc.stop(end + RELEASE_S);
      osc.onended = () => {
        osc.disconnect();
        gain.disconnect();
      };
    }
  }

  // report the current measure while playing
  let lastReported = -1;
  const tick = () => {
    if (ctx.state === 'closed') return;
    const elapsed = ctx.currentTime - t0;
    const measure = Math.floor(elapsed / (score.settings.beatsPerMeasure * spb));
    if (measure !== lastReported) {
      lastReported = measure;
      if (measure >= 0 && measure < totalMeasures) onMeasureChange?.(measure);
    }
    if (ctx.currentTime < measureEnd) requestAnimationFrame(tick);
    else onMeasureChange?.(-1); // finished
  };
  requestAnimationFrame(tick);

  return {
    stop() {
      void ctx.close();
      onMeasureChange?.(-1);
    },
  };
}
