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
  Tuplet,
  Voice,
} from 'vexflow';
import type { BuiltScore, MeasureItem } from '../transcribe/notation';
import { pickMeasuresPerRow } from '../transcribe/notation';

const STAVE_WIDTH = 1050;
const BASE_ROW_HEIGHT = 160;
const MULTI_VOICE_ROW_HEIGHT = 210;
const SVG_WIDTH = STAVE_WIDTH + 20;

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
      // fewer measures per row when the music is dense, so spacing stays readable
      const measuresPerRow = pickMeasuresPerRow(measures.map((m) => m.length));
      const rows = chunk(measures, measuresPerRow);

      rows.forEach((rowMeasures, rowIndex) => {
        const rowDiv = document.createElement('div');
        rowDiv.className = 'score-row';
        container.appendChild(rowDiv);

        // multi-voice rows need vertical room for separated stems
        const rowMultiVoice = rowMeasures.some((items) => items.some((i) => i.voice > 0));
        const svgHeight = (rowMultiVoice ? MULTI_VOICE_ROW_HEIGHT : BASE_ROW_HEIGHT) + 20;
        const renderer = new Renderer(rowDiv, Renderer.Backends.SVG);
        renderer.resize(SVG_WIDTH, svgHeight);
        const ctx = renderer.getContext();
        const staveW = STAVE_WIDTH / rowMeasures.length;
        const firstMeasureAbsolute = rowIndex * measuresPerRow;
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

          // keyboard convention: the upper voice stems up, the lower stems
          // down — decided per row by each voice's median pitch
          const medianMidi = (voiceItems: MeasureItem[]): number => {
            const pitches = voiceItems
              .filter((it) => !it.isRest)
              .flatMap((it) => it.keys.map(keyToMidi))
              .sort((a, b) => a - b);
            return pitches.length > 0 ? pitches[Math.floor(pitches.length / 2)] : -1;
          };
          const stemUpVoices = new Set<number>();
          if (multiVoice) {
            const sorted = [...voiceEntries].sort(
              (a, b) => medianMidi(b[1]) - medianMidi(a[1]) || a[0] - b[0],
            );
            sorted.slice(0, Math.ceil(sorted.length / 2)).forEach(([vi]) => stemUpVoices.add(vi));
          }

          const voices: Voice[] = [];
          const voiceNotes: StaveNote[][] = [];
          const tupletInstances: Tuplet[] = [];
          voiceEntries.forEach(([voiceIndex, voiceItems]) => {
            const notes = voiceItems.map((item) => {
              const note = new StaveNote({
                keys: item.keys,
                duration: item.duration,
                clef,
                autoStem: !multiVoice && !item.isRest,
              });
              if (multiVoice && !item.isRest) {
                note.setStemDirection(stemUpVoices.has(voiceIndex) ? Stem.UP : Stem.DOWN);
              }
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
                tupletInstances.push(new Tuplet(run, { numNotes: 3, notesOccupied: 2 }));
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
            voice.setStave(stave);
            try {
              voice.addTickables(notes);
            } catch {
              // tick overflow guard: rebuild in SOFT mode instead of losing
              // the whole measure
              voice = new Voice({ numBeats: settings.beatsPerMeasure, beatValue: 4 });
              voice.setMode(Voice.Mode.SOFT);
              voice.setStave(stave);
              voice.addTickables(notes);
            }
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
          tupletInstances.forEach((t) => t.setContext(ctx).draw());

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

// VexFlow key spec ('c#/4') -> MIDI note number, for voice ordering
function keyToMidi(key: string): number {
  const [name, oct] = key.split('/');
  const base: Record<string, number> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };
  let midi = (base[name[0]] ?? 0) + (parseInt(oct ?? '4', 10) + 1) * 12;
  if (name.includes('#')) midi += 1;
  if (name.includes('b')) midi -= 1;
  return midi;
}
