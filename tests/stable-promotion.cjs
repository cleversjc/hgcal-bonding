// node tests/stable-promotion.cjs <previous release checkout> [dev]
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, readFileSync, rmSync } = require('node:fs');
const { createServer } = require('node:http');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const old = path.resolve(process.argv[2]);
const isDev = process.argv[3] === 'dev';
const entry = isDev ? '' : 'stable-v1/';
const priorVersion = isDev ? '2026-11-27-ogp-ld-v3-only-v1' : 'stable-1.2.1';
const currentVersion = isDev ? '2026-11-27-ld-v3-cell-wires-v1' : 'stable-1.3.0';
const priorLabel = isDev ? /按 LD V3 直接解析/ : /1\.2\.1/;
const cachePrefix = isDev ? 'hgcal-bonding-shell-' : 'hgcal-bonding-stable-v1-shell-';
const fieldKey = isDev ? 'hgcal-bonding-field-session-v1' : 'hgcal-bonding-stable-field-session-v1';
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };
let stableRoot = old;
const server = createServer((request, response) => {
  try {
    const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
    if (pathname === '/probe') { response.writeHead(200, { 'Content-Type': 'text/html' }).end('<!doctype html>'); return; }
    const relative = pathname.slice('/hgcal-bonding/'.length);
    const base = relative.startsWith('stable-v1/') !== isDev ? stableRoot : root;
    const file = path.resolve(base, relative + (pathname.endsWith('/') ? 'index.html' : ''));
    if (!pathname.startsWith('/hgcal-bonding/') || !file.startsWith(base + path.sep)) throw new Error('Invalid fixture URL');
    const bytes = readFileSync(file);
    response.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream',
      'Content-Length': bytes.length, 'Cache-Control': 'no-cache', Connection: 'close' }).end(bytes);
  } catch { response.writeHead(404).end(); }
});

