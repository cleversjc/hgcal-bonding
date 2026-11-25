// node tests/clear-ogp-issues.cjs [development URL]
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const root = process.argv[2] || 'http://127.0.0.1:8765/';
const read = page => page.evaluate(async () => (await import('./storage.js')).loadState());
const act = (page, name) => page.locator(`[data-act="${name}"]`).first();
const at = page => page.locator('.bottom-nav [data-view="mapping"]').click();

async function seed(page, db) {
  return page.evaluate(async name => {
    const { emptyState, saveState, noteBackup } = await import('./storage.js');
    const { appendOgpImport, prepareOgpImport } = await import('./ogp.js');
    const { BUILTIN_MAPPING } = await import('./domain-data.js');
    const moduleId = '320TEST00000001';
    const now = new Date().toISOString();
    function image(color) {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 2;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = color; ctx.fillRect(0, 0, 2, 2);
      return {name: color + '.png', width: 2, height: 2, data: canvas.toDataURL()};
    }
    const shared = image('red'), exclusive = image('blue');
    const manifest = {app:'HGCAL OGP Import',schemaVersion:1,source:{name:'QA.pdf',sha256:'a'.repeat(64),pageCount:1,parser:'test'},
      pages:[{page:1,moduleId,count:2}],detections:[shared, exclusive].map((photo,index)=>({moduleId,cell:'M',confidence:0.6,page:1,index:index+1,caption:'cell M conf 0.6',image:photo}))};
    const state = appendOgpImport(emptyState(),prepareOgpImport(manifest,'QA',now,'legacy'));
    state.records = [{id:'qa-problem',moduleId,moduleType:'LD V3',program:'',status:'open',side:'front',target:'C19',wires:['403'],type:'漏胶',operator:'QA',phase:'检查',endpoint:'Heel',note:'QA only',expected:null,actual:null,force:null,
      pullTests:[{wire:'403',force:5,endpoint:'Heel'}],createdAt:now,updatedAt:now,photos:[image('green')],history:[{at:now,status:'open',operator:'QA',note:'QA only'}],
      mapping:{status:'documented',version:'QA',source:'QA',target:'C19',wires:['403'],expectedWires:['403'],sources:[]}}];
    state.overallRecords = [{id:'qa-overall',moduleId,side:'all',condition:'good',operator:'QA',note:'keep',createdAt:now,photos:[shared]}];
    state.importedMapping = [BUILTIN_MAPPING.find(entry=>entry.target==='C19')];
    state.mappingMeta = {source:'QA',version:'QA',importedAt:now};
    const saved = await saveState(state);
    await noteBackup(null,saved);
    localStorage.setItem('qa-cleaning-preference','keep');
    const connection = await new Promise((resolve,reject)=>{
      const request=indexedDB.open(name);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);
    });
    try {
      await new Promise((resolve,reject)=>{
        const tx=connection.transaction('checkpoints','readwrite');tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);
        tx.objectStore('checkpoints').put({state:saved,label:'QA snapshot',createdAt:now},'更新前数据');
      });
    } finally { connection.close(); }
    return { shared: saved.overallRecords[0].photos[0].id, removed: [saved.records[0].photos[0].id, ...saved.ogpImages.filter(p=>p.id!==saved.overallRecords[0].photos[0].id).map(p=>p.id)] };
  }, db);
}

async function test() {
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_EXECUTABLE || undefined,
    channel: process.env.PLAYWRIGHT_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined) });
  try {
    const context = await browser.newContext({ viewport:{width:390,height:844},acceptDownloads:true });
    const entries = [[root,'hgcal-bonding-workbench-v2'],[new URL('stable-v1/',root).href,'hgcal-bonding-stable-v2']];
    const fixtures = [];
    for (const [url, db] of entries) {
      const page = await context.newPage();
      await page.goto(url); await at(page);
      const ids = await seed(page,db);
      await page.reload(); await at(page);
      await page.waitForFunction(() => navigator.serviceWorker.controller?.state === 'activated');
      fixtures.push({url,page,ids,before:await read(page)});
    }
    for (const entry of fixtures) {
      const {page, before, ids} = entry;
      const other = fixtures.find(item=>item!==entry);
      const unaffected = await read(other.page);
      const beforeCaches = await page.evaluate(async () => (await caches.keys()).sort());
      const checkpoint = () => page.evaluate(async () => (await import('./storage.js')).checkpointBackup());
      const open = () => act(page,'clear-ogp-and-issues').click();
      const confirm = () => act(page,'confirm-clear-ogp-and-issues').click();
      const cancel = () => page.locator('.modal-head [data-act="close-modal"]').click();
      await open();
      const download = page.waitForEvent('download');
      await page.getByRole('button',{name:'先导出完整备份'}).click();
      assert.ok(await (await download).path());
      await confirm();
      await page.locator('#form-error').filter({hasText:'请输入'}).waitFor();
      await page.locator('#clear-records-confirmation').fill('删除');
      await cancel();
      assert.deepEqual(await read(page),before);
      assert.equal((await checkpoint()).records.length,1);

      await open();
      await page.locator('#clear-records-confirmation').fill('删除');
      await page.evaluate(() => {
        const original=IDBObjectStore.prototype.delete;
        IDBObjectStore.prototype.delete=function(key){
          if(this.name==='images') { IDBObjectStore.prototype.delete=original; throw new Error('QA transaction failure'); }
          return original.call(this,key);
        };
      });
      await confirm();
      await page.locator('#form-error').filter({hasText:'QA transaction failure'}).waitFor();
      assert.deepEqual(await read(page),before);
      assert.equal((await checkpoint()).ogpRows.length,2);
      await context.setOffline(true);
      await confirm();
      await page.locator('.modal').waitFor({state:'hidden'});
      const expected={...before, records:[],ogpRows:[],ogpImports:[],ogpImages:[]};
      assert.deepEqual(await read(page),expected);
      assert.deepEqual(await checkpoint(),expected);
      assert.equal(await page.evaluate(async snapshot => {
        const { noteBackup, getBackupInfo }=await import('./storage.js');
        await noteBackup(null,snapshot);
        return getBackupInfo();
      },before),null,'An export started before deletion cannot put deleted metadata back');
      assert.deepEqual(await read(other.page),unaffected);
      assert.deepEqual(await page.evaluate(async () => (await caches.keys()).sort()),beforeCaches);
      assert.equal(await page.evaluate(() => localStorage.getItem('qa-cleaning-preference')),'keep');
      assert.deepEqual(await page.evaluate(async ({shared,removed}) => {
        const {getImageBlob}=await import('./storage.js');
        return Promise.all([shared,...removed].map(id=>getImageBlob(id).then(()=>true,()=>false)));
      },ids),[true,false,false]);
      assert.equal((await page.reload()).fromServiceWorker(),true);
      await at(page);
      assert.deepEqual(await read(page),expected);
      await context.setOffline(false);
      console.log('PASS: ' + page.url() + ' backup, cancellation, failed write rollback, scoped deletion, shared file, checkpoint, and offline reopen');
    }
  } finally { await browser.close(); }
}

test().catch(error => { console.error(error); process.exitCode=1; });
