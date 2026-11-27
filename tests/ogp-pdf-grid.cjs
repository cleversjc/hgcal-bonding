// Requires Playwright, ReportLab and Pillow, with the development app served locally.
// node tests/ogp-pdf-grid.cjs [app URL]
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');

const url = process.argv[2] || 'http://127.0.0.1:8765/';
const read = page => page.evaluate(async () => (await import('./storage.js')).loadState());
const nav = page => page.locator('.bottom-nav [data-view="ogp"]').click();
const error = page => page.locator('#form-error');
const parse = page => page.locator('[form="ogp-import-form"]').click();

async function openImport(page, file) {
  await page.locator('[data-act="ogp-import"]').first().click();
  await page.locator('#ogp-file').setInputFiles(file);
  await page.locator('#ogp-operator').fill('PDF QA');
  assert.equal(await page.locator('#ogp-import-form select').count(), 0);
}

async function saveImport(page, file, expected, before) {
  await openImport(page, file);
  await parse(page);
  await page.locator('#ogp-confirmed').waitFor();
  assert.equal(await page.locator('.ogp-preview-item').count(), expected.length);
  if (expected.some(([label]) => label === 'C143')) {
    assert.match(await page.locator('.ogp-preview-item').filter({ hasText: 'OGP C143 → C142' }).first().innerText(), /W85\b/);
  }
  assert.deepEqual(await read(page), before);
  await page.locator('#ogp-confirmed').check();
  await page.locator('[data-act="ogp-confirm"]').click();
  await page.locator('.modal').waitFor({ state: 'hidden' });
  const saved = await read(page);
  assert.deepEqual(saved.ogpRows.slice(before.ogpRows.length).map(row => [row.reportedCell, row.mapping.target, row.wire]), expected);
  return saved;
}