async function test() {
  const fixtures = mkdtempSync(path.join(tmpdir(), 'stable-promotion-'));
  try {
    execFileSync(process.env.PYTHON || 'python', [path.join(__dirname, 'fixtures', 'make-ogp-pdf-grid.py'), fixtures]);
    const pdf = path.join(fixtures, 'c142-c143.pdf');
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const site = `http://127.0.0.1:${server.address().port}`;
    const url = site + '/hgcal-bonding/' + entry;
    const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_EXECUTABLE || undefined,
      channel: process.env.PLAYWRIGHT_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined) });
    try {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
      const action = (page, action) => page.locator(`[data-act="${action}"]`).first();
      const nav = (page, view) => page.locator(`.bottom-nav [data-view="${view}"]`).click();
      const read = page => page.evaluate(async () => (await import('./storage.js')).loadState());
      const ready = page => page.waitForFunction(() => navigator.serviceWorker.controller?.state === 'activated');
      async function open(href) {
        const page = await context.newPage();
        await page.goto(href);
        await page.locator('.shell').waitFor();
        return page;
      }
      async function startImport(page) {
        await action(page, 'ogp-import').click();
        await page.locator('#ogp-file').setInputFiles(pdf);
        await page.locator('#ogp-operator').fill('Stable promotion QA');
      }
      const parse = page => page.locator('[form="ogp-import-form"]').click();
      async function save(page) {
        await page.locator('#ogp-confirmed').check();
        await action(page, 'ogp-confirm').click();
        await page.locator('.modal').waitFor({ state: 'hidden' });
      }
      async function recordGroup(page, target, wires, otherWire) {
        await nav(page, 'lookup');
        const search = async input => {
          await page.locator('#query-input').fill(input);
          await page.locator('#query-input').press('Enter');
        };
        await page.locator('[data-act="query-mode"][data-mode="cell"]').click();
        await search(target);
        assert.deepEqual(await page.locator('.wire-chips button').allTextContents(), wires.map(wire => 'W' + wire));
        await page.locator('[data-act="query-mode"][data-mode="wire"]').click();
        for (const wire of wires) {
          await search(wire);
          assert.equal(await page.locator('.selection-heading').textContent(), 'CELL' + target.slice(1));
          assert.equal(await page.locator('.wire-chip.active').textContent(), 'W' + wire);
        }
        await page.locator('.selected-card [data-act="new-record"]').click();
        assert.equal(await page.locator('#issue-target').inputValue(), target);
        await page.locator('#issue-wires').fill(wires.join(','));
        await page.locator('#issue-pull-tests').fill(otherWire + ', 5.1');
        await page.locator('#save-record').click();
        await page.locator('#form-error').filter({hasText: '不一致'}).waitFor();
        await page.locator('#issue-pull-tests').fill(wires.map(wire => wire + ', 5.2, Heel').join('\n'));
        await page.locator('#save-record').click();
        await page.locator('.modal').waitFor({state: 'hidden'});
        const record = (await read(page)).records.at(-1);
        assert.deepEqual([record.target, record.wires, record.mapping.expectedWires], [target, wires, wires]);
        assert.deepEqual(record.pullTests.map(test => [test.wire, test.force]), wires.map(wire => [wire, 5.2]));
      }
      const oldPage = await open(url);
      await nav(oldPage, 'mapping');
      assert.match(await oldPage.locator('.release-label').innerText(), priorLabel);
      await nav(oldPage, 'ogp');
      await ready(oldPage);
      for (const mode of (isDev ? [null] : ['legacy', 'ld-v3'])) {
        await startImport(oldPage);
        if (mode) await oldPage.locator('#ogp-numbering-mode').selectOption(mode);
        await parse(oldPage);
        await save(oldPage);
      }
      const imported = (await read(oldPage)).ogpRows;
      assert.deepEqual(imported.map(row => [row.reportedCell, row.mapping.target, row.wire]), isDev
        ? [['C142','C142','85'], ['C143','C142','85']]
        : [['C142','C143','337'], ['C143','C143','337'], ['C142','C142','85'], ['C143','C143','337']]);
      if (!isDev) {
        await oldPage.locator('[data-act="ogp-edit"][data-id="' + imported.at(-1).id + '"]').click();
        await oldPage.locator('#ogp-wire').fill('86');
        await oldPage.locator('#ogp-reason').fill('机台人工定位');
        await oldPage.locator('[form="ogp-edit-form"][value="save"]').click();
        await oldPage.locator('.modal').waitFor({state: 'hidden'});
      }
      await recordGroup(oldPage, 'C142', ['85', '86', '87'], '337');
      await nav(oldPage, 'ogp');
      const initial = await read(oldPage);
      assert.equal(initial.ogpImages.length, 2);
      await oldPage.locator('#ogp-status').selectOption('all');
      const preference = await oldPage.evaluate(key => localStorage.getItem(key), fieldKey);
      assert.ok(preference);
      const observer = await context.newPage();
      await observer.goto(site + '/probe');
      async function activate(page, dir, previousVersion) {
        stableRoot = dir;
        await page.evaluate(async () => (await navigator.serviceWorker.getRegistration()).update());
        await page.waitForFunction(() => [...document.querySelectorAll('[data-mobile-status]')].some(node => node.textContent.startsWith('新版已就绪')));
        await page.close();
        const deadline = Date.now() + 15000;
        while (await observer.evaluate(async name => (await caches.keys()).some(key => key === name || key === name + '-alternate'), cachePrefix + previousVersion)) {
          if (Date.now() > deadline) throw new Error('Stable worker did not activate');
          await new Promise(resolve => setTimeout(resolve, 150));
        }
        return open(url);
      }
      const page = await activate(oldPage, root, priorVersion);
      await nav(page, 'mapping');
      assert.match(await page.locator('.release-label').innerText(), isDev ? /C142、C143 线号修订/ : /稳定版 1\.3\.0/);
      await nav(page, 'ogp');
      assert.deepEqual(await read(page), initial);
      assert.equal(await page.locator('#ogp-status').inputValue(), 'all');
      const devPage = await open(site + '/hgcal-bonding/' + (isDev ? 'stable-v1/' : ''));
      await nav(devPage, 'mapping');
      await ready(devPage);
      assert.equal((await read(devPage)).ogpRows.length, 0);
      await startImport(page);
      assert.equal(await page.locator('#ogp-import-form select').count(), 0);
      await parse(page);
      await page.locator('#ogp-confirmed').waitFor();
      assert.deepEqual(await read(page), initial);
      await save(page);
      const afterImport = (await read(page)).ogpRows;
      assert.deepEqual(afterImport.slice(0, initial.ogpRows.length), initial.ogpRows);
      assert.deepEqual(afterImport.slice(initial.ogpRows.length).map(row => [row.reportedCell, row.mapping.target, row.wire]),
        [['C142', 'C142', '337'], ['C143', 'C143', '85']]);

      await action(page, 'ogp-numbering-preview').click();
      const list = page.locator('.ogp-numbering-list');
      const eligible = initial.ogpRows.filter(row => row.history.length === 1);
      assert.equal(eligible.length, isDev ? 2 : 3);
      assert.equal(await list.getByRole('checkbox').count(), eligible.length);
      assert.equal(await list.locator(':checked').count(), 0);
      const firstWire = { C142: '337', C143: '85' };
      for (const row of eligible) {
        const change = row.mapping.target + ' · W' + row.wire + ' → ' + row.reportedCell + ' · W' + firstWire[row.reportedCell];
        await list.locator('li').filter({hasText: change}).locator('[data-ogp-location-id="' + row.id + '"]').check();
      }
      await action(page, 'ogp-numbering-confirm').click();
      await page.locator('.modal').waitFor({state: 'hidden'});
      const updated = (await read(page)).ogpRows;
      for (const before of initial.ogpRows) {
        const row = updated.find(row => row.id === before.id);
        if (before.history.length > 1) { assert.deepEqual(row, before); continue; }
        assert.deepEqual([row.numberingUpdate.target, row.wire], [before.reportedCell, firstWire[before.reportedCell]]);
        assert.deepEqual([row.mapping, row.originalWire, row.history.slice(0,-1)], [before.mapping, before.originalWire, before.history]);
      }
      await recordGroup(page, 'C143', ['85', '86', '87'], '337');
      await recordGroup(page, 'C142', ['337', '338', '339'], '85');
      assert.deepEqual((await read(page)).records[0], initial.records[0]);
      await nav(page, 'ogp');
      const saved = await read(page);
      assert.deepEqual(saved.ogpImages, initial.ogpImages);
      // Saving an import opens the unfinished view; explicitly set the preference
      // that the cache rebuild and offline reopening should preserve.
      await page.locator('#ogp-status').selectOption('all');
      await nav(page, 'mapping');
      const keys = () => page.evaluate(async () => (await caches.keys()).sort());
      const beforeKeys = await keys();
      await action(page, 'rebuild-offline-cache').click();
      await action(page, 'confirm-rebuild-offline-cache').click();
      await page.locator('#toast').filter({ hasText: '离线缓存已重建' }).waitFor();
      assert.deepEqual(await keys(), beforeKeys.map(name => name === cachePrefix + currentVersion ? name + '-alternate' : name).sort());
      assert.deepEqual(await read(page), saved);
      await context.setOffline(true);
      await page.close();
      const offline = await open(url);
      assert.deepEqual(await read(offline), saved);
      assert.equal(await offline.locator('#ogp-status').inputValue(), 'all');
      await context.setOffline(false);
      const rolledBack = await activate(offline, old, currentVersion);
      await nav(rolledBack, 'mapping');
      assert.match(await rolledBack.locator('.release-label').innerText(), priorLabel);
      assert.deepEqual(await read(rolledBack), saved);
      console.log('PASS: ' + (isDev ? 'development' : 'stable') + ' installed upgrade, release-specific import, saved records, original images, scoped cache rebuild, offline reopen and rollback');
    } finally { await browser.close(); }
  } finally { rmSync(fixtures, { recursive: true, force: true }); }
}

test().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => server.close());
