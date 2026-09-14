import { useEffect, useRef } from 'react';
import {
  Accidental,
  Beam,
  Formatter,
  Renderer,
  Stave,
  StaveConnector,
  StaveNote,
  StaveTie,
  Tuplet,
  Voice,
} from 'vexflow';
import type { BuiltScore, MeasureItem } from '../transcribe/notation';
import { pickMeasuresPerRow } from '../transcribe/notation';

const STAVE_WIDTH = 1050;
const SVG_WIDTH = STAVE_WIDTH + 20;
// single-staff row height (single-voice scores)
const BASE_ROW_HEIGHT = 160;
// grand staff (piano notation): treble staff on top, bass below, joined
const GRAND_STAFF_ROW_HEIGHT = 240;
const TREBLE_Y = 10;
const BASS_Y = 170;
// VexFlow's default tick-to-width softmax; the spacing slider scales it
const BASE_SOFTMAX_FACTOR = 10;
const SPACING_STORAGE_KEY = 'staffscribe.spacing';

export function loadSpacing(): number {
  return Number(localStorage.getItem(SPACING_STORAGE_KEY)) || 1;
}

export function saveSpacing(spacing: number): void {
  if (spacing === 1) localStorage.removeItem(SPACING_STORAGE_KEY);
  else localStorage.setItem(SPACING_STORAGE_KEY, String(spacing));
}

export const SCORE_SHEET_ID = 'score-sheet';

