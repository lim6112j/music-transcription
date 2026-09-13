import { BasicPitch } from '@spotify/basic-pitch';
import { addPitchBendsToNoteEvents, noteFramesToTime, outputToNotesPoly } from '@spotify/basic-pitch';

export interface NoteEvent {
  pitchMidi: number;
  startTimeSeconds: number;
  durationSeconds: number;
  amplitude: number;
}

let modelPath = `${import.meta.env.BASE_URL}basic-pitch/model.json`;

const MODEL_SAMPLE_RATE = 22050;

async function resampleToModelRate(buffer: AudioBuffer): Promise<AudioBuffer> {
  if (buffer.sampleRate === MODEL_SAMPLE_RATE) return buffer;
  const frames = Math.ceil((buffer.duration * MODEL_SAMPLE_RATE) / 1);
  const offline = new OfflineAudioContext(1, frames, MODEL_SAMPLE_RATE);
  const source = offline.createBufferSource();
  source.buffer = buffer;
  source.connect(offline.destination);
  source.start();
  return offline.startRendering();
}

export async function transcribeAudio(
  buffer: AudioBuffer,
  onProgress: (percent: number) => void,
): Promise<NoteEvent[]> {
  const basicPitch = new BasicPitch(modelPath);
  // evaluateModel emits one callback per audio batch — accumulate all matrices
  // and extract notes once at the end so notes spanning batch boundaries merge.
  const frameArrs: number[][][] = [];
  const onsetArrs: number[][][] = [];
  const contourArrs: number[][][] = [];
  const modelRateBuffer = await resampleToModelRate(buffer);
  await basicPitch.evaluateModel(
    modelRateBuffer,
    (frames, onsets, contours) => {
      frameArrs.push(frames);
      onsetArrs.push(onsets);
      contourArrs.push(contours);
    },
    (percent) => onProgress(percent),
  );
  const concat = (arrs: number[][][]): number[][] => arrs.flat();
  const notes = noteFramesToTime(
    addPitchBendsToNoteEvents(contourArrs.flat(), outputToNotesPoly(concat(frameArrs), concat(onsetArrs))),
  );
  const collected: NoteEvent[] = notes.map((n) => ({
    pitchMidi: Math.round(n.pitchMidi),
    startTimeSeconds: n.startTimeSeconds,
    durationSeconds: n.durationSeconds,
    amplitude: n.amplitude,
  }));
  // sort by start then pitch for stable downstream processing
  collected.sort((a, b) => a.startTimeSeconds - b.startTimeSeconds || a.pitchMidi - b.pitchMidi);
  return collected;
}
