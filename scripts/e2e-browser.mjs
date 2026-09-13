/* Headless browser end-to-end test: upload WAV -> wait for score -> assert staves rendered */
import puppeteer from 'puppeteer-core';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = 'http://localhost:5200/';

async function main() {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 1000 });
    page.on('console', (msg) => {
      if (['error', 'warning'].includes(msg.type())) console.log('[console]', msg.type(), msg.text());
    });
    page.on('pageerror', (err) => console.log('[pageerror]', err.message));

    await page.goto(URL, { waitUntil: 'networkidle2', timeout: 60000 });
    console.log('page loaded');

    const fileInput = await page.$('input[type=file]');
    if (!fileInput) throw new Error('file input not found');
    await fileInput.uploadFile('/tmp/melody-test.wav');
    console.log('file uploaded, waiting for transcription…');

    // wait until either score renders or error banner appears
    const result = await page.waitForFunction(
      () => {
        const score = document.querySelector('#score-sheet svg');
        const error = document.querySelector('.error-banner');
        if (score) return 'score';
        if (error) return 'error:' + error.textContent;
        return null;
      },
      { polling: 1000, timeout: 180000 },
    );
    const status = await result.jsonValue();
    console.log('result:', status);
    if (status !== 'score') throw new Error('Transcription failed: ' + status);

    // let VexFlow finish drawing all rows
    await new Promise((r) => setTimeout(r, 1500));

    const info = await page.evaluate(() => {
      const rows = document.querySelectorAll('#score-sheet .score-row');
      let noteGlyphs = 0;
      document.querySelectorAll('#score-sheet svg path, #score-sheet svg use').forEach(() => noteGlyphs++);
      const banner = document.querySelector('.error-banner')?.textContent ?? null;
      return { rows: rows.length, glyphCount: noteGlyphs, banner };
    });
    console.log('score info:', JSON.stringify(info));
    if (info.rows < 1) throw new Error('No score rows rendered');
    if (info.banner) throw new Error('Error banner shown: ' + info.banner);

    await page.screenshot({ path: '/tmp/score-e2e.png', fullPage: true });
    console.log('screenshot saved to /tmp/score-e2e.png');
    console.log('E2E PASSED');
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error('E2E FAILED:', e.message);
  process.exit(1);
});
