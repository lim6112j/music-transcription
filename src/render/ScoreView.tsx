import { useEffect, useRef } from 'react';
import {
  Accidental,
  Barline,
  Beam,
  Formatter,
  Fraction,
  PedalMarking,
  Renderer,
  Stave,
  StaveConnector,
  StaveNote,
  StaveTie,
  Stem,
  Tuplet,
  Voice,
  type RenderContext,
} from 'vexflow';
import type { BuiltScore, DynamicMark, MeasureItem } from '../transcribe/notation';
import { pickMeasuresPerRow } from '../transcribe/notation';
import type { Hand } from '../transcribe/hands.ts';

const STAVE_WIDTH = 1050;
const SVG_WIDTH = STAVE_WIDTH + 20;
// single-staff row height (single-voice scores)
const BASE_ROW_HEIGHT = 170;
// grand staff (piano notation): treble staff on top, bass below, joined.
// Deep enough for pedal markings below the bass staff (PedalMarking draws
// ~4 staff spaces under the bottom line).
const GRAND_STAFF_ROW_HEIGHT = 300;
// VexFlow renders the first staff line ~41px below the Stave y (its built-in
// spaceAboveStaffLn), so these constructor values give ~51px of headroom
// above the treble staff for beams, tuplet numerals and ties
const TREBLE_Y = 10;
const BASS_Y = 170;
// headroom on the first system for the title / tempo header block
const TITLE_BLOCK_HEIGHT = 88;
const TITLE_SIZE = 22;
const SUBTITLE_SIZE = 11;
const TEMPO_GLYPH_SIZE = 20;
const TEMPO_SIZE = 14;
const DYNAMIC_SIZE = 15;
const EPS = 1e-6;
// Bravura quarter-note glyph for the metronome mark
const QUARTER_GLYPH = '\u{E1D5}';
const INK = '#241f31';
const SUBTLE = '#6b6577';
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

