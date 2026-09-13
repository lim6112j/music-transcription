import { useEffect, useRef } from 'react';
import {
  Accidental,
  Beam,
  Formatter,
  Renderer,
  Stave,
  StaveNote,
  StaveTie,
  Stem,
  Voice,
} from 'vexflow';
import type { BuiltScore, MeasureItem } from '../transcribe/notation';

const MEASURES_PER_ROW = 4;
const STAVE_WIDTH = 1050;
const ROW_HEIGHT = 160;
const SVG_WIDTH = STAVE_WIDTH + 20;
const SVG_HEIGHT = ROW_HEIGHT + 20;

export const SCORE_SHEET_ID = 'score-sheet';

export function ScoreView({ score }: { score: BuiltScore }) {
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
      const clef = settings.clef === 'auto' ? 'treble' : settings.clef;
      const rows = chunk(measures, MEASURES_PER_ROW);

      rows.forEach((rowMeasures, rowIndex) => {
        const rowDiv = document.createElement('div');
        rowDiv.className = 'score-row';
        container.appendChild(rowDiv);

        const renderer = new Renderer(rowDiv, Renderer.Backends.SVG);
        renderer.resize(SVG_WIDTH, SVG_HEIGHT);
        const ctx = renderer.getContext();
        const staveW = STAVE_WIDTH / rowMeasures.length;
        const firstMeasureAbsolute = rowIndex * MEASURES_PER_ROW;
        const tieFromByVoice = new Map<number, StaveNote[]>();

        rowMeasures.forEach((items, col) => {
          const absIndex = firstMeasureAbsolute + col;
          const stave = new Stave(10 + col * staveW, 10, staveW);
          if (col === 0) {
            stave.addClef(clef);
            stave.addKeySignature(settings.keySpec);
          }
          if (absIndex === 0) {
            stave.addTimeSignature(`${settings.beatsPerMeasure}/4`);
          }
          stave.setContext(ctx).draw();

          // partition the measure's items into their voice layers
          const byVoice = new Map<number, MeasureItem[]>();
          for (const item of items) {
            const list = byVoice.get(item.voice);
            if (list) list.push(item);
            else byVoice.set(item.voice, [item]);
          }
          const voiceEntries = [...byVoice.entries()].sort((a, b) => a[0] - b[0]);
          const multiVoice = voiceEntries.length > 1;

          const voices: Voice[] = [];
          const voiceNotes: StaveNote[][] = [];
          voiceEntries.forEach(([voiceIndex, voiceItems]) => {
            const notes = voiceItems.map((item) => {
              const note = new StaveNote({
                keys: item.keys,
                duration: item.duration,
                clef,
                autoStem: multiVoice ? voiceIndex > 1 : !item.isRest,
              });
              // keyboard convention: voice 1 stems up, voice 2 stems down
              if (multiVoice && voiceIndex === 1) note.setStemDirection(Stem.DOWN);
              if (!item.isRest) {
                item.accidentals.forEach((acc, i) => {
                  if (acc) note.addModifier(new Accidental(acc), i);
                });
              }
              return note;
            });

            const voice = new Voice({ numBeats: settings.beatsPerMeasure, beatValue: 4 });
            voice.setMode(Voice.Mode.FULL);
            voice.setStave(stave);
            voice.addTickables(notes);
            voices.push(voice);
            voiceNotes.push(notes);
          });

          try {
            new Formatter().joinVoices(voices).formatToStave(voices, stave);
          } catch {
            voices.forEach((v) => v.setMode(Voice.Mode.SOFT));
            new Formatter().joinVoices(voices).formatToStave(voices, stave);
          }
          voices.forEach((v) => v.draw(ctx, stave));

          voiceEntries.forEach(([voiceIndex, voiceItems], vi) => {
            const notes = voiceNotes[vi];

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
  }, [score]);

  return <div id={SCORE_SHEET_ID} ref={containerRef} className="score-sheet" />;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
