/* Debug buildScore output for the detected notes */
import { buildScore } from '../src/transcribe/notation';
import type { NoteEvent } from '../src/transcribe/transcribe';

const events: NoteEvent[] = [
  { pitchMidi: 60, startTimeSeconds: 0, durationSeconds: 0.58, amplitude: 1 },
  { pitchMidi: 64, startTimeSeconds: 0.71, durationSeconds: 0.57, amplitude: 1 },
  { pitchMidi: 67, startTimeSeconds: 1.4, durationSeconds: 0.58, amplitude: 1 },
  { pitchMidi: 72, startTimeSeconds: 2.1, durationSeconds: 0.57, amplitude: 1 },
  { pitchMidi: 67, startTimeSeconds: 2.8, durationSeconds: 0.58, amplitude: 1 },
  { pitchMidi: 64, startTimeSeconds: 3.51, durationSeconds: 0.57, amplitude: 1 },
  { pitchMidi: 72, startTimeSeconds: 4.21, durationSeconds: 0.43, amplitude: 0.5 },
  { pitchMidi: 60, startTimeSeconds: 4.19, durationSeconds: 0.71, amplitude: 1 },
  { pitchMidi: 60, startTimeSeconds: 4.9, durationSeconds: 0.58, amplitude: 1 },
];

const score = buildScore(events, { tempo: 86, beatsPerMeasure: 4, clef: 'treble', keySpec: 'C' });
console.log('totalMeasures:', score.totalMeasures);
score.measures.forEach((m, i) => {
  console.log(`measure ${i}:`);
  m.forEach((item) => {
    const label = item.isRest ? 'REST' : item.keys.join('+');
    const accs = item.isRest ? '' : ` accs=${JSON.stringify(item.accidentals)}`;
    console.log(`  ${item.duration} ${label}${accs} tieNext=${item.tieToNext} tiePrev=${item.tieFromPrev}`);
  });
});
