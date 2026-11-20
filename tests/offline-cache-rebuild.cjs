// Requires Playwright. Starts its own loopback server to simulate failed and mixed downloads.
const assert = require('node:assert/strict');
const { readFile, stat } = require('node:fs/promises');
const { createServer } = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const scope = '/hgcal-bonding/';
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };
let network = 'normal';
const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1');
  const relative = url.pathname.slice(scope.length);
  let file = path.resolve(root, relative);
  if (!url.pathname.startsWith(scope) || !file.startsWith(root + path.sep) && file !== root) {
    response.writeHead(404).end();
    return;
  }
  try {
    if (network === 'failure' && relative === 'styles.css') {
      response.writeHead(503).end();
      return;
    }
    if ((await stat(file)).isDirectory()) file = path.join(file, 'index.html');
    let data = await readFile(file);
    if (network === 'mixed' && relative === 'app.js') data = Buffer.concat([data, Buffer.from('\n// Different release')]);
    response.writeHead(200, { 'content-type': mime[path.extname(file)] || 'application/octet-stream' }).end(data);
  } catch { response.writeHead(404).end(); }
});

async function test() {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}${scope}`;
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_EXECUTABLE || undefined,
    channel: process.env.PLAYWRIGHT_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined) });
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    await page.goto(url);
    const ready = () => page.waitForFunction(() => [...document.querySelectorAll('[data-mobile-status]')].some(node => node.textContent === '离线已就绪'));
    const settings = () => page.locator('.bottom-nav [data-view="mapping"]').click();
    const cacheKeys = () => page.evaluate(async () => (await caches.keys()).sort());
    const records = () => page.evaluate(async () => {
      const { loadState } = await import('./storage.js');
      return { state: await loadState(), setting: localStorage.getItem('rebuild-test-setting') };
    });
    await settings();
    await ready();
    await page.evaluate(async () => {
      const { emptyState, saveState } = await import('./storage.js');
      const { prepareOgpImport, appendOgpImport } = await import('./ogp.js');
      const moduleId = '320TEST00000001';
      const image = { name: 'mark.png', width: 1, height: 1, data: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1ioAAAAASUVORK5CYII=' };
      const report = { app: 'HGCAL OGP Import', schemaVersion: 1, source: { name: 'qa.pdf', sha256: 'a'.repeat(64), pageCount: 1, parser: 'test' },
        pages: [{ page: 1, moduleId, count: 1 }], detections: [{ page: 1, index: 1, moduleId, cell: 'M', confidence: 0.5, caption: 'cell M conf 0.5', image }] };
      await saveState(appendOgpImport(emptyState(), prepareOgpImport(report, 'QA')));
      localStorage.setItem('rebuild-test-setting', 'keep');
      const unrelated = await caches.open('unrelated-cache-test');
      await unrelated.put(new URL('unrelated', location.href), new Response('keep too'));
    });
    const initialRecords = await records();
    for (const release of ['stable-v1', 'previous-dev']) {
      const other = await context.newPage();
      const releaseUrl = new URL(release + '/', url);
      await other.goto(releaseUrl.href);
      await other.waitForFunction(path => navigator.serviceWorker.controller?.scriptURL.endsWith(path), releaseUrl.pathname + 'sw.js');
      await other.close();
    }
    const oldKeys = await cacheKeys();
    assert.ok(oldKeys.some(name => name.startsWith('hgcal-bonding-stable-v1-shell-')));
    assert.ok(oldKeys.some(name => name.startsWith('hgcal-bonding-previous-dev-shell-')));
    const otherWindow = await context.newPage();
    await otherWindow.goto(url);
    await otherWindow.evaluate(() => { window.rebuildTestToken = 'no-reload'; });

    const open = () => page.locator('[data-act="rebuild-offline-cache"]').click();
    const confirm = () => page.locator('[data-act="confirm-rebuild-offline-cache"]').click();
    const cancel = () => page.locator('.modal-head [data-act="close-modal"]').click();
    const error = text => page.locator('#form-error').filter({ hasText: text }).waitFor();
    await open();
    await cancel();
    assert.deepEqual(await cacheKeys(), oldKeys);
    await context.setOffline(true);
    await open();
    await confirm();
    await error('请先联网');
    await cancel();
    assert.deepEqual(await cacheKeys(), oldKeys);
    await context.setOffline(false);
    for (const mode of ['failure', 'mixed']) {
      network = mode;
      await open();
      await confirm();
      await error('下载或版本校验未完成');
      await cancel();
      assert.deepEqual(await cacheKeys(), oldKeys);
      assert.deepEqual(await records(), initialRecords);
    }
    network = 'normal';
    await open();
    await confirm();
    await page.locator('.modal').waitFor({ state: 'hidden' });
    await page.locator('#toast').filter({ hasText: '离线缓存已重建' }).waitFor();
    const rebuilt = await cacheKeys();
    const oldDev = oldKeys.find(name => name.startsWith('hgcal-bonding-shell-'));
    assert.deepEqual(rebuilt, oldKeys.map(name => name === oldDev ? name + '-alternate' : name).sort());
    assert.equal(await otherWindow.evaluate(() => window.rebuildTestToken), 'no-reload');
    assert.deepEqual(await records(), initialRecords);
    await context.setOffline(true);
    assert.equal((await page.reload()).fromServiceWorker(), true);
    await settings();
    await ready();
    assert.deepEqual(await records(), initialRecords);
    assert.deepEqual(await cacheKeys(), rebuilt);
    console.log('PASS: confirmed rebuild, cancellation, offline/download/mixed-release failures, other version caches, saved records and images, settings, and offline reopen');
  } finally {
    await browser.close();
  }
}

test().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => server.close());
