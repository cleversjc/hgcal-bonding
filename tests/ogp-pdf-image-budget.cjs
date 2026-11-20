// Requires Playwright, ReportLab and Pillow, with the development app served locally.
// node tests/ogp-pdf-image-budget.cjs [app URL]
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, rmSync, statSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');

const url = process.argv[2] || 'http://127.0.0.1:8765/';
const MiB = 1024 * 1024;
const read = page => page.evaluate(async () => (await import('./storage.js')).loadState({ images: false }));

async function test() {
  const fixtures = mkdtempSync(path.join(tmpdir(), 'ogp-pdf-budget-'));
  try {
    execFileSync(process.env.PYTHON || 'python', [path.join(__dirname, 'fixtures', 'make-ogp-pdf-grid.py'), fixtures, '--large']);
    const pdf = path.join(fixtures, 'above-old-limit.pdf');
    const oversized = path.join(fixtures, 'above-new-limit.pdf');
    const pdfBytes = statSync(pdf).size;
    assert.ok(statSync(oversized).size < 30 * MiB, 'The rejection fixture must get past the PDF file-size limit');
    const browser = await chromium.launch({
      executablePath: process.env.PLAYWRIGHT_EXECUTABLE || undefined,
      channel: process.env.PLAYWRIGHT_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined)
    });
    try {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.addInitScript(() => {
        HTMLCanvasElement.prototype.toDataURL = () => { throw new Error('PDF image encoding must use blobs'); };
      });
      await page.goto(url);
      await page.locator('.bottom-nav [data-view="ogp"]').click();
      const empty = await read(page);
      async function openImport(file) {
        await page.locator('[data-act="ogp-import"]').first().click();
        await page.locator('#ogp-file').setInputFiles(file);
        await page.locator('#ogp-operator').fill('Image budget QA');
        await page.locator('#ogp-numbering-mode').selectOption('legacy');
        await page.locator('[form="ogp-import-form"]').click();
      }
      async function preview() {
        await openImport(pdf);
        await page.locator('#ogp-confirmed').waitFor({ timeout: 90000 });
        assert.equal(await page.locator('.ogp-preview-item').count(), 30);
        assert.deepEqual(await read(page), empty);
      }
      await preview();
      await page.locator('.ogp-preview-item .ogp-thumbnail').first().click();
      const dimensions = await page.locator('#ogp-zoom-image').evaluate(async image => {
        await image.decode();
        return [image.naturalWidth, image.naturalHeight];
      });
      assert.deepEqual(dimensions, [1024, 768]);
      await page.locator('[data-act="ogp-preview-return"]').click();
      page.once('dialog', dialog => dialog.accept());
      await page.locator('.modal-head [data-act="close-modal"]').click();
      assert.deepEqual(await read(page), empty);

      await preview();
      await page.locator('#ogp-confirmed').check();
      await page.locator('[data-act="ogp-confirm"]').click();
      await page.locator('.modal').waitFor({ state: 'hidden', timeout: 90000 });
      const saved = await read(page);
      const imageBytes = saved.ogpImages.reduce((sum, image) => sum + image.byteLength, 0);
      assert.ok(imageBytes > 60 * MiB && imageBytes <= 96 * MiB, `${imageBytes} PNG bytes`);
      assert.equal(saved.ogpImages.length, 30);
      assert.deepEqual(saved.ogpRows.slice(0, 3).map(row => [row.reportedCell, row.mapping.target, row.wire]), [
        ['M', 'M', '607'], ['N', 'N', '610'], ['C3', 'M', '607']
      ]);
      await page.reload();
      assert.deepEqual(await read(page), saved);
      const verified = await page.evaluate(async () => {
        const { loadState, getImageBlob } = await import('./storage.js');
        const { ogpImages } = await loadState({ images: false });
        let count = 0;
        for (const image of ogpImages) {
          const blob = await getImageBlob(image.id);
          const bytes = await blob.arrayBuffer();
          const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), n => n.toString(16).padStart(2, '0')).join('');
          if (blob.type === 'image/png' && blob.size === image.byteLength && hash === image.sha256) count++;
        }
        return count;
      });
      assert.equal(verified, 30);
      await page.locator('.bottom-nav [data-view="ogp"]').click();
      await openImport(oversized);
      await page.locator('#form-error').filter({ hasText: 'PDF 展开后的原图总量超过 96 MiB' }).waitFor({ timeout: 90000 });
      assert.deepEqual(await read(page), saved);
      assert.deepEqual(errors, []);
      console.log(JSON.stringify({ pdfBytes, imageBytes, persistedImages: verified, oversizedPdfBytes: statSync(oversized).size, cancelAndOversizeDoNotWrite: true }));
    } finally {
      await browser.close();
    }
  } finally {
    rmSync(fixtures, { recursive: true, force: true });
  }
}

test().catch(error => { console.error(error); process.exitCode = 1; });
