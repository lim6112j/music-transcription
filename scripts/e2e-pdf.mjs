/* E2E: export PDF and validate the downloaded file */
import puppeteer from 'puppeteer-core';
import * as fs from 'fs';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = 'http://localhost:5200/';
const DL_DIR = '/tmp/e2e-dl';

async function main() {
  fs.rmSync(DL_DIR, { recursive: true, force: true });
  fs.mkdirSync(DL_DIR, { recursive: true });

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 1000 });
    const cdp = await page.createCDPSession();
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DL_DIR });

    await page.goto(URL, { waitUntil: 'networkidle2', timeout: 60000 });
    const fileInput = await page.$('input[type=file]');
    await fileInput.uploadFile('/tmp/melody-test.wav');
    await page.waitForFunction(
      () => document.querySelector('#score-sheet svg') || document.querySelector('.error-banner'),
      { polling: 1000, timeout: 180000 },
    );
    const hasScore = await page.evaluate(() => !!document.querySelector('#score-sheet svg'));
    if (!hasScore) throw new Error('score did not render');

    await page.click('.header-actions .btn.primary');
    console.log('clicked Export PDF, waiting for download…');
    // poll the download directory
    let pdfFile = null;
    for (let i = 0; i < 60; i++) {
      const files = fs.readdirSync(DL_DIR).filter((f) => f.endsWith('.pdf'));
      if (files.length > 0) {
        pdfFile = `${DL_DIR}/${files[0]}`;
        break;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    if (!pdfFile) throw new Error('PDF was not downloaded');
    const data = fs.readFileSync(pdfFile);
    if (data.subarray(0, 5).toString() !== '%PDF-') throw new Error('File is not a valid PDF');
    console.log(`PDF downloaded: ${pdfFile} (${data.length} bytes)`);
    console.log('PDF E2E PASSED');
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error('PDF E2E FAILED:', e.message);
  process.exit(1);
});
