import { useEffect, useRef } from 'react';
import {
  Accidental,
  Beam,
  Formatter,
  Renderer,
  Stave,
  StaveNote,
  StaveTie,
  Voice,
} from 'vexflow';
import type { BuiltScore } from '../transcribe/notation';

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
        let tieFrom: StaveNote[] | null = null;

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

          const notes = items.map((item) => {
            const note = new StaveNote({
              keys: item.keys,
              duration: item.duration,
              clef,
              autoStem: !item.isRest,
            });
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
          try {
            new Formatter().joinVoices([voice]).formatToStave([voice], stave);
          } catch {
            voice.setMode(Voice.Mode.SOFT);
            new Formatter().joinVoices([voice]).formatToStave([voice], stave);
          }
          voice.draw(ctx, stave);

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

          // ties from the previous measure
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

          const lastItem = items[items.length - 1];
          tieFrom = lastItem && lastItem.tieToNext && !lastItem.isRest ? [notes[notes.length - 1]] : null;
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
