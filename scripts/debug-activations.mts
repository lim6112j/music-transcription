/* Debug: inspect raw Basic Pitch activations over time */
import { BasicPitch, noteFramesToTime, outputToNotesPoly } from '@spotify/basic-pitch';
import * as fs from 'fs';

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

function decodeWav22050(path: string): FakeAudioBuffer {
  const buf = fs.readFileSync(path);
  const n = (buf.length - 44) / 2;
  const pcm = new Float32Array(n);
  for (let i = 0; i < n; i++) pcm[i] = buf.readInt16LE(44 + i * 2) / 32768;
  return new FakeAudioBuffer(pcm, 22050);
}

async function main() {
  const buffer = decodeWav22050('/tmp/melody-22050.wav');
  console.log('duration:', buffer.duration.toFixed(2));
  const bp = new BasicPitch('http://localhost:5200/basic-pitch/model.json');
  const frames: number[][] = [];
  const onsets: number[][] = [];
  await bp.evaluateModel(
    buffer as unknown as AudioBuffer,
    (f, o) => {
      frames.push(...f);
      onsets.push(...o);
    },
    () => {},
  );

  console.log('frames shape:', frames.length, 'x', frames[0]?.length);
  console.log('global max frame activation:', Math.max(...frames.flat()).toFixed(3));
  const fps = frames.length / buffer.duration;
  for (let t0 = 0; t0 < buffer.duration; t0 += 0.5) {
    const a = Math.floor(t0 * fps);
    const b = Math.min(frames.length, Math.floor((t0 + 0.5) * fps));
    let max = 0;
    let maxBin = -1;
    for (let i = a; i < b; i++) {
      for (let p = 0; p < frames[i].length; p++) {
        if (frames[i][p] > max) {
          max = frames[i][p];
          maxBin = p;
        }
      }
    }
    const midi = maxBin >= 0 ? (24 + maxBin / 3).toFixed(1) : '-';
    console.log(`${t0.toFixed(1)}-${(t0 + 0.5).toFixed(1)}s max=${max.toFixed(3)} bin=${maxBin} midi=${midi}`);
  }
  const notes = noteFramesToTime(outputToNotesPoly(frames, onsets));
  console.log(
    'notes (default):',
    JSON.stringify(notes.map((n) => ({ p: Math.round(n.pitchMidi), t: +n.startTimeSeconds.toFixed(2), d: +n.durationSeconds.toFixed(2) }))),
  );
  const notes2 = noteFramesToTime(outputToNotesPoly(frames, onsets, 0.3, 0.1));
  console.log(
    'notes (0.3/0.1):',
    JSON.stringify(notes2.map((n) => ({ p: Math.round(n.pitchMidi), t: +n.startTimeSeconds.toFixed(2), d: +n.durationSeconds.toFixed(2) }))),
  );
}

main().catch((e) => {
  console.error('FAILED:', e);
  process.exit(1);
});
