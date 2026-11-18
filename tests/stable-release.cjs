// NODE_PATH=<playwright> node tests/stable-release.cjs <old checkout> <report.ogp.json>
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');
const JSZip = require('jszip');

const [oldCheckout, manifestPath] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const candidate = path.resolve(__dirname, '..');
const old = path.resolve(oldCheckout);
const output = path.resolve(process.env.BONDING_TEST_OUTPUT || '.dev-evidence/stable-release');
fs.mkdirSync(output, { recursive: true });

// One local origin lets a genuine installed 1.0.0 worker receive the candidate
// at exactly the same URL. Only the test chooses which tree the server serves.
let useCandidate = false;
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
const server = http.createServer((request, response) => {
  try {
    const root = useCandidate ? candidate : old;
    const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
    if (pathname === '/release-probe') {
      response.writeHead(200, { 'Content-Type': 'text/html', Connection: 'close' });
      response.end('<!doctype html><title>Release check</title>');
      return;
    }
    const target = path.resolve(root, '.' + pathname + (pathname.endsWith('/') ? 'index.html' : ''));
    if (!target.startsWith(root + path.sep)) throw new Error('Outside fixture root');
    const bytes = fs.readFileSync(target);
    response.writeHead(200, { 'Content-Type': types[path.extname(target)] || 'application/octet-stream',
      'Content-Length': bytes.length, 'Cache-Control': 'no-cache', Connection: 'close' });
    response.end(bytes);
  } catch {
    response.writeHead(404);
    response.end();
  }
});

const app = (page, source = './storage.js') => page.evaluate(async source => (await import(source)).loadState(), source);
const nav = (page, view) => page.locator('.bottom-nav [data-view="' + view + '"]').click();
const modalClosed = page => page.locator('.modal').waitFor({ state: 'hidden' });
const close = page => page.locator('.modal-head [data-act="close-modal"]').click();
const act = (page, name) => page.locator('[data-act="' + name + '"]').first();
const submit = (page, form) => page.locator('[form="' + form + '"]').first().click();
const card = (page, id) => page.locator('[data-detection-id="' + id + '"]');
const choosePhoto = (page, input, index) => page.locator(input).setInputFiles({
  name: 'inspection-fixture.jpeg', mimeType: 'image/jpeg', buffer: Buffer.from(manifest.detections[index].image.data.split(',')[1], 'base64')
});
const strippedPhoto = photo => ({ name: photo.name, data: photo.data });
const legacyRecords = state => state.records.map(record => ({ ...record, photos: record.photos.map(strippedPhoto) }));
const supportedLegacyFields = state => ({ modules: state.modules, records: legacyRecords(state),
  importedMapping: state.importedMapping, mappingMeta: state.mappingMeta, activeModuleId: state.activeModuleId });

async function waitUntil(check, description) {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error('Timed out waiting for ' + description);
}

async function newModule(page, id) {
  await page.locator('.topbar [data-act="module"]').click();
  await page.locator('#module-id').fill(id);
  await page.locator('#module-operator').fill('Release QA');
  await page.locator('#module-program').fill('LDV3');
  await submit(page, 'module-form');
  await modalClosed(page);
}

async function photoReady(page) {
  await page.locator('#draft-photos img').first().waitFor();
}

async function openRecord(page, id) {
  await nav(page, 'records');
  await page.locator('#record-scope').selectOption('all');
  await page.locator('[data-act="filter"][data-filter="all"]').click();
  await page.locator('[data-act="record-detail"][data-id="' + id + '"]').first().click();
}

async function updateRecord(page, id, status, note) {
  await openRecord(page, id);
  await page.locator('#update-status').selectOption(status);
  await page.locator('#update-note').fill(note);
  await submit(page, 'update-form');
  await page.locator('.modal').getByText(note, { exact: true }).first().waitFor();
  await close(page);
}

async function download(page, action, filename) {
  const event = page.waitForEvent('download');
  await act(page, action).click();
  const result = path.join(output, filename);
  await (await event).saveAs(result);
  return result;
}

async function restore(page, filename) {
  await nav(page, 'mapping');
  await act(page, 'restore').click();
  await page.locator('#backup-file').setInputFiles(filename);
  await page.waitForFunction(() => !document.querySelector('#restore-confirm').disabled, null, { timeout: 45000 });
  await page.locator('#restore-confirm').click();
  await modalClosed(page);
}

