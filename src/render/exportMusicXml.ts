import type { BuiltScore, MeasureItem } from '../transcribe/notation';
import { keyFifths } from '../transcribe/spelling.ts';

// 1/12-beat grid → 12 divisions per quarter note; every notatable duration
// (including triplet values) is an integer number of divisions
const DIVISIONS = 12;
// voice numbers per staff: staff 1 uses 1–2, staff 2 uses 5–6 (the common
// convention, so MuseScore/Dorico read the staves back correctly)
const VOICES: Record<number, [number, number]> = { 1: [1, 2], 2: [5, 6] };

const TYPE_NAMES: Record<string, string> = {
  w: 'whole',
  h: 'half',
  q: 'quarter',
  '8': 'eighth',
  '16': '16th',
};

const ACCIDENTAL_NAMES: Record<string, string> = { '#': 'sharp', b: 'flat', n: 'natural' };

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 'db/4' → step D, alter -1, octave 4 (letter-relative octave). */
function parseKeySpec(key: string): { step: string; alter: number; octave: number } {
  const [name, oct] = key.split('/');
  const step = name[0].toUpperCase();
  const alter = name.length > 1 ? (name[1] === '#' ? 1 : -1) : 0;
  return { step, alter, octave: parseInt(oct, 10) };
}

function typeInfo(code: string): { type: string; dots: number } {
  const base = code.replace('r', '');
  const dotted = base.endsWith('d');
  const stem = dotted ? base.slice(0, -1) : base;
  return { type: TYPE_NAMES[stem] ?? 'quarter', dots: dotted ? 1 : 0 };
}

interface VoiceBlock {
  staff: 1 | 2 | null; // null = single-staff score
  voice: number;
  items: MeasureItem[];
}

/** Group a measure's items into staff/voice blocks in notation order. */
function voiceBlocks(items: MeasureItem[], grand: boolean): VoiceBlock[] {
  const byKey = new Map<string, MeasureItem[]>();
  for (const item of items) {
    const key = `${item.hand}:${item.layer}`;
    const list = byKey.get(key);
    if (list) list.push(item);
    else byKey.set(key, [item]);
  }
  const blocks: VoiceBlock[] = [];
  const hands = grand ? [0, 1] : [0];
  for (const hand of hands) {
    for (const layer of [0, 1] as const) {
      const list = byKey.get(`${hand}:${layer}`);
      if (!list) continue;
      blocks.push({
        staff: grand ? ((hand + 1) as 1 | 2) : null,
        voice: VOICES[hand + 1][layer],
        items: list,
      });
    }
  }
  return blocks;
}

/** Tuplet runs of exactly 3 same-duration items get bracket start/stop. */
function tupletMarks(items: MeasureItem[]): Array<'start' | 'stop' | null> {
  const marks: Array<'start' | 'stop' | null> = items.map(() => null);
  let run: number[] = [];
  const flush = () => {
    if (run.length === 3) {
      marks[run[0]] = 'start';
      marks[run[run.length - 1]] = 'stop';
    }
    run = [];
  };
  items.forEach((item, i) => {
    const prev = items[i - 1];
    if (item.tuplet) {
      const continues = run.length > 0 && prev?.tuplet && prev.duration === item.duration;
      if (!continues && run.length > 0) flush();
      run.push(i);
      if (run.length === 3) flush();
    } else if (run.length > 0) {
      flush();
    }
  });
  flush();
  return marks;
}

function noteElement(
  item: MeasureItem,
  keyIndex: number,
  voice: number,
  staff: 1 | 2 | null,
  tupletMark: 'start' | 'stop' | null,
): string {
  const out: string[] = ['      <note>'];
  const duration = Math.round(item.beats * DIVISIONS);
  if (keyIndex > 0) out.push('        <chord/>');
  if (item.isRest) {
    out.push('        <rest/>');
  } else {
    const { step, alter, octave } = parseKeySpec(item.keys[keyIndex]);
    out.push('        <pitch>');
    out.push(`          <step>${step}</step>`);
    if (alter !== 0) out.push(`          <alter>${alter}</alter>`);
    out.push(`          <octave>${octave}</octave>`);
    out.push('        </pitch>');
  }
  out.push(`        <duration>${duration}</duration>`);
  if (!item.isRest) {
    if (item.tieFromPrev) out.push('        <tie type="stop"/>');
    if (item.tieToNext) out.push('        <tie type="start"/>');
  }
  out.push(`        <voice>${voice}</voice>`);
  const { type, dots } = typeInfo(item.duration);
  out.push(`        <type>${type}</type>`);
  for (let i = 0; i < dots; i++) out.push('        <dot/>');
  if (!item.isRest && item.accidentals[keyIndex]) {
    out.push(`        <accidental>${ACCIDENTAL_NAMES[item.accidentals[keyIndex]!]}</accidental>`);
  }
  if (item.tuplet) {
    out.push('        <time-modification>');
    out.push('          <actual-notes>3</actual-notes>');
    out.push('          <normal-notes>2</normal-notes>');
    out.push('        </time-modification>');
  }
  if (staff !== null) out.push(`        <staff>${staff}</staff>`);
  const notations: string[] = [];
  if (!item.isRest) {
    if (item.tieFromPrev) notations.push('          <tied type="stop"/>');
    if (item.tieToNext) notations.push('          <tied type="start"/>');
  }
  if (tupletMark) notations.push(`          <tuplet type="${tupletMark}"/>`);
  if (notations.length > 0) {
    out.push('        <notations>');
    out.push(...notations);
    out.push('        </notations>');
  }
  out.push('      </note>');
  return out.join('\n');
}

