// MusicXML serializer in exportMusicXml.ts.
// Run: node --test --experimental-strip-types src/render/exportMusicXml.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildScore } from '../transcribe/notation.ts';
import type { NoteEvent } from '../transcribe/transcribe.ts';
import { buildScoreToMusicXml } from './exportMusicXml.ts';

function beatsToEvents(specs: Array<[number, number, number]>): NoteEvent[] {
  return specs.map(([start, dur, midi]) => ({
    pitchMidi: midi,
    startTimeSeconds: start * 0.5,
    durationSeconds: dur * 0.5,
    amplitude: 0.8,
  }));
}

const TWO_HAND: Array<[number, number, number]> = [
  [0, 2, 44], // Ab2 — a signature tone of Eb major
  [0, 2, 72],
  [2, 2, 48],
  [2, 2, 74],
];

function grandScore(keySpec = 'Eb') {
  return buildScore(beatsToEvents(TWO_HAND), {
    tempo: 120,
    beatsPerMeasure: 4,
    clef: 'auto',
    keySpec,
    title: 'Test & <score>',
  });
}

test('grand-staff scores declare two staves, two clefs, and backup between them', () => {
  const xml = buildScoreToMusicXml(grandScore());
  assert.ok(xml.includes('<staves>2</staves>'));
  assert.ok(xml.includes('<sign>G</sign>'));
  assert.ok(xml.includes('<sign>F</sign>'));
  assert.ok(xml.includes('<backup>'));
  assert.ok(xml.includes('<staff>2</staff>'));
  assert.ok(xml.includes('<voice>5</voice>'));
});

test('attributes carry divisions, key fifths, and time', () => {
  const xml = buildScoreToMusicXml(grandScore('Eb'));
  assert.ok(xml.includes('<divisions>12</divisions>'));
  assert.ok(xml.includes('<fifths>-3</fifths>'));
  assert.ok(xml.includes('<mode>major</mode>'));
  assert.ok(xml.includes('<beats>4</beats>'));
});

test('flat keys spell pitches as flats with correct alter values', () => {
  const xml = buildScoreToMusicXml(grandScore('Eb'));
  assert.ok(xml.includes('<alter>-1</alter>')); // Ab from midi 45
  // no sharp spelling should appear in a flat key
  assert.ok(!xml.includes('<alter>1</alter>'), 'flat key must not spell sharps');
});

test('a chromatic tone in a flat key exports as a flat spelling', () => {
  const score = buildScore(beatsToEvents([[0, 4, 61]]), {
    tempo: 120,
    beatsPerMeasure: 4,
    clef: 'auto',
    keySpec: 'Eb',
    title: 'Db',
  });
  const xml = buildScoreToMusicXml(score);
  assert.ok(xml.includes('<step>D</step>'), 'expected Db spelled for midi 61');
  assert.ok(xml.includes('<alter>-1</alter>'));
});

test('the final measure ends with a light-heavy barline', () => {
  const xml = buildScoreToMusicXml(grandScore());
  assert.ok(xml.includes('<barline location="right">'));
  assert.ok(xml.includes('<bar-style>light-heavy</bar-style>'));
});

test('real triplets export time-modification and tuplet notation', () => {
  const score = buildScore(
    beatsToEvents([
      [0, 1 / 3, 72],
      [1 / 3, 1 / 3, 74],
      [2 / 3, 1 / 3, 76],
    ]),
    { tempo: 120, beatsPerMeasure: 4, clef: 'auto', keySpec: 'C' },
  );
  const xml = buildScoreToMusicXml(score);
  assert.ok(xml.includes('<actual-notes>3</actual-notes>'));
  assert.ok(xml.includes('<normal-notes>2</normal-notes>'));
  assert.ok(xml.includes('<tuplet type="start"/>'));
  assert.ok(xml.includes('<tuplet type="stop"/>'));
});

test('ties export both tie elements and tied notations', () => {
  const score = buildScore(
    beatsToEvents([
      [0, 5, 72],
    ]),
    { tempo: 120, beatsPerMeasure: 4, clef: 'auto', keySpec: 'C' },
  );
  const xml = buildScoreToMusicXml(score);
  assert.ok(xml.includes('<tie type="start"/>'));
  assert.ok(xml.includes('<tie type="stop"/>'));
  assert.ok(xml.includes('<tied type="start"/>'));
});

test('single-staff scores omit staves and use one clef', () => {
  const score = buildScore(beatsToEvents([[0, 4, 72]]), {
    tempo: 120,
    beatsPerMeasure: 4,
    clef: 'auto',
    keySpec: 'C',
  });
  const xml = buildScoreToMusicXml(score);
  assert.ok(!xml.includes('<staves>'));
  assert.ok(!xml.includes('<backup>'));
  assert.ok(!xml.includes('<staff>1</staff>'));
  assert.ok(xml.includes('<voice>1</voice>'));
});

test('the title is XML-escaped and attribution is present', () => {
  const xml = buildScoreToMusicXml(grandScore());
  assert.ok(xml.includes('<work-title>Test &amp; &lt;score&gt;</work-title>'));
  assert.ok(xml.includes('Transcribed with StaffScribe'));
});

test('the output is well-formed XML (balanced tags)', () => {
  const xml = buildScoreToMusicXml(grandScore());
  const stack: string[] = [];
  const tags = xml.match(/<\/?[A-Za-z][^>]*>/g) ?? [];
  for (const tag of tags) {
    if (tag.startsWith('<?') || tag.startsWith('<!')) continue;
    const name = tag.replace(/^<\/?/, '').split(/[\s>/]/)[0];
    if (tag.startsWith('</')) {
      const open = stack.pop();
      assert.equal(open, name, `mismatched close tag ${name}, open was ${open}`);
    } else if (!tag.endsWith('/>')) {
      stack.push(name);
    }
  }
  assert.deepEqual(stack, [], 'unclosed elements remain');
});