async function workerStatus(page) {
  await page.waitForFunction(() => navigator.serviceWorker.controller?.state === 'activated', null, { polling: 150 });
  return page.evaluate(() => new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    const timeout = setTimeout(() => reject(new Error('Worker did not report readiness')), 10000);
    channel.port1.onmessage = event => {
      clearTimeout(timeout);
      channel.port1.close();
      resolve(event.data);
    };
    navigator.serviceWorker.controller.postMessage({ type: 'HGCAL_SHELL_STATUS' }, [channel.port2]);
  }));
}

async function legacyFixture(page, moduleId) {
  await newModule(page, moduleId);
  await act(page, 'new-record').click();
  await page.locator('#issue-target').fill('C19');
  await page.locator('#issue-wires').fill('403');
  await page.locator('#issue-force').fill('5.2');
  await page.locator('#issue-note').fill('升级前稳定版异常');
  await choosePhoto(page, '#issue-photos', 0);
  await photoReady(page);
  await submit(page, 'record-form');
  await modalClosed(page);
  const data = await app(page);
  assert.equal(data.records[0].force, 5.2);
  assert.equal(data.records[0].photos.length, 1);
  return data;
}

async function test() {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + server.address().port + '/';
  const stable = url + 'stable-v1/';
  const previous = stable + 'previous-stable/';
  const browser = await chromium.launch({ headless: true,
    channel: process.env.PLAYWRIGHT_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined) });
  const pageErrors = [];
  const checks = [];
  const pass = label => { checks.push(label); console.log('PASS:', label); };
  const newContext = () => browser.newContext({ viewport: { width: 390, height: 844 }, acceptDownloads: true });
  const newPage = async (context, href) => {
    const page = await context.newPage();
    page.on('pageerror', error => pageErrors.push(error.message));
    page.on('dialog', dialog => dialog.accept());
    await page.goto(href);
    await page.locator('.shell').waitFor();
    return page;
  };

  try {
    const context = await newContext();
    const oldPage = await newPage(context, stable);
    const original = await legacyFixture(oldPage, manifest.pages[0].moduleId);
    const originalId = original.records[0].id;
    await updateRecord(oldPage, originalId, 'repaired', '升级前已返修');
    const oldState = await app(oldPage);
    const originalStatus = await workerStatus(oldPage);
    assert.equal(originalStatus.version, 'stable-1.0.0');
    useCandidate = true;
    await oldPage.evaluate(async () => (await navigator.serviceWorker.getRegistration()).update());
    await waitUntil(() => oldPage.evaluate(async () => !!(await navigator.serviceWorker.getRegistration()).waiting), 'candidate worker to be installed');
    assert.match(await oldPage.title(), /1\.0\.0/);
    assert.deepEqual(await app(oldPage), oldState);
    const observer = await context.newPage();
    await observer.goto(url + 'release-probe');
    await oldPage.close();
    // A page outside the stable scope can observe activation without holding
    // the old worker open with another stable tab.
    await waitUntil(() => observer.evaluate(async scope => {
      const registration = await navigator.serviceWorker.getRegistration(scope);
      return registration?.active?.state === 'activated' && !registration.waiting &&
        !(await caches.keys()).includes('hgcal-bonding-stable-v1-shell-stable-1.0.0');
    }, stable), 'candidate worker to activate');
    await observer.close();
    const page = await newPage(context, stable);
    assert.match(await page.title(), /1\.1\.0/);
    assert.deepEqual(supportedLegacyFields(await app(page)), supportedLegacyFields(oldState));
    assert.deepEqual(await app(page, './previous-stable/storage.js'), oldState);
    const upgradedStatus = await workerStatus(page);
    assert.equal(upgradedStatus.version, 'stable-1.1.0');
    assert.equal(upgradedStatus.ready, true);
    await nav(page, 'mapping');
    const checkpoint = await download(page, 'pre-upgrade-backup', 'upgrade-checkpoint.json');
    assert.deepEqual(supportedLegacyFields(JSON.parse(fs.readFileSync(checkpoint, 'utf8')).data), supportedLegacyFields(oldState));
    pass('Existing installed stable URL upgrades after closing old windows; record, photo, legacy pull result, repair and snapshot survive');

    const dev = await newPage(context, url);
    assert.equal((await app(dev)).modules.length, 0);
    await newModule(dev, 'DEV-ISOLATION-QA');
    assert.equal((await app(page)).modules.some(m => m.id === 'DEV-ISOLATION-QA'), false);
    await dev.close();
    pass('Stable and development records are isolated on the same origin');

    await nav(page, 'lookup');
    await page.locator('#query-input').fill('19');
    await page.locator('#query-input').press('Enter');
    await page.locator('[data-act="wire"][data-wire="403"]').waitFor();
    await page.locator('[data-act="query-mode"][data-mode="wire"]').click();
    await page.locator('#query-input').fill('W607');
    await page.locator('#query-input').press('Enter');
    await page.locator('[data-act="wire"][data-wire="607"]').waitFor();
    await act(page, 'zoom-in').click();
    await act(page, 'rotate').click();
    await act(page, 'zoom-reset').click();
    await nav(page, 'mapping');
    await act(page, 'import-mapping').click();
    await page.locator('#mapping-version').fill('QA LD V3');
    await page.locator('#mapping-text').fill('side,kind,cell,wire_start,wire_end\nfront,signal,19,403,405');
    await submit(page, 'mapping-form');
    await page.locator('#mapping-confirmed').check();
    await act(page, 'confirm-mapping').click();
    await modalClosed(page);
    assert.equal((await app(page)).importedMapping[0].target, 'C19');
    assert.match(fs.readFileSync(await download(page, 'export-mapping', 'mapping.csv'), 'utf8'), /"C19","403"/);
    pass('Cell/Wire lookups, reference controls, mapping preview, confirmed import and export');

    await nav(page, 'lookup');
    await act(page, 'new-record').click();
    await page.locator('#issue-target').fill('C19');
    await page.locator('#issue-wires').fill('403,404');
    await page.locator('#issue-pull-tests').fill('W403, 5.2, Heel\nW404, 5.6, First bond');
    await choosePhoto(page, '#issue-photos', 1);
    await photoReady(page);
    await submit(page, 'record-form');
    await modalClosed(page);
    let state = await app(page);
    const pullId = state.records.at(-1).id;
    assert.deepEqual(state.records.at(-1).pullTests.map(t => [t.wire, t.force, t.endpoint]), [
      ['403', 5.2, 'Heel'], ['404', 5.6, 'First bond']
    ]);
    await nav(page, 'records');
    await act(page, 'overall-record').click();
    await page.locator('#overall-note').fill('总体记录验收');
    await choosePhoto(page, '#overall-photos', 2);
    await photoReady(page);
    await submit(page, 'overall-form');
    await modalClosed(page);
    await updateRecord(page, pullId, 'void', '作废时保留照片和拉力');
    await nav(page, 'lookup');
    await page.locator('[data-act="side"][data-side="back"]').click();
    await act(page, 'new-record').click();
    assert.deepEqual(await page.locator('#issue-target option').evaluateAll(options => options.map(o => o.value)), ['H', 'G', 'L', 'K', 'J', 'I']);
    await submit(page, 'record-form');
    await modalClosed(page);
    state = await app(page);
    assert.equal(state.records.at(-1).side, 'back');
    assert.deepEqual(state.records.at(-1).wires, []);
    assert.equal(state.records.at(-1).expected, 5);
    assert.equal(state.records.find(r => r.id === pullId).status, 'void');
    assert.equal(state.overallRecords[0].photos.length, 1);
    await nav(page, 'records');
    await page.locator('[data-act="filter"][data-filter="void"]').click();
    const anomalyCsv = fs.readFileSync(await download(page, 'export-csv', 'anomalies.csv'), 'utf8');
    assert.match(anomalyCsv, /"pull_test_results"/);
    assert.ok(anomalyCsv.includes(pullId) && anomalyCsv.includes('Heel') && anomalyCsv.includes('First bond'));
    assert.match(fs.readFileSync(await download(page, 'export-overall-csv', 'overall.csv'), 'utf8'), /总体记录验收/);
    pass('Front/back records, six positions, per-Wire pull tests, photos, overall record, void history and CSV');

    await nav(page, 'ogp');
    await act(page, 'ogp-import').click();
    await page.locator('#ogp-file').setInputFiles(manifestPath);
    await page.locator('#ogp-operator').fill('Release QA');
    await submit(page, 'ogp-import-form');
    await page.locator('#ogp-confirmed').waitFor();
    assert.equal((await app(page)).ogpRows.length, 0);
    await page.locator('#ogp-confirmed').check();
    await act(page, 'ogp-confirm').click();
    await modalClosed(page);
    state = await app(page);
    assert.equal(state.ogpRows.length, manifest.detections.length);
    const largestPage = [...manifest.pages].sort((a, b) => b.count - a.count)[0];
    const largest = largestPage.moduleId;
    await page.locator('#ogp-module').selectOption(largest);
    await page.waitForFunction(id => document.querySelector('.field-module').textContent === id, largest);
    const group = state.ogpRows.filter(r => r.moduleId === largest).sort((a, b) => Number(a.wire) - Number(b.wire));
    const target = group.find((row, index) => index > 21 && group.filter(other => other.wire === row.wire).length === 1);
    assert.ok(target);
    await page.locator('#ogp-jump').fill(target.wire);
    await page.locator('#ogp-jump-form button').click();
    await page.locator('[data-detection-id="' + target.id + '"].is-current').waitFor();
    const next = group[group.indexOf(target) + 1];
    await act(page, 'ogp-next').click();
    await page.locator('[data-detection-id="' + next.id + '"].is-current').waitFor();
    await act(page, 'ogp-previous').click();
    await page.locator('[data-detection-id="' + target.id + '"].is-current').waitFor();
    await card(page, target.id).locator('[data-act="ogp-image"]').click();
    await page.waitForFunction(() => document.querySelector('#ogp-zoom-image')?.naturalWidth === 640);
    await page.locator('[data-act="ogp-zoom"][data-zoom="4"]').click();
    assert.equal(await page.locator('#ogp-zoom-image').evaluate(img => img.style.width), '400%');
    await close(page);
    await page.reload();
    await page.locator('.field-panel').waitFor();
    assert.equal(await page.locator('#ogp-module').inputValue(), largest);
    await page.locator('[data-detection-id="' + target.id + '"].is-current').waitFor();
    await card(page, target.id).locator('[data-act="ogp-complete"]').click();
    await card(page, target.id).waitFor({ state: 'hidden' });
    await page.locator('#toast [data-act="ogp-undo"]').click();
    await page.locator('[data-detection-id="' + target.id + '"].is-current').waitFor();
    const undone = (await app(page)).ogpRows.find(r => r.id === target.id);
    assert.equal(undone.completedAt, null);
    assert.equal(undone.history.at(-1).action, 'reopen');
    assert.equal(undone.status, target.status);
    await card(page, target.id).locator('[data-act="ogp-edit"]').click();
    const editedWire = target.wire === '629' ? '630' : '629';
    await page.locator('#ogp-wire').fill(editedWire);
    await page.locator('#ogp-note').fill('特殊处理验收，逐根检查后复检');
    await page.locator('#ogp-save-complete').click();
    await page.locator('#form-error').filter({ hasText: '修正原因' }).waitFor();
    await page.locator('#ogp-reason').fill('现场核对位点');
    await page.locator('#ogp-save-complete').click();
    await modalClosed(page);
    assert.equal(await card(page, target.id).count(), 0);
    await page.locator('#ogp-status').selectOption('special-completed');
    assert.match(await card(page, target.id).innerText(), /特殊处理验收/);
    state = await app(page);
    const treated = state.ogpRows.find(r => r.id === target.id);
    assert.equal(treated.wire, editedWire);
    assert.equal(treated.originalWire, target.originalWire);
    assert.equal(treated.imageId, target.imageId);
    assert.equal(treated.status, target.status);
    assert.ok(treated.completedAt);
    assert.match(fs.readFileSync(await download(page, 'ogp-export', 'special.csv'), 'utf8'), /"completed_by","special_handling","mapped_target"/);
    pass('Latest checklist preview, progress, Wire navigation, image zoom, reload, one-tap undo, audited correction and special completion/filter');

    const moduleZip = await download(page, 'backup-module', 'module.zip');
    await nav(page, 'mapping');
    const fullZip = await download(page, 'backup-zip', 'full.zip');
    const fullJson = await download(page, 'backup', 'full.json');
    const fullState = JSON.parse(fs.readFileSync(fullJson, 'utf8')).data;
    const cleanZip = await newContext();
    const zipPage = await newPage(cleanZip, stable);
    await restore(zipPage, moduleZip);
    const restoredModule = await app(zipPage);
    assert.equal(restoredModule.ogpRows.length, group.length);
    assert.deepEqual(restoredModule.ogpImports[0].pages.map(p => p.page), manifest.pages.filter(p => p.moduleId === largest).map(p => p.page));
    assert.equal(restoredModule.ogpImports[0].partial, true);
    await restore(zipPage, fullZip);
    const restoredZip = await app(zipPage);
    const byId = (a, b) => a.id.localeCompare(b.id);
    assert.deepEqual([...restoredZip.ogpImages].sort(byId), [...fullState.ogpImages].sort(byId));
    assert.deepEqual([...restoredZip.ogpRows].sort(byId), [...fullState.ogpRows].sort(byId));
    assert.deepEqual(restoredZip.records, fullState.records);
    assert.deepEqual(restoredZip.overallRecords, fullState.overallRecords);
    assert.deepEqual(restoredZip.ogpImports[0].pages, fullState.ogpImports[0].pages);
    assert.equal(restoredZip.ogpImports[0].partial, false);
    const cleanJson = await newContext();
    const jsonPage = await newPage(cleanJson, stable);
    await restore(jsonPage, fullJson);
    assert.deepEqual(await app(jsonPage), fullState);
    await cleanJson.close();
    // Keep a well-formed ZIP with one image changed but the original SHA in its manifest.
    const zip = await JSZip.loadAsync(fs.readFileSync(moduleZip));
    const imagePath = Object.keys(zip.files).find(name => /^media\/.+\.jpeg$/.test(name));
    const bytes = await zip.file(imagePath).async('uint8array');
    bytes[bytes.length - 1] ^= 1;
    zip.file(imagePath, bytes);
    const badZip = path.join(output, 'corrupt.zip');
    fs.writeFileSync(badZip, await zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' }));
    await act(zipPage, 'restore').click();
    await zipPage.locator('#backup-file').setInputFiles(badZip);
    await zipPage.locator('#form-error').filter({ hasText: '图片校验失败' }).waitFor();
    assert.equal(await zipPage.locator('#restore-confirm').isDisabled(), true);
    assert.deepEqual(await app(zipPage), restoredZip);
    await cleanZip.close();
    pass('Module ZIP, full ZIP, full JSON, original images, and rejection of a damaged archive');

    // This context has never visited the old fallback URL before going offline.
    await context.setOffline(true);
    await nav(page, 'mapping');
    await act(page, 'previous-version').click();
    await act(page, 'confirm-previous-version').click();
    await page.waitForURL(previous);
    await page.locator('.shell').waitFor();
    assert.equal((await workerStatus(page)).version, 'previous-stable-1.0.0');
    assert.deepEqual(await app(page), fullState);
    await updateRecord(page, originalId, 'closed', '旧版复检后返回');
    await page.locator('#return-new-version').click();
    await page.waitForURL(stable);
    await page.locator('.shell').waitFor();
    const after = await app(page);
    assert.deepEqual(after.ogpRows, fullState.ogpRows);
    assert.deepEqual(after.ogpImages, fullState.ogpImages);
    assert.deepEqual(after.overallRecords, fullState.overallRecords);
    assert.equal(after.records.find(r => r.id === originalId).status, 'closed');
    assert.equal(after.records.find(r => r.id === originalId).history.at(-1).note, '旧版复检后返回');
    await context.setOffline(false);
    await newModule(page, 'RETURNED-STABLE-QA');
    const newer = await app(page);
    // After returning, a bookmark opens the old snapshot without arming a handoff.
    await page.goto(previous);
    await page.locator('.shell').waitFor();
    await openRecord(page, originalId);
    await page.locator('#update-status').selectOption('repaired');
    await page.locator('#update-note').fill('这条旧记录不应直接覆写新版');
    await submit(page, 'update-form');
    await page.locator('#form-error').filter({ hasText: '这里是旧稳定版记录' }).waitFor();
    await close(page);
    await page.locator('#return-new-version').click();
    await page.waitForURL(stable);
    await page.locator('.shell').waitFor();
    assert.deepEqual(await app(page), newer);
    pass('First visit to old URL works offline; return keeps edits and all evidence, and stale entry cannot overwrite data');

    useCandidate = false;
    const fault = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
    const faultPage = await newPage(fault, stable);
    const faultLegacy = await legacyFixture(faultPage, 'MIGRATION-FAILURE-QA');
    await fault.addInitScript(() => {
      const put = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (...args) {
        if (this.transaction.db.name === 'hgcal-bonding-stable-v2' && this.name === 'images') {
          throw new DOMException('simulated storage limit', 'QuotaExceededError');
        }
        return put.apply(this, args);
      };
    });
    useCandidate = true;
    await faultPage.close();
    const failing = await fault.newPage();
    await failing.goto(stable);
    await failing.locator('.boot a[href="./previous-stable/"]').waitFor();
    await failing.locator('.boot a').click();
    await failing.locator('.shell').waitFor();
    assert.deepEqual(await app(failing), faultLegacy);
    await updateRecord(failing, faultLegacy.records[0].id, 'repaired', '仍可使用旧版');
    await fault.close();
    pass('Simulated storage limit leaves the old database and old entry usable');

    assert.deepEqual(pageErrors, []);
    fs.writeFileSync(path.join(output, 'stable-release-tests.json'), JSON.stringify({
      passed: true, checks, originalStableVersion: originalStatus.version, candidateVersion: upgradedStatus.version,
      detections: manifest.detections.length,
      moduleRows: group.length, fullZipBytes: fs.statSync(fullZip).size, fullJsonBytes: fs.statSync(fullJson).size,
      pageErrors
    }, null, 2) + '\n');
  } finally {
    await browser.close();
  }
}

test().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => server.close());