async function test() {
  const fixtures = mkdtempSync(path.join(tmpdir(), 'ogp-pdf-grid-'));
  try {
    execFileSync(process.env.PYTHON || 'python', [path.join(__dirname, 'fixtures', 'make-ogp-pdf-grid.py'), fixtures]);
    const browser = await chromium.launch({
      executablePath: process.env.PLAYWRIGHT_EXECUTABLE || undefined,
      channel: process.env.PLAYWRIGHT_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined)
    });
    try {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(url);
      await nav(page);
      const empty = await read(page);
      await openImport(page, path.join(fixtures, 'letter-on-page-2.pdf'));
      await parse(page);
      await page.locator('#ogp-confirmed').waitFor();
      assert.equal(await page.locator('.ogp-preview-item').count(), 6);
      assert.match(await page.locator('.ogp-preview-item').filter({ hasText: 'W607' }).innerText(), /第 2 页/);
      assert.deepEqual(await read(page), empty);
      page.once('dialog', dialog => dialog.accept());
      await page.locator('.modal-head [data-act="close-modal"]').click();
      const oldRows = [['C3', 'C3', '10'], ['C28', 'C28', '31'], ['C13', 'C13', '553']];
      const newRows = [['M', 'M', '607'], ['N', 'N', '610'], ['C3', 'C3', '10'], ['C28', 'C28', '31']];
      const old = await saveImport(page, path.join(fixtures, 'old.pdf'), oldRows, empty);
      const revised = await saveImport(page, path.join(fixtures, 'new.pdf'), newRows, old);
      assert.deepEqual(revised.ogpRows.slice(0, oldRows.length), old.ogpRows);
      assert.ok(!await page.locator('[data-act="ogp-numbering-preview"]').count());
      const evidence = await page.evaluate(async () => {
        const storage = await import('./storage.js');
        const state = await storage.loadState();
        const image = new Image();
        image.src = state.ogpImages.find(image => image.id === state.ogpRows.at(-1).imageId).data;
        await image.decode();
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        ctx.drawImage(image, 0, 0);
        return [image.width, image.height, ...ctx.getImageData(21, 21, 1, 1).data];
      });
      assert.deepEqual(evidence, [80, 60, 255, 0, 0, 255]);

      await openImport(page, path.join(fixtures, 'bad.pdf'));
      await parse(page);
      await error(page).filter({ hasText: '图片数量不一致' }).waitFor();
      assert.deepEqual(await read(page), revised);
      await page.locator('.modal-head [data-act="close-modal"]').click();
      await page.waitForFunction(() => navigator.serviceWorker.controller?.state === 'activated');
      await context.setOffline(true);
      assert.equal((await page.reload()).fromServiceWorker(), true);
      await nav(page);
      const offline = await saveImport(page, path.join(fixtures, 'new.pdf'), newRows, revised);
      assert.deepEqual(offline.ogpImages, revised.ogpImages);
      const correctedRows = [['C142', 'C142', '85'], ['C143', 'C142', '85']];
      const automatic = await saveImport(page, path.join(fixtures, 'c142-c143.pdf'), correctedRows, offline);
      const w85Items = page.locator('.ogp-item').filter({hasText: /\bW85\b/});
      assert.equal(await w85Items.locator('.ogp-duplicate').count(), 2);
      const report = automatic.ogpImports.at(-1);
      const portable = { app: 'HGCAL OGP Import', schemaVersion: 1, source: report.source, pages: report.pages,
        detections: automatic.ogpRows.filter(row => row.importId === report.id).map(row => ({
          moduleId: row.moduleId, cell: row.reportedCell, confidence: row.confidence, page: row.sourcePage,
          index: row.sourceIndex, caption: row.caption, image: automatic.ogpImages.find(image => image.id === row.imageId)
        })) };
      const json = { name: 'c142-c143.ogp.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(portable)) };
      await saveImport(page, json, correctedRows, automatic);
      // Seed mixed historical records with identical labels and varied provenance/status.
      await page.evaluate(async () => {
        const { loadState, saveState } = await import('./storage.js');
        const { appendOgpImport, prepareOgpImport, setOgpCompletion, editOgpRow } = await import('./ogp.js');
        const state = await loadState();
        const moduleId = '320TEST00000001';
        const manifest = { app: 'HGCAL OGP Import', schemaVersion: 1,
          source: { name: 'prior-report.pdf', sha256: 'b'.repeat(64), pageCount: 1, parser: 'QA' },
          pages: [{ page: 1, moduleId, count: 7 }], detections: Array.from({ length: 7 }, (_, index) => ({
            moduleId, cell: 'C143', confidence: 0.64, page: 1, index: index + 1, caption: 'cell 143 conf 0.64', image: state.ogpImages[0]
          })) };
        const draft = prepareOgpImport(manifest, 'QA');
        const nov20 = {...draft.rows[0].mapping, numberingVersion: '2026-11-20-c143'};
        const nov25 = {...nov20, target: 'C143', wires: ['337','338','339'], numberingVersion: '2026-11-25-c143-revert'};
        const asImported = (row, mapping) => {
          const wire = mapping.wires[0];
          return {...row, mapping, wire, originalWire: wire, history: [{...row.history[0], wire,
            reason: '导入；按 OGP 编号对照 ' + mapping.numberingVersion + ' 定位 ' + mapping.target + '，取 LD V3 第一根 Wire'}]};
        };
        const historicalUpdate = (row, mapping) => ({...editOgpRow(row, {
          wire: mapping.wires[0], operator: 'QA', status: 'pending', note: '',
          reason: 'OGP 编号对照 ' + mapping.numberingVersion + '：C143 → ' + mapping.target + '，W' + row.wire + ' → W' + mapping.wires[0]
        }), numberingUpdate: mapping});
        draft.rows = draft.rows.map(row => asImported(row, nov25));
        draft.rows[1] = asImported(draft.rows[1], {...nov25, numberingVersion: '2026-11-18-ld-v3-labels'});
        draft.rows[2] = setOgpCompletion(draft.rows[2], true, 'QA');
        draft.rows[3] = editOgpRow(draft.rows[3], { wire: '100', operator: 'QA', status: 'pending', note: '', reason: '机台核对' });
        draft.rows[4] = asImported(draft.rows[4], nov20);
        draft.rows[5] = historicalUpdate(asImported(draft.rows[5], nov20), nov25);
        draft.rows[6] = historicalUpdate(historicalUpdate(asImported(draft.rows[6], {...nov25, numberingVersion: '2026-11-18'}), nov20), nov25);
        await saveState(appendOgpImport(state, draft));
      });
      await page.reload();
      await nav(page);
      const prior = await read(page);
      await page.locator('[data-act="ogp-numbering-preview"]').click();
      const confirmations = page.locator('[data-ogp-c143-id]');
      assert.equal(await confirmations.count(), 4);
      assert.equal(await confirmations.locator('xpath=..').filter({ hasText: 'prior-report.pdf' }).count(), 4);
      const confirm = page.locator('[data-act="ogp-numbering-confirm"]');
      await confirm.click();
      await error(page).filter({ hasText: '请勾选' }).waitFor();
      assert.deepEqual(await read(page), prior);
      const selected = confirmations.first();
      const selectedId = await selected.getAttribute('data-ogp-c143-id');
      const migrated = confirmations.last();
      const migratedId = await migrated.getAttribute('data-ogp-c143-id');
      await selected.check();
      await migrated.check();
      await confirm.click();
      await page.locator('.modal').waitFor({ state: 'hidden' });
      const updated = await read(page);
      assert.deepEqual(updated.ogpImages, prior.ogpImages);
      assert.deepEqual(updated.ogpRows.filter(row => row.id !== selectedId && row.id !== migratedId), prior.ogpRows.filter(row => row.id !== selectedId && row.id !== migratedId));
      const original = prior.ogpRows.find(row => row.id === selectedId);
      const corrected = updated.ogpRows.find(row => row.id === selectedId);
      assert.deepEqual([corrected.mapping, corrected.originalWire, corrected.imageId, corrected.history[0]],
        [original.mapping, '337', original.imageId, original.history[0]]);
      assert.deepEqual([corrected.numberingUpdate.target, corrected.wire], ['C142', '85']);
      const beforeMigration = prior.ogpRows.find(row => row.id === migratedId);
      const afterMigration = updated.ogpRows.find(row => row.id === migratedId);
      assert.equal(afterMigration.wire, '85');
      assert.deepEqual(afterMigration.history.slice(0, -1), beforeMigration.history);
      assert.deepEqual(afterMigration.history.map(event => event.wire), ['337', '85', '337', '85']);
      assert.deepEqual(errors, []);
      console.log('PASS: direct numeric and letter labels, C142/C143 duplicate W85 in PDF and JSON, marked image, preview and offline import at 390×844');
    } finally {
      await browser.close();
    }
  } finally {
    rmSync(fixtures, { recursive: true, force: true });
  }
}

test().catch(error => { console.error(error); process.exitCode = 1; });