export function ScoreView({ score, spacing = 1 }: { score: BuiltScore; spacing?: number }) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let cancelled = false;

    const draw = async () => {
      try {
        await document.fonts.ready;
      } catch {
        /* font API unavailable — draw anyway */
      }
      if (cancelled) return;
      container.innerHTML = '';

      const { measures, settings } = score;
      // grand staff (piano notation) when any measure layers two hands
      const isGrand = measures.some((m) => m.some((i) => i.voice > 0));
      const singleClef = settings.clef === 'auto' ? 'treble' : settings.clef;

      // fewer measures per row when the music is dense or the user wants
      // extra spacing, so notes keep human-readable gaps
      const denseRows = pickMeasuresPerRow(measures.map((m) => m.length));
      const measuresPerRow = Math.max(1, Math.round(denseRows / spacing));
      const rows = chunk(measures, measuresPerRow);

      rows.forEach((rowMeasures, rowIndex) => {
        const rowDiv = document.createElement('div');
        rowDiv.className = 'score-row';
        container.appendChild(rowDiv);

        const svgHeight = (isGrand ? GRAND_STAFF_ROW_HEIGHT : BASE_ROW_HEIGHT) + 20;
        const renderer = new Renderer(rowDiv, Renderer.Backends.SVG);
        renderer.resize(SVG_WIDTH, svgHeight);
        const ctx = renderer.getContext();
        const staveW = STAVE_WIDTH / rowMeasures.length;
        const firstMeasureAbsolute = rowIndex * measuresPerRow;
        const tieFromByVoice = new Map<number, StaveNote[]>();

        rowMeasures.forEach((items, col) => {
          const absIndex = firstMeasureAbsolute + col;

          // per-row median pitch of a voice, for hand/staff assignment
          const medianMidi = (voiceItems: MeasureItem[]): number => {
            const pitches = voiceItems
              .filter((it) => !it.isRest)
              .flatMap((it) => it.keys.map(keyToMidi))
              .sort((a, b) => a - b);
            return pitches.length > 0 ? pitches[Math.floor(pitches.length / 2)] : -1;
          };

          // partition the measure's items into their voice layers
          const byVoice = new Map<number, MeasureItem[]>();
          for (const item of items) {
            const list = byVoice.get(item.voice);
            if (list) list.push(item);
            else byVoice.set(item.voice, [item]);
          }
          const voiceEntries = [...byVoice.entries()].sort((a, b) => a[0] - b[0]);

          // one staff per hand: the higher hand reads the treble staff, the
          // lower hand the bass staff (2-voice cap keeps this unambiguous)
          const staves = {
            treble: new Stave(10 + col * staveW, TREBLE_Y, staveW),
            bass: isGrand ? new Stave(10 + col * staveW, BASS_Y, staveW) : null,
          };
          const staffForVoice = new Map<number, 'treble' | 'bass'>();
          if (isGrand) {
            const sorted = voiceEntries
              .map(([vi, viItems]) => ({ vi, median: medianMidi(viItems) }))
              .sort((a, b) => b.median - a.median || a.vi - b.vi);
            sorted.forEach((entry, rank) => {
              staffForVoice.set(entry.vi, rank === 0 ? 'treble' : 'bass');
            });
          }
          const staveOf = (vi: number): Stave =>
            staffForVoice.get(vi) === 'bass' ? staves.bass! : staves.treble;
          const clefOf = (vi: number): 'treble' | 'bass' => staffForVoice.get(vi) ?? 'treble';

          if (col === 0) {
            staves.treble.addClef(isGrand ? 'treble' : singleClef);
            staves.treble.addKeySignature(settings.keySpec);
            if (staves.bass) {
              staves.bass.addClef('bass');
              staves.bass.addKeySignature(settings.keySpec);
            }
          }
          if (absIndex === 0) {
            staves.treble.addTimeSignature(`${settings.beatsPerMeasure}/4`);
            staves.bass?.addTimeSignature(`${settings.beatsPerMeasure}/4`);
          }
          staves.treble.setContext(ctx).draw();
          staves.bass?.setContext(ctx).draw();
          if (isGrand) {
            // brace + right barline joining the two staves
            new StaveConnector(staves.treble, staves.bass!)
              .setType(StaveConnector.type.BRACE)
              .setContext(ctx)
              .draw();
            new StaveConnector(staves.treble, staves.bass!)
              .setType(StaveConnector.type.SINGLE_RIGHT)
              .setContext(ctx)
              .draw();
          }

          const formatter = new Formatter({ softmaxFactor: BASE_SOFTMAX_FACTOR * spacing });

          // build + format each hand's voice on its own staff
          voiceEntries.forEach(([voiceIndex, voiceItems]) => {
            const voiceStave = staveOf(voiceIndex);
            const notes = voiceItems.map((item) => {
              const note = new StaveNote({
                keys: item.keys,
                duration: item.duration,
                clef: clefOf(voiceIndex),
                autoStem: !isGrand && !item.isRest,
              });
              if (!item.isRest) {
                item.accidentals.forEach((acc, i) => {
                  if (acc) note.addModifier(new Accidental(acc), i);
                });
              }
              return note;
            });

            // group consecutive same-code tuplet notes into 3:2 triplet
            // groups (Tuplet rescales their ticks to 2/3); every complete
            // group of 3 gets a bracket, leftovers keep the same tick
            // scaling via the multiplier so voice math stays exact
            let run: StaveNote[] = [];
            const flushRun = () => {
              if (run.length === 3) {
                new Tuplet(run, { numNotes: 3, notesOccupied: 2 }).setContext(ctx).draw();
              } else {
                run.forEach((n) => n.applyTickMultiplier(2, 3));
              }
              run = [];
            };
            for (let i = 0; i < voiceItems.length; i++) {
              const item = voiceItems[i];
              const prev = voiceItems[i - 1];
              if (item.tuplet) {
                const continues =
                  run.length > 0 && prev?.tuplet && prev.duration === item.duration;
                if (!continues && run.length > 0) flushRun();
                run.push(notes[i]);
                if (run.length === 3) flushRun();
              } else if (run.length > 0) {
                flushRun();
              }
            }
            flushRun();

            let voice = new Voice({ numBeats: settings.beatsPerMeasure, beatValue: 4 });
            voice.setMode(Voice.Mode.FULL);
            voice.setStave(voiceStave);
            try {
              voice.addTickables(notes);
            } catch {
              // tick overflow guard: rebuild in SOFT mode instead of losing
              // the whole measure
              voice = new Voice({ numBeats: settings.beatsPerMeasure, beatValue: 4 });
              voice.setMode(Voice.Mode.SOFT);
              voice.setStave(voiceStave);
              voice.addTickables(notes);
            }
            try {
              formatter.joinVoices([voice]).formatToStave([voice], voiceStave);
              voice.draw(ctx, voiceStave);
            } catch {
              /* skip unformattable voice */
            }

            // beams for eighth/shorter notes
            const beamable = notes.filter(
              (n) => !n.isRest() && ['8', '8d', '16'].includes(n.getDuration()),
            );
            if (beamable.length > 1) {
              try {
                Beam.generateBeams(beamable).forEach((b) => b.setContext(ctx).draw());
              } catch {
                /* skip malformed beams */
              }
            }

            // tie from the previous measure
            const tieFrom = tieFromByVoice.get(voiceIndex);
            if (tieFrom) {
              const first = notes[0];
              if (first && !first.isRest()) {
                const count = Math.min(tieFrom[0].keys.length, first.keys.length);
                for (let i = 0; i < count; i++) {
                  try {
                    new StaveTie({
                      firstNote: tieFrom[0],
                      lastNote: first,
                      firstIndexes: [i],
                      lastIndexes: [i],
                    })
                      .setContext(ctx)
                      .draw();
                  } catch {
                    /* skip tie on failure */
                  }
                }
              }
            }

            // ties between segments split within this measure
            for (let k = 0; k < voiceItems.length - 1; k++) {
              if (!voiceItems[k].tieToNext || !voiceItems[k + 1].tieFromPrev) continue;
              const a = notes[k];
              const b = notes[k + 1];
              if (!a || a.isRest() || !b || b.isRest()) continue;
              const count = Math.min(a.keys.length, b.keys.length);
              for (let i = 0; i < count; i++) {
                try {
                  new StaveTie({
                    firstNote: a,
                    lastNote: b,
                    firstIndexes: [i],
                    lastIndexes: [i],
                  })
                    .setContext(ctx)
                    .draw();
                } catch {
                  /* skip tie on failure */
                }
              }
            }

            // carry a tie across the barline
            const lastItem = voiceItems[voiceItems.length - 1];
            const lastNote = notes[notes.length - 1];
            if (lastItem && lastItem.tieToNext && !lastItem.isRest && lastNote) {
              tieFromByVoice.set(voiceIndex, [lastNote]);
            } else {
              tieFromByVoice.delete(voiceIndex);
            }
          });
        });
      });
    };

    void draw();
    return () => {
      cancelled = true;
    };
  }, [score, spacing]);

  return <div id={SCORE_SHEET_ID} ref={containerRef} className="score-sheet" />;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// VexFlow key spec ('c#/4') -> MIDI note number, for voice ordering
function keyToMidi(key: string): number {
  const [name, oct] = key.split('/');
  const base: Record<string, number> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };
  let midi = (base[name[0]] ?? 0) + (parseInt(oct ?? '4', 10) + 1) * 12;
  if (name.includes('#')) midi += 1;
  if (name.includes('b')) midi -= 1;
  return midi;
}
