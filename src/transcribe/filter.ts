import type { NoteEvent } from './transcribe';

export type NoiseFilterLevel = 'off' | 'low' | 'medium' | 'high';

interface FilterParams {
  // never drop above this absolute amplitude, even in quiet recordings
  minAmplitude: number;
  // ...and always drop below this multiple of the typical note amplitude
  amplitudeFactor: number;
  // shorter than this is reverb/spill, not an intentional note
  minDurationSeconds: number;
}

const LEVEL_PARAMS: Record<Exclude<NoiseFilterLevel, 'off'>, FilterParams> = {
  low: { minAmplitude: 0.15, amplitudeFactor: 0.35, minDurationSeconds: 0.06 },
  medium: { minAmplitude: 0.22, amplitudeFactor: 0.5, minDurationSeconds: 0.09 },
  high: { minAmplitude: 0.3, amplitudeFactor: 0.65, minDurationSeconds: 0.12 },
};

/**
 * Drop transcription noise: very quiet blobs (room noise, reverb spill from
 * mic re-recording) and implausibly short fragments. The amplitude cut is
 * adaptive — relative to the median amplitude of real notes in this
 * recording — so quiet but clean playing survives.
 */
export function filterNoiseEvents(
  events: NoteEvent[],
  level: NoiseFilterLevel,
): NoteEvent[] {
  if (level === 'off' || events.length === 0) return [...events];
  const { minAmplitude, amplitudeFactor, minDurationSeconds } = LEVEL_PARAMS[level];

  const amplitudes = events
    .filter((e) => e.durationSeconds >= minDurationSeconds)
    .map((e) => e.amplitude)
    .sort((a, b) => a - b);
  const median = amplitudes.length > 0 ? amplitudes[Math.floor(amplitudes.length / 2)] : 0;
  const threshold = Math.max(minAmplitude, median * amplitudeFactor);

  return events.filter((e) => {
    if (e.amplitude < threshold) return false; // quiet blobs are always noise
    if (e.durationSeconds >= minDurationSeconds) return true;
    // short but strong: fast real playing (e.g. rapid arpeggios), not spill
    return e.amplitude >= median * 0.75;
  });
}
