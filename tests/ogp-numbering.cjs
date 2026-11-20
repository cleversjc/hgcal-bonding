// Uses a two-page YOLO grid fixture: the 11 old labels, then their 11 replacements.
// NODE_PATH=<playwright> node tests/ogp-numbering.cjs report.pdf report.ogp.json [url]
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const expected = require('./fixtures/ogp-numbering-2026-11-18.expected.json');
const [pdfPath, jsonPath, url = 'http://127.0.0.1:8765/'] = process.argv.slice(2);
const out = process.env.BONDING_TEST_OUTPUT || '.dev-evidence/ogp-numbering';
fs.mkdirSync(out, { recursive: true });

async function test() {
  const manifest = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  const legacyManifest = { ...manifest, source: { ...manifest.source, pageCount: 1 },
    pages: manifest.pages.slice(0, 1), detections: manifest.detections.filter(d => d.page === 1) };
  assert.deepEqual(legacyManifest.detections.map(d => d.cell), Object.keys(expected));
  assert.deepEqual(manifest.detections.filter(d => d.page === 2).map(d => d.cell), Object.values(expected).map(([target]) => target));
  const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined) });
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, acceptDownloads: true });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const nav = view => page.locator('.bottom-nav [data-view="' + view + '"]').click();
    const read = () => page.evaluate(async () => (await import('./storage.js')).loadState());
    const preview = () => page.locator('[data-act="ogp-numbering-preview"]').click();
    const confirm = () => page.locator('[data-act="ogp-numbering-confirm"]').click();
    const close = () => page.locator('.modal-head [data-act="close-modal"]').click();
    const closed = () => page.locator('.modal').waitFor({ state: 'hidden' });
    await page.goto(new URL('previous-dev/', url).href);
    await page.locator('.shell').waitFor();
    await page.evaluate(async manifest => {
      const storage = await import('./storage.js');
      const ogp = await import('./ogp.js');
      const draft = ogp.prepareOgpImport(manifest, 'Numbering QA');
      draft.rows = draft.rows.map(row => {
        if (row.reportedCell === 'C66') return ogp.setOgpCompletion(row, true, 'Numbering QA');
        if (row.reportedCell === 'C13') return ogp.editOgpRow(row, { wire: '500', operator: 'Numbering QA', status: 'pending', note: '现场已修正', reason: '机台核对' });
        return row;
      });
      await storage.saveState(ogp.appendOgpImport(storage.emptyState(), draft));
    }, legacyManifest);
    await page.goto(url);
    await page.locator('.shell').waitFor();
    await nav('ogp');
    const original = await read();
    await preview();
    assert.equal(await page.locator('.ogp-numbering-list li').count(), 9);
    assert.match(await page.locator('.ogp-numbering-list').innerText(), /OGP C3 → M · W10 → W607/);
    assert.deepEqual(await read(), original);
    await close();
    assert.deepEqual(await read(), original);

    await preview();
    const other = await context.newPage();
    await other.goto(url);
    await other.locator('.shell').waitFor();
    await other.evaluate(async () => {
      const storage = await import('./storage.js');
      const ogp = await import('./ogp.js');
      const state = await storage.loadState({ images: false });
      state.ogpRows = state.ogpRows.map(row => row.reportedCell === 'C28' ? ogp.setOgpCompletion(row, true, 'Numbering QA') : row);
      await storage.saveState(state);
      const channel = new BroadcastChannel('hgcal-bonding-updates');
      channel.postMessage('updated');
    });
    await other.close();
    await page.bringToFront();
    const concurrent = await read();
    await confirm();
    await page.locator('#form-error').filter({ hasText: '重新预览' }).waitFor();
    assert.deepEqual(await read(), concurrent, 'stale preview must not update any rows');
    await close();
    await page.reload();
    await page.locator('.shell').waitFor();
    await preview();
    assert.equal(await page.locator('.ogp-numbering-list li').count(), 8);
    await page.screenshot({ path: path.join(out, 'numbering-preview.png'), animations: 'disabled' });
    await confirm();
    await closed();
    const updated = await read();
    assert.deepEqual(updated.ogpImages, original.ogpImages);
    for (const row of updated.ogpRows) {
      const before = concurrent.ogpRows.find(previous => previous.id === row.id);
      if (before.history.length > 1) { assert.deepEqual(row, before); continue; }
      assert.deepEqual([row.mapping, row.originalWire, row.imageId, row.history[0]], [before.mapping, before.originalWire, before.imageId, before.history[0]]);
      assert.deepEqual([row.numberingUpdate.target, row.wire], expected[row.reportedCell]);
      assert.match(row.history.at(-1).reason, /OGP 编号对照/);
    }
    assert.equal(await page.locator('[data-act="ogp-numbering-preview"]').count(), 0);
    await page.locator('#ogp-jump').fill('607');
    await page.locator('#ogp-jump-form button').click();
    assert.match(await page.locator('.ogp-item.is-current').innerText(), /OGP C3 → M/);

    for (const file of [pdfPath, jsonPath]) {
      await page.locator('[data-act="ogp-import"]').first().click();
      await page.locator('#ogp-file').setInputFiles(file);
      await page.locator('#ogp-operator').fill('Numbering QA'); await page.locator('#ogp-numbering-mode').selectOption('legacy');
      await page.locator('[form="ogp-import-form"]').click();
      await page.locator('#ogp-confirmed').waitFor();
      assert.equal(await page.locator('.ogp-preview-item').count(), 22);
      assert.match(await page.locator('.ogp-preview-item').filter({ hasText: 'OGP C3 → M' }).innerText(), /W607/);
      await page.locator('#ogp-confirmed').check();
      await page.locator('[data-act="ogp-confirm"]').click();
      await closed();
      const state = await read();
      const rows = state.ogpRows.slice(-22);
      for (const [index, row] of rows.entries()) {
        const detection = manifest.detections[index];
        const mapping = detection.page === 1 ? expected[detection.cell] : Object.values(expected).find(([target]) => target === detection.cell);
        assert.equal(row.reportedCell, detection.cell);
        assert.deepEqual([row.mapping.target, row.originalWire], mapping);
        assert.equal(row.wire, row.originalWire);
      }
      assert.ok(await page.locator('.ogp-item .ogp-duplicate').count() > 0);
    }
    const state = await read();
    assert.equal(state.ogpRows.length, 55);
    await page.locator('#ogp-module').selectOption('all');
    await page.locator('#ogp-status').selectOption('all');
    const csvEvent = page.waitForEvent('download');
    await page.locator('[data-act="ogp-export"]').click();
    const csvPath = path.join(out, 'numbering.csv');
    await (await csvEvent).saveAs(csvPath);
    const csv = fs.readFileSync(csvPath, 'utf8');
    assert.match(csv, /"mapped_target","ogp_numbering_version"/);
    assert.ok(csv.includes(',"M","2026-11-18"'));
    assert.equal(await page.evaluate(async () => {
      const storage = await import('./storage.js');
      const { createArchive, readArchive } = await import('./archive.js');
      const full = await storage.loadState();
      const json = storage.readBackup(JSON.stringify(storage.makeBackup(full)));
      const archive = await createArchive(await storage.loadState({ images: false }));
      const zip = await readArchive(archive);
      return JSON.stringify(full) === JSON.stringify(json) &&
        JSON.stringify(full.ogpRows) === JSON.stringify(zip.ogpRows) &&
        full.ogpImages.every(image => zip.ogpImages.find(saved => saved.id === image.id)?.data === image.data);
    }), true);

    await page.waitForFunction(() => navigator.serviceWorker.controller?.state === 'activated', null, { polling: 150 });
    const offline = await page.evaluate(() => new Promise((resolve, reject) => {
      const channel = new MessageChannel();
      const timeout = setTimeout(() => reject(new Error('Offline worker did not respond')), 8000);
      channel.port1.onmessage = event => {
        clearTimeout(timeout);
        channel.port1.close();
        resolve(event.data);
      };
      navigator.serviceWorker.controller.postMessage({ type: 'HGCAL_SHELL_STATUS' }, [channel.port2]);
    }));
    const shellVersion = fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8').match(/SHELL_VERSION = '([^']+)'/)[1];
    assert.equal(offline.version, shellVersion);
    assert.equal(offline.ready, true);
    await context.setOffline(true);
    await page.reload();
    await page.locator('.shell').waitFor();
    await nav('mapping');
    const beforeRollback = await read();
    await page.locator('[data-act="previous-version"]').click();
    await page.locator('[data-act="confirm-previous-version"]').click();
    await page.waitForURL('**/previous-dev/');
    await page.locator('.shell').waitFor();
    assert.deepEqual(await read(), beforeRollback);
    await page.evaluate(async () => {
      const storage = await import('./storage.js');
      // This validates the new letter labels and high Wire IDs with the older app.
      const state = await storage.loadState();
      storage.readBackup(JSON.stringify(storage.makeBackup(state)));
      await storage.saveState(state);
    });
    await page.locator('#return-new-version').click();
    await page.waitForURL(url);
    await page.locator('.shell').waitFor();
    assert.deepEqual(await read(), beforeRollback);
    assert.deepEqual(errors, []);
    const result = { passed: true, corrections: 11, legacyRowsUpdated: 8, protectedRows: 3, pdfAndJsonRowsEach: 22,
      previewAndCancel: true, stalePreviewAtomic: true, sourcesAndImagesPreserved: true, duplicateRows: true,
      csv: true, jsonZip: true, offlinePreviousVersionRoundTrip: true };
    fs.writeFileSync(path.join(out, 'numbering-tests.json'), JSON.stringify(result, null, 2));
    console.log('PASS:', JSON.stringify(result));
  } finally {
    await browser.close();
  }
}
test().catch(error => { console.error(error); process.exitCode = 1; });
