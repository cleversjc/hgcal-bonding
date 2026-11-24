// node tests/stable-promotion.cjs <stable 1.1.0 checkout>
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, readFileSync, rmSync } = require('node:fs');
const { createServer } = require('node:http');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const old = path.resolve(process.argv[2]);
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };
let stableRoot = old;
const server = createServer((request, response) => {
  try {
    const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
    if (pathname === '/probe') { response.writeHead(200, { 'Content-Type': 'text/html' }).end('<!doctype html>'); return; }
    const relative = pathname.slice('/hgcal-bonding/'.length);
    const base = relative.startsWith('stable-v1/') ? stableRoot : root;
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
    const pdf = path.join(fixtures, 'c143.pdf');
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const site = `http://127.0.0.1:${server.address().port}`;
    const url = site + '/hgcal-bonding/stable-v1/';
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
      const oldPage = await open(url);
      assert.match(await oldPage.title(), /1\.1\.0/);
      await nav(oldPage, 'ogp');
      await ready(oldPage);
      await startImport(oldPage);
      await parse(oldPage);
      await save(oldPage);
      const initial = await read(oldPage);
      assert.equal(initial.ogpRows[0].wire, '337');
      assert.equal(initial.ogpImages.length, 1);
      await oldPage.locator('#ogp-status').selectOption('all');
      const preference = await oldPage.evaluate(() => localStorage.getItem('hgcal-bonding-stable-field-session-v1'));
      assert.ok(preference);
      const observer = await context.newPage();
      await observer.goto(site + '/probe');
      async function activate(page, dir, previousVersion) {
        stableRoot = dir;
        await page.evaluate(async () => (await navigator.serviceWorker.getRegistration()).update());
        await page.waitForFunction(() => [...document.querySelectorAll('[data-mobile-status]')].some(node => node.textContent.startsWith('新版已就绪')));
        await page.close();
        const deadline = Date.now() + 15000;
        while (await observer.evaluate(async name => (await caches.keys()).some(key => key === name || key === name + '-alternate'), 'hgcal-bonding-stable-v1-shell-' + previousVersion)) {
          if (Date.now() > deadline) throw new Error('Stable worker did not activate');
          await new Promise(resolve => setTimeout(resolve, 150));
        }
        return open(url);
      }
      const page = await activate(oldPage, root, 'stable-1.1.0');
      assert.match(await page.title(), /1\.2\.0/);
      assert.deepEqual(await read(page), initial);
      assert.equal(await page.locator('#ogp-status').inputValue(), 'all');
      const devPage = await open(site + '/hgcal-bonding/');
      await nav(devPage, 'mapping');
      await ready(devPage);
      assert.equal((await read(devPage)).ogpRows.length, 0);
      for (const [mode, result] of [['legacy', ['C142', '85']], ['ld-v3', ['C143', '337']]]) {
        const before = await read(page);
        await startImport(page);
        await parse(page);
        await page.locator('#form-error').filter({ hasText: '对应不同位点' }).waitFor();
        assert.deepEqual(await read(page), before);
        await page.locator('#ogp-numbering-mode').selectOption(mode);
        await parse(page);
        await save(page);
        const row = (await read(page)).ogpRows.at(-1);
        assert.deepEqual([row.mapping.target, row.wire], result);
      }
      await action(page, 'ogp-numbering-preview').click();
      const choice = page.locator('[data-ogp-legacy-id]');
      assert.equal(await choice.count(), 1);
      await choice.check();
      await action(page, 'ogp-numbering-confirm').click();
      await page.locator('.modal').waitFor({ state: 'hidden' });
      const saved = await read(page);
      assert.deepEqual([saved.ogpRows[0].wire, saved.ogpRows[0].originalWire], ['85', '337']);
      assert.equal(saved.ogpImages[0].data, initial.ogpImages[0].data);
      // Saving an import opens the unfinished view; explicitly set the preference
      // that the cache rebuild and offline reopening should preserve.
      await page.locator('#ogp-status').selectOption('all');
      await nav(page, 'mapping');
      const keys = () => page.evaluate(async () => (await caches.keys()).sort());
      const beforeKeys = await keys();
      await action(page, 'rebuild-offline-cache').click();
      await action(page, 'confirm-rebuild-offline-cache').click();
      await page.locator('#toast').filter({ hasText: '离线缓存已重建' }).waitFor();
      assert.deepEqual(await keys(), beforeKeys.map(name => name === 'hgcal-bonding-stable-v1-shell-stable-1.2.0' ? name + '-alternate' : name).sort());
      assert.deepEqual(await read(page), saved);
      await context.setOffline(true);
      await page.close();
      const offline = await open(url);
      assert.deepEqual(await read(offline), saved);
      assert.equal(await offline.locator('#ogp-status').inputValue(), 'all');
      await context.setOffline(false);
      const rolledBack = await activate(offline, old, 'stable-1.2.0');
      assert.match(await rolledBack.title(), /1\.1\.0/);
      assert.deepEqual(await read(rolledBack), saved);
      console.log('PASS: installed stable 1.1.0 upgrade keeps records, original image, and preferences; C143 modes, confirmed migration, scoped cache rebuild, and offline reopen');
    } finally { await browser.close(); }
  } finally { rmSync(fixtures, { recursive: true, force: true }); }
}

test().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => server.close());
