/* Dump the rendered score SVG structure for PDF debugging */
import puppeteer from 'puppeteer-core';
import * as fs from 'fs';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

async function main() {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 1000 });
    await page.goto('http://localhost:5200/', { waitUntil: 'networkidle2', timeout: 60000 });
    const fileInput = await page.$('input[type=file]');
    await fileInput.uploadFile('/tmp/melody-test.wav');
    await page.waitForFunction(() => document.querySelector('#score-sheet svg'), {
      polling: 1000,
      timeout: 180000,
    });
    await new Promise((r) => setTimeout(r, 1500));
    const info = await page.evaluate(() => {
      const svg = document.querySelector('#score-sheet svg');
      const attrs = {};
      for (const a of svg.attributes) attrs[a.name] = a.value;
      const childTags = Array.from(svg.children).map((c) => c.tagName).slice(0, 20);
      const rects = Array.from(svg.querySelectorAll('rect')).map((r) => ({
        w: r.getAttribute('width'),
        h: r.getAttribute('height'),
        fill: r.getAttribute('fill') ?? r.style.fill,
      }));
      const textLens = Array.from(svg.querySelectorAll('text')).slice(0, 5).map((t) => ({
        content: t.textContent,
        font: t.getAttribute('font-family') ?? t.style.fontFamily,
        size: t.getAttribute('font-size') ?? t.style.fontSize,
      }));
      const styles = Array.from(svg.querySelectorAll('style')).map((s) => s.textContent.slice(0, 300));
      return { attrs, childTags, rectCount: rects.length, rects: rects.slice(0, 5), textLens, styles };
    });
    console.log(JSON.stringify(info, null, 2));
    fs.writeFileSync('/tmp/score-svg.svg', await page.evaluate(() => document.querySelector('#score-sheet svg').outerHTML));
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error('FAILED:', e);
  process.exit(1);
});