export function ScoreView({
  score,
  spacing = 1,
  onDeleteRow,
}: {
  score: BuiltScore;
  spacing?: number;
  /** Called with the absolute measure range of a row when its ✕ is clicked. */
  onDeleteRow?: (startMeasure: number, count: number) => void;
}) {
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
      // grand staff (piano notation) when material is assigned to both hands
      const isGrand = measures.some((m) => m.some((i) => i.hand === 1));
      const singleClef = settings.clef === 'auto' ? 'treble' : settings.clef;
      const beatsPerMeasure = settings.beatsPerMeasure;

      // fewer measures per row when the music is dense or the user wants
      // extra spacing, so notes keep human-readable gaps
      const denseRows = pickMeasuresPerRow(measures.map((m) => m.length));
      const measuresPerRow = Math.max(1, Math.round(denseRows / spacing));
      const rows = chunk(measures, measuresPerRow);
      // dynamics: show a mark at each system start where the level changed
      let shownMark: DynamicMark | null = null;

      rows.forEach((rowMeasures, rowIndex) => {
        const rowDiv = document.createElement('div');
        rowDiv.className = 'score-row';
        container.appendChild(rowDiv);

        // editing affordance: remove this row's measures from the score.
        // HTML overlay (not SVG) so the PDF exporter, which reads only the
        // <svg> elements, never sees it; print hides it via CSS.
        if (onDeleteRow) {
          const firstMeasure = rowIndex * measuresPerRow;
          const deleteBtn = document.createElement('button');
          deleteBtn.type = 'button';
          deleteBtn.className = 'row-delete';
          deleteBtn.textContent = '✕';
          deleteBtn.title = 'Delete this row of measures';
          deleteBtn.setAttribute(
            'aria-label',
            `Delete measures ${firstMeasure + 1}–${firstMeasure + rowMeasures.length}`,
          );
          deleteBtn.addEventListener('click', () => onDeleteRow(firstMeasure, rowMeasures.length));
          rowDiv.appendChild(deleteBtn);
        }

        const rowYOffset = rowIndex === 0 ? TITLE_BLOCK_HEIGHT : 0;
        const svgHeight =
          (isGrand ? GRAND_STAFF_ROW_HEIGHT : BASE_ROW_HEIGHT) + 20 + rowYOffset;
        const renderer = new Renderer(rowDiv, Renderer.Backends.SVG);
        renderer.resize(SVG_WIDTH, svgHeight);
        const ctx = renderer.getContext();
        const staveW = STAVE_WIDTH / rowMeasures.length;
        const firstMeasureAbsolute = rowIndex * measuresPerRow;
        const rowStartBeat = firstMeasureAbsolute * beatsPerMeasure;
        const rowEndBeat = rowStartBeat + rowMeasures.length * beatsPerMeasure;
        const tieFromByVoice = new Map<string, StaveNote[]>();
        // notes of this row with their score position, for pedal placement
        const rowNotes: Array<{ note: StaveNote; onsetBeat: number; hand: Hand }> = [];

        if (rowIndex === 0) drawTitleBlock(ctx);

        rowMeasures.forEach((items, col) => {
          const absIdx = firstMeasureAbsolute + col;
          try {
            drawMeasure(items, col, absIdx, rowYOffset);
          } catch (e) {
            // one malformed measure must never truncate the rest of the score
            console.warn(`ScoreView: measure ${absIdx} failed to draw`, e);
          }
        });

        drawRowPedals(ctx, rowStartBeat, rowEndBeat);

        const active = [...score.dynamics].reverse().find((d) => d.measure <= firstMeasureAbsolute);
        if (active && active.mark !== shownMark) {
          drawDynamic(ctx, active.mark, rowYOffset);
          shownMark = active.mark;
        }

        function drawTitleBlock(ctx: RenderContext): void {
          const title = settings.title ?? 'Untitled';
          ctx.setFont('Academico', TITLE_SIZE, 'bold');
          ctx.setFillStyle(INK);
          ctx.fillText(title, (SVG_WIDTH - ctx.measureText(title).width) / 2, 34);
          ctx.setFont('Academico', SUBTITLE_SIZE);
          ctx.setFillStyle(SUBTLE);
          const subtitle = 'Transcribed with StaffScribe';
          ctx.fillText(subtitle, (SVG_WIDTH - ctx.measureText(subtitle).width) / 2, 54);
          // metronome mark: quarter-note glyph + "= tempo"
          ctx.setFont('Bravura', TEMPO_GLYPH_SIZE);
          ctx.setFillStyle(INK);
          ctx.fillText(QUARTER_GLYPH, 14, 78);
          const glyphW = ctx.measureText(QUARTER_GLYPH).width;
          ctx.setFont('Academico', TEMPO_SIZE);
          ctx.fillText(`= ${settings.tempo}`, 14 + glyphW + 6, 78);
        }

        function drawDynamic(ctx: RenderContext, mark: DynamicMark, yOff: number): void {
          ctx.setFont('Academico', DYNAMIC_SIZE, 'bold', 'italic');
          ctx.setFillStyle(INK);
          // below the bass staff in grand mode (the gap between staves is
          // occupied by the brace and clef at the left edge); below the one
          // staff in single-staff mode
          const y = isGrand ? BASS_Y + 106 + yOff : 135 + yOff;
          ctx.fillText(mark, 16, y);
        }

        function drawRowPedals(ctx: RenderContext, rowStartBeat: number, rowEndBeat: number): void {
          // pedal markings conventionally sit under the bass staff
          const pedalNotes = isGrand ? rowNotes.filter((n) => n.hand === 1) : rowNotes;
          if (pedalNotes.length === 0) return;
          for (const span of score.pedals) {
            if (span.endBeat <= rowStartBeat + EPS || span.startBeat >= rowEndBeat - EPS) continue;
            const fromBeat = Math.max(span.startBeat, rowStartBeat);
            const toBeat = Math.min(span.endBeat, rowEndBeat);
            const down = pedalNotes.find((n) => n.onsetBeat >= fromBeat - EPS);
            const up = [...pedalNotes].reverse().find((n) => n.onsetBeat <= toBeat + EPS);
            if (!down || !up || down.note === up.note) continue;
            try {
              PedalMarking.createSustain([down.note, up.note])
                .setLine(1) // default line 3 hangs very deep under the staff
                .setContext(ctx)
                .draw();
            } catch (e) {
              console.warn('ScoreView: pedal marking failed to draw', e);
            }
          }
        }

        function drawMeasure(items: MeasureItem[], col: number, absIdx: number, yOff: number): void {
          // partition the measure's items into (hand, layer) voice layers
          const byVoice = new Map<string, MeasureItem[]>();
          for (const item of items) {
            const key = `${item.hand}:${item.layer}`;
            const list = byVoice.get(key);
            if (list) list.push(item);
            else byVoice.set(key, [item]);
          }
          const voices = [...byVoice.entries()]
            .map(([key, voiceItems]) => {
              const [hand, layer] = key.split(':').map(Number) as [Hand, 0 | 1];
              return { key, hand, layer, items: voiceItems };
            })
            .sort((a, b) => a.hand - b.hand || a.layer - b.layer);

          // one staff per hand: hand 0 reads the treble staff, hand 1 the bass
          const staves = {
            treble: new Stave(10 + col * staveW, TREBLE_Y + yOff, staveW),
            bass: isGrand ? new Stave(10 + col * staveW, BASS_Y + yOff, staveW) : null,
          };
          const staveOf = (hand: Hand): Stave => (isGrand && hand === 1 ? staves.bass! : staves.treble);
          const clefOf = (hand: Hand): 'treble' | 'bass' =>
            isGrand ? (hand === 1 ? 'bass' : 'treble') : singleClef;
          // when both layers share a staff, stems are forced apart
          const layersOn = (hand: Hand) =>
            new Set(voices.filter((v) => v.hand === hand).map((v) => v.layer));

          if (col === 0) {
            staves.treble.addClef(isGrand ? 'treble' : singleClef);
            staves.treble.addKeySignature(settings.keySpec);
            // measure number at each system start
            staves.treble.setMeasure(absIdx + 1);
            if (staves.bass) {
              staves.bass.addClef('bass');
              staves.bass.addKeySignature(settings.keySpec);
            }
          }
          if (absIdx === 0) {
            staves.treble.addTimeSignature(`${beatsPerMeasure}/4`);
            staves.bass?.addTimeSignature(`${beatsPerMeasure}/4`);
          }
          if (absIdx === score.totalMeasures - 1) {
            // the score ends with a proper double barline
            staves.treble.setEndBarType(Barline.type.END);
            staves.bass?.setEndBarType(Barline.type.END);
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

          // build + format each hand layer's voice on its own staff
          voices.forEach(({ hand, layer, items: voiceItems }) => {
            const voiceStave = staveOf(hand);
            const forcedStems = isGrand && layersOn(hand).size > 1;
            const stemDirection = forcedStems ? (layer === 0 ? Stem.UP : Stem.DOWN) : undefined;
            const notes = voiceItems.map((item) => {
              const note = new StaveNote({
                keys: item.keys,
                duration: item.duration,
                clef: clefOf(hand),
                ...(stemDirection !== undefined
                  ? { stem_direction: stemDirection }
                  : { autoStem: true }),
              });
              if (!item.isRest) {
                item.accidentals.forEach((acc, i) => {
                  if (acc) note.addModifier(new Accidental(acc), i);
                });
                rowNotes.push({ note, onsetBeat: item.onsetBeat, hand });
              }
              return note;
            });

            // group consecutive same-code tuplet notes into 3:2 triplet
            // groups (Tuplet rescales their ticks to 2/3); every complete
            // group of 3 gets a bracket, leftovers keep the same tick
            // scaling via the multiplier so voice math stays exact
            const tuplets: Tuplet[] = [];
            let run: StaveNote[] = [];
            const flushRun = () => {
              if (run.length === 3) {
                // the constructor scales the notes' ticks to 2/3 (needed
                // before addTickables); the bracket itself is drawn after
                // formatting, when the notes have x/y positions
                tuplets.push(new Tuplet(run, { numNotes: 3, notesOccupied: 2 }));
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

            let voice = new Voice({ numBeats: beatsPerMeasure, beatValue: 4 });
            voice.setMode(Voice.Mode.FULL);
            voice.setStave(voiceStave);
            try {
              voice.addTickables(notes);
            } catch {
              // tick overflow guard: rebuild in SOFT mode instead of losing
              // the whole measure
              voice = new Voice({ numBeats: beatsPerMeasure, beatValue: 4 });
              voice.setMode(Voice.Mode.SOFT);
              voice.setStave(voiceStave);
              voice.addTickables(notes);
            }
            try {
              formatter.joinVoices([voice]).formatToStave([voice], voiceStave);
            } catch (e) {
              // a skipped voice is missing notes — surface it, don't lose it
              console.warn('ScoreView: voice failed to format', e);
            }

            // beams for eighth/shorter notes, grouped per quarter-note beat
            // so the downbeat stays visible. generateBeams must run BEFORE
            // voice.draw: it attaches each beam to its notes (suppressing
            // their own stems and flags) and unifies stem directions per
            // group, so notes and beam render consistently.
            const beamable = notes.filter(
              (n) => !n.isRest() && ['8', '8d', '16'].includes(n.getDuration()),
            );
            let beams: Beam[] = [];
            if (beamable.length > 1) {
              try {
                beams = Beam.generateBeams(beamable, { groups: [new Fraction(1, 4)] });
              } catch (e) {
                console.warn('ScoreView: beam generation failed', e);
              }
            }

            try {
              voice.draw(ctx, voiceStave);
            } catch (e) {
              console.warn('ScoreView: voice failed to draw', e);
            }

            // the beam draws the stems itself, then tuplet brackets need the
            // final note positions
            beams.forEach((b) => {
              try {
                b.setContext(ctx).draw();
              } catch (e) {
                console.warn('ScoreView: beam failed to draw', e);
              }
            });
            tuplets.forEach((tuplet) => {
              try {
                tuplet.setContext(ctx).draw();
              } catch (e) {
                console.warn('ScoreView: tuplet failed to draw', e);
              }
            });

            const voiceKey = `${hand}:${layer}`;

            // tie from the previous measure
            const tieFrom = tieFromByVoice.get(voiceKey);
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
              tieFromByVoice.set(voiceKey, [lastNote]);
            } else {
              tieFromByVoice.delete(voiceKey);
            }
          });
        }
      });
    };

    void draw();
    return () => {
      cancelled = true;
    };
  }, [score, spacing, onDeleteRow]);

  return <div id={SCORE_SHEET_ID} ref={containerRef} className="score-sheet" />;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
