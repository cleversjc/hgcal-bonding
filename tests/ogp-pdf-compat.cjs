// NODE_PATH=<playwright> node tests/ogp-pdf-compat.cjs report.pdf report.ogp.json [url]
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const { chromium } = require('playwright');
const renumbered = require('./fixtures/ogp-numbering-2026-11-18.expected.json');

const [pdfPath, jsonPath, url = 'http://127.0.0.1:8765/'] = process.argv.slice(2);
const expected = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
const sha256 = crypto.createHash('sha256').update(fs.readFileSync(pdfPath)).digest('hex');
assert.equal(sha256, expected.source.sha256);
const rowCount = expected.detections.length;

const maskStreamIterator = 'Object.defineProperty(ReadableStream.prototype, Symbol.asyncIterator, { value: undefined, configurable: true });\n';
const nav = page => page.locator('.bottom-nav [data-view="ogp"]').click();
const read = page => page.evaluate(async () => {
  const storage = await import('./storage.js');
  const state = await storage.loadState({ images: false });
  return {
    reports: state.ogpImports,
    rows: state.ogpRows,
    images: state.ogpImages
  };
});

async function importPdf(page, beforeCount = 0) {
  await page.locator('[data-act="ogp-import"]').first().click();
  await page.locator('#ogp-file').setInputFiles(pdfPath);
  await page.locator('#ogp-operator').fill('Compatibility QA');
  await page.locator('[form="ogp-import-form"]').click();
  await page.waitForFunction(() => document.querySelector('#ogp-confirmed') || document.querySelector('#form-error')?.textContent.trim(), null, { timeout: 45000 });
  assert.equal(await page.locator('#form-error').innerText(), '');
  assert.equal(await page.locator('.ogp-preview-item').count(), rowCount);
  assert.equal((await read(page)).rows.length, beforeCount, 'Preview writes no records');
  await page.locator('#ogp-confirmed').check();
  await page.locator('[data-act="ogp-confirm"]').click();
  await page.locator('.modal').waitFor({ state: 'hidden' });

  const state = await read(page);
  const report = state.reports.at(-1);
  const rows = state.rows.filter(r => r.importId === report.id);
  assert.equal(state.rows.length, beforeCount + rowCount);
  assert.equal(report.source.sha256, sha256);
  assert.deepEqual(report.pages, expected.pages);
  return rows.map((row, index) => {
    const source = expected.detections[index];
    const labels = [row.moduleId, row.reportedCell, row.sourcePage, row.sourceIndex, row.confidence];
    assert.deepEqual(labels, [source.moduleId, source.cell, source.page, source.index, source.confidence]);
    assert.equal(row.wire, row.originalWire);
    assert.equal(row.wire, row.mapping.wires[0]);
    if (renumbered[source.cell]) assert.deepEqual([row.mapping.target, row.wire], renumbered[source.cell]);
    else assert.equal(row.mapping.target, source.cell);
    const image = state.images.find(picture => picture.id === row.imageId);
    assert.deepEqual([image.width, image.height, image.mime], [source.image.width, source.image.height, 'image/png']);
    assert.match(image.sha256, /^[a-f0-9]{64}$/);
    return [...labels, row.mapping.target, row.wire, image.sha256];
  });
}

async function test() {
  const browser = await chromium.launch({
    headless: true,
    channel: process.env.PLAYWRIGHT_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined)
  });
  try {
    const viewport = { width: 390, height: 844 };
    const errors = [];
    const newPage = async context => {
      const page = await context.newPage();
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(url);
      await page.locator('.shell').waitFor();
      await nav(page);
      return page;
    };
    const normal = await browser.newContext({ viewport });
    const normalPage = await newPage(normal);
    const baseline = await importPdf(normalPage);
    console.log('PASS: normal PDF import, ' + expected.pages.length + ' pages and ' + rowCount + ' detections');

    await normalPage.waitForFunction(() => navigator.serviceWorker.controller?.state === 'activated', null, { polling: 150, timeout: 45000 });
    await normal.setOffline(true);
    const offlineResponse = await normalPage.reload();
    assert.equal(offlineResponse.fromServiceWorker(), true);
    await normalPage.locator('.shell').waitFor();
    await nav(normalPage);
    assert.deepEqual(await importPdf(normalPage, rowCount), baseline);
    await normal.close();
    console.log('PASS: offline PDF import, identical rows, Wire and image hashes');

    const limited = await browser.newContext({ viewport, serviceWorkers: 'block' });
    await limited.addInitScript({ content: maskStreamIterator });
    let workerMasked = false;
    await limited.route('**/vendor/pdfjs/pdf.worker.min.mjs', async route => {
      const response = await route.fetch();
      assert.ok(response.ok());
      workerMasked = true;
      await route.fulfill({ contentType: 'text/javascript', body: maskStreamIterator + await response.text() });
    });
    const limitedPage = await newPage(limited);
    assert.deepEqual(await limitedPage.evaluate(() => [
      typeof ReadableStream.prototype[Symbol.asyncIterator], typeof ReadableStream.prototype.getReader
    ]), ['undefined', 'function']);
    assert.deepEqual(await importPdf(limitedPage), baseline);
    assert.equal(workerMasked, true);
    assert.deepEqual(errors, []);
    console.log('PASS: stream async iteration disabled in both window and worker, identical results');

    const out = process.env.BONDING_TEST_OUTPUT || '.dev-evidence/pdf-compat';
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, 'pdf-compat-tests.json'), JSON.stringify({
      passed: true, url, sourceSha256: sha256, pages: expected.pages, detections: baseline.length,
      normalImport: true, offlineImport: true, missingStreamIteratorImport: true,
      previewBeforeWrite: true, sameLabelsWireAndImageHashes: true, pageErrors: errors
    }, null, 2) + '\n');
  } finally {
    await browser.close();
  }
}

test().catch(error => { console.error(error); process.exitCode = 1; });