/**
 * Serialize a BuiltScore to MusicXML (score-partwise, one piano part, two
 * staves in grand-staff scores). Open the result in MuseScore or Dorico to
 * finish polishing by hand.
 */
export function buildScoreToMusicXml(score: BuiltScore): string {
  const { measures, settings, totalMeasures } = score;
  const grand = measures.some((m) => m.some((i) => i.hand === 1));
  const { fifths, mode } = keyFifths(settings.keySpec);
  const measureDuration = settings.beatsPerMeasure * DIVISIONS;
  const title = escapeXml(settings.title ?? 'Untitled');

  const out: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">',
    '<score-partwise version="4.0">',
    '  <work>',
    `    <work-title>${title}</work-title>`,
    '  </work>',
    '  <identification>',
    '    <creator type="composer">Transcribed with StaffScribe</creator>',
    '  </identification>',
    '  <part-list>',
    '    <score-part id="P1">',
    '      <part-name>Piano</part-name>',
    '    </score-part>',
    '  </part-list>',
    '  <part id="P1">',
  ];

  measures.forEach((items, mi) => {
    out.push(`    <measure number="${mi + 1}">`);
    if (mi === 0) {
      out.push('      <attributes>');
      out.push(`        <divisions>${DIVISIONS}</divisions>`);
      out.push('        <key>');
      out.push(`          <fifths>${fifths}</fifths>`);
      out.push(`          <mode>${mode}</mode>`);
      out.push('        </key>');
      out.push('        <time>');
      out.push(`          <beats>${settings.beatsPerMeasure}</beats>`);
      out.push('          <beat-type>4</beat-type>');
      out.push('        </time>');
      if (grand) {
        out.push('        <staves>2</staves>');
        out.push('        <clef number="1">');
        out.push('          <sign>G</sign>');
        out.push('          <line>2</line>');
        out.push('        </clef>');
        out.push('        <clef number="2">');
        out.push('          <sign>F</sign>');
        out.push('          <line>4</line>');
        out.push('        </clef>');
      } else {
        const [sign, line] = settings.clef === 'bass' ? ['F', '4'] : ['G', '2'];
        out.push('        <clef number="1">');
        out.push(`          <sign>${sign}</sign>`);
        out.push(`          <line>${line}</line>`);
        out.push('        </clef>');
      }
      out.push('      </attributes>');
    }

    const blocks = voiceBlocks(items, grand);
    if (blocks.length === 0) {
      // safety net: an empty measure still needs a full-measure rest
      out.push('      <note>');
      out.push('        <rest/>');
      out.push(`        <duration>${measureDuration}</duration>`);
      out.push('        <voice>1</voice>');
      out.push('        <type>whole</type>');
      out.push('      </note>');
    }
    blocks.forEach((block, bi) => {
      if (bi > 0) {
        out.push('      <backup>');
        out.push(`        <duration>${measureDuration}</duration>`);
        out.push('      </backup>');
      }
      const marks = tupletMarks(block.items);
      block.items.forEach((item, ii) => {
        for (let k = 0; k < item.keys.length; k++) {
          out.push(noteElement(item, k, block.voice, block.staff, k === 0 ? marks[ii] : null));
        }
      });
    });

    if (mi === totalMeasures - 1) {
      out.push('      <barline location="right">');
      out.push('        <bar-style>light-heavy</bar-style>');
      out.push('      </barline>');
    }
    out.push('    </measure>');
  });

  out.push('  </part>', '</score-partwise>', '');
  return out.join('\n');
}
