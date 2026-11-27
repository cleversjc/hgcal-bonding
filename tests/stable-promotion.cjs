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
const priorVersion = isDev ? '2026-11-25-ogp-c143-revert-v1' : 'stable-1.2.0';
const currentVersion = isDev ? '2026-11-27-ogp-c143-w85-v1' : 'stable-1.2.1';
const priorLabel = isDev ? /C143 对照回退/ : /1\.2\.0/;
const priorWire = isDev ? '337' : '85';
const expectedC143 = isDev ? ['C142', '85'] : ['C143', '337'];
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
    const pdf = path.join(fixtures, 'c143.pdf');
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
      const oldPage = await open(url);
      await nav(oldPage, 'mapping');
      assert.match(await oldPage.locator('.release-label').innerText(), priorLabel);
      await nav(oldPage, 'ogp');
      await ready(oldPage);
      await startImport(oldPage);
      await oldPage.locator('#ogp-numbering-mode').selectOption('legacy');
      await parse(oldPage);
      await save(oldPage);
      const initial = await read(oldPage);
      assert.equal(initial.ogpRows[0].wire, priorWire);
      assert.equal(initial.ogpImages.length, 1);
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
      assert.match(await page.locator('.release-label').innerText(), isDev ? /C143 定位 W85/ : /1\.2\.1/);
      await nav(page, 'ogp');
      assert.deepEqual(await read(page), initial);
      assert.equal(await page.locator('#ogp-status').inputValue(), 'all');
      const devPage = await open(site + '/hgcal-bonding/' + (isDev ? 'stable-v1/' : ''));
      await nav(devPage, 'mapping');
      await ready(devPage);
      assert.equal((await read(devPage)).ogpRows.length, 0);
      for (const mode of ['legacy', 'ld-v3']) {
        const before = await read(page);
        await startImport(page);
        await page.locator('#ogp-numbering-mode').selectOption(mode);
        await parse(page);
        await page.locator('#ogp-confirmed').waitFor();
        assert.deepEqual(await read(page), before);
        await save(page);
        const row = (await read(page)).ogpRows.at(-1);
        assert.deepEqual([row.mapping.target, row.wire], expectedC143);
      }
      await action(page, 'ogp-numbering-preview').click();
      const choice = page.locator(isDev ? '[data-ogp-c143-id]' : '[data-ogp-c143-rollback-id]');
      assert.equal(await choice.count(), 1);
      await choice.check();
      await action(page, 'ogp-numbering-confirm').click();
      await page.locator('.modal').waitFor({ state: 'hidden' });
      const saved = await read(page);
      assert.deepEqual([saved.ogpRows[0].wire, saved.ogpRows[0].originalWire], [expectedC143[1], priorWire]);
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
      console.log('PASS: ' + (isDev ? 'development' : 'stable') + ' installed upgrade keeps records, original image, and preferences; C143 modes, confirmed migration, scoped cache rebuild, and offline reopen');
    } finally { await browser.close(); }
  } finally { rmSync(fixtures, { recursive: true, force: true }); }
}

test().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => server.close());
