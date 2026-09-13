/* End-to-end headless test: Basic Pitch inference + notation pipeline */
import * as tf from '@tensorflow/tfjs';
import { BasicPitch, addPitchBendsToNoteEvents, noteFramesToTime, outputToNotesPoly } from '@spotify/basic-pitch';
import { estimateTempo, estimateKeySpec, detectClef, buildScore } from '../src/transcribe/notation';
import * as fs from 'fs';

// --- minimal AudioBuffer polyfill ---
class FakeAudioBuffer {
  sampleRate: number;
  length: number;
  duration: number;
  numberOfChannels = 1;
  private data: Float32Array;
  constructor(data: Float32Array, sampleRate: number) {
    this.data = data;
    this.sampleRate = sampleRate;
    this.length = data.length;
    this.duration = data.length / sampleRate;
  }
  getChannelData(): Float32Array {
    return this.data;
  }
}

// decode 16-bit mono PCM WAV, downsample to 22050 Hz (model requirement)
function decodeWav(path: string): FakeAudioBuffer {
  const buf = fs.readFileSync(path);
  const dataOffset = 44;
  const n = (buf.length - dataOffset) / 2;
  const pcm441 = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    pcm441[i] = buf.readInt16LE(dataOffset + i * 2) / 32768;
  }
  const ratio = 2; // 44100 -> 22050
  const pcm = new Float32Array(Math.floor(n / ratio));
  for (let i = 0; i < pcm.length; i++) {
    const j = Math.floor(i * ratio);
    pcm[i] = (pcm441[j] + pcm441[Math.min(n - 1, j + 1)]) / 2;
  }
  return new FakeAudioBuffer(pcm, 22050);
}

async function main() {
  const buffer = decodeWav('/tmp/melody-test.wav');
  console.log('audio duration:', buffer.duration.toFixed(2), 's');

  const bp = new BasicPitch('http://localhost:5200/basic-pitch/model.json');
  let notes: Array<{ startTimeSeconds: number; durationSeconds: number; pitchMidi: number }> = [];
  await bp.evaluateModel(buffer as unknown as AudioBuffer, (frames, onsets, contours) => {
    notes = noteFramesToTime(addPitchBendsToNoteEvents(contours, outputToNotesPoly(frames, onsets)));
  }, () => {});
  const rounded = notes.map((n) => ({ ...n, pitchMidi: Math.round(n.pitchMidi) }));
  console.log('detected notes:', JSON.stringify(rounded.map(n => ({p: n.pitchMidi, t: +n.startTimeSeconds.toFixed(2), d: +n.durationSeconds.toFixed(2)}))));

  const expected = [60, 64, 67, 72, 67, 64, 60, 60]; // C4 E4 G4 C5 G4 E4 C4 C4
  const missed = expected.filter((p) => !rounded.some((n) => Math.abs(n.pitchMidi - p) <= 1));
  if (missed.length > 2) throw new Error(`Too many missed notes: ${missed.join(',')}`);
  console.log('pitch check passed (missed:', missed.length, ')');

  const tempo = estimateTempo(rounded);
  const key = estimateKeySpec(rounded, tempo);
  const clef = detectClef(rounded);
  console.log('tempo:', tempo, 'key:', key, 'clef:', clef);

  const score = buildScore(rounded, { tempo, beatsPerMeasure: 4, clef, keySpec: key });
  console.log('measures:', score.totalMeasures);
  const allItems = score.measures.flat();
  const noteItems = allItems.filter((i) => !i.isRest);
  console.log('note items:', noteItems.length, 'rest items:', allItems.length - noteItems.length);
  console.log('sample items:', JSON.stringify(noteItems.slice(0, 4)));
  if (noteItems.length < 6) throw new Error('Too few rendered notes');
  for (const m of score.measures) {
    const beats = m.reduce((s, i) => {
      const base = i.duration.replace('r', '');
      const table: Record<string, number> = { w: 4, hd: 3, h: 2, qd: 1.5, q: 1, '8d': 0.75, '8': 0.5, '16': 0.25 };
      return s + (table[base] ?? 0);
    }, 0);
    if (Math.abs(beats - 4) > 0.01) throw new Error(`Measure does not sum to 4 beats: ${beats}`);
  }
  console.log('ALL CHECKS PASSED');
  await tf.disposeVariables?.();
}

main().catch((e) => {
  console.error('FAILED:', e);
  process.exit(1);
});
