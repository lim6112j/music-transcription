import { jsPDF } from 'jspdf';
import 'svg2pdf.js';
import { parse, type Font } from 'opentype.js';
import bravuraUrl from '@vexflow-fonts/bravura/bravura.otf?url';
import academicoUrl from '@vexflow-fonts/academico/academico.otf?url';

let fontsCache: { bravura: Font; academico: Font } | null = null;

async function loadFonts(): Promise<{ bravura: Font; academico: Font }> {
  if (fontsCache) return fontsCache;
  const [bravuraBuf, academicoBuf] = await Promise.all([
    fetch(bravuraUrl).then((r) => r.arrayBuffer()),
    fetch(academicoUrl).then((r) => r.arrayBuffer()),
  ]);
  fontsCache = { bravura: parse(bravuraBuf), academico: parse(academicoBuf) };
  return fontsCache;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

function isMusicGlyph(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0;
  return code >= 0xe000 && code <= 0xf8ff;
}

/**
 * VexFlow 5 renders glyphs as <text> elements that rely on the Bravura /
 * Academico webfonts. svg2pdf cannot embed those (OTF/CFF), so we replace
 * every <text> with equivalent <path> outlines before export.
 */
function convertTextsToPaths(svg: SVGSVGElement, fonts: { bravura: Font; academico: Font }): void {
  svg.querySelectorAll('text').forEach((t) => {
    const text = t.textContent ?? '';
    if (!text) return;
    const pt = parseFloat(t.getAttribute('font-size') ?? '10');
    const px = pt * (96 / 72);
    const x = parseFloat(t.getAttribute('x') ?? '0');
    const y = parseFloat(t.getAttribute('y') ?? '0');
    const anchor = t.getAttribute('text-anchor');
    const fill = t.getAttribute('fill') ?? 'black';

    // split into runs of music glyphs vs. regular text (different fonts)
    type Run = { chars: string; font: Font };
    const runs: Run[] = [];
    for (const ch of text) {
      const font = isMusicGlyph(ch) ? fonts.bravura : fonts.academico;
      const last = runs[runs.length - 1];
      if (last && last.font === font) last.chars += ch;
      else runs.push({ chars: ch, font });
    }

    // measure total advance for anchoring
    const totalWidth = runs.reduce((w, r) => w + r.font.getAdvanceWidth(r.chars, px), 0);
    let cursor = x;
    if (anchor === 'middle') cursor = x - totalWidth / 2;
    else if (anchor === 'end') cursor = x - totalWidth;

    const g = document.createElementNS(SVG_NS, 'g');
    for (const run of runs) {
      const pathData = run.font.getPath(run.chars, cursor, y, px).toPathData(3);
      if (pathData) {
        const path = document.createElementNS(SVG_NS, 'path');
        path.setAttribute('d', pathData);
        path.setAttribute('fill', fill);
        path.setAttribute('stroke', 'none');
        g.appendChild(path);
      }
      cursor += run.font.getAdvanceWidth(run.chars, px);
    }
    t.replaceWith(g);
  });
}

export async function exportScorePdf(container: HTMLElement, fileName: string): Promise<void> {
  const svgs = Array.from(container.querySelectorAll('svg')) as SVGSVGElement[];
  if (svgs.length === 0) throw new Error('Nothing to export');

  const fonts = await loadFonts();

  const doc = new jsPDF({ unit: 'pt', format: 'a4', orientation: 'portrait' });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margin = 36;
  const usableW = pageW - margin * 2;

  let y = margin;
  for (const src of svgs) {
    // work on a clone so the on-screen score keeps its webfont rendering
    const svg = src.cloneNode(true) as SVGSVGElement;
    convertTextsToPaths(svg, fonts);
    const w = parseFloat(svg.getAttribute('width') ?? '0');
    const h = parseFloat(svg.getAttribute('height') ?? '0');
    if (!w || !h) continue;
    const drawH = (h / w) * usableW;
    if (y + drawH > pageH - margin) {
      doc.addPage();
      y = margin;
    }
    // a row taller than the space left on the page is scaled down so it
    // never clips (also covers a first row taller than a whole page)
    const fitScale = Math.min(1, (pageH - margin - y) / drawH);
    const drawW = usableW * fitScale;
    // svg2pdf requires the element to be attached to the DOM
    svg.style.position = 'absolute';
    svg.style.left = '-10000px';
    document.body.appendChild(svg);
    try {
      await (doc as unknown as { svg: (el: SVGElement, o: object) => Promise<void> }).svg(svg, {
        x: margin + (usableW - drawW) / 2,
        y,
        width: drawW,
        height: drawH * fitScale,
      });
    } finally {
      svg.remove();
    }
    y += drawH * fitScale + 12;
  }
  doc.save(fileName);
}
