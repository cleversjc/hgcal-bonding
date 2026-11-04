/* Integration test against a disposable local origin / browser context.
 * Usage: NODE_PATH=<playwright modules> node tests/ogp-browser.cjs report.pdf report.ogp.json [url]
 * Requires Playwright + a browser. PLAYWRIGHT_CHANNEL=msedge on Windows.
 * It never operates the user's normal browser profile or production records.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { chromium } = require('playwright');
const [pdfPath, portablePath, origin='http://127.0.0.1:8765/'] = process.argv.slice(2);
if(!pdfPath||!portablePath)throw new Error('Pass the fixture PDF and independently preprocessed JSON');
const expected = JSON.parse(fs.readFileSync(path.join(__dirname,'fixtures/glue_leakage_1104.expected.json'),'utf8'));
const portable = JSON.parse(fs.readFileSync(portablePath,'utf8'));
const out = path.resolve(process.env.BONDING_TEST_OUTPUT || '.dev-evidence');
fs.mkdirSync(out,{recursive:true});
const checks = [];
function pass(name,detail){checks.push({name,detail});console.log('PASS:',name,detail?JSON.stringify(detail):'');}
let browser;

(async()=>{
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(pdfPath)).digest('hex'),expected.source.sha256);
  assert.equal(portable.detections.length,121);
  for(const [i,d] of portable.detections.entries())assert.equal(crypto.createHash('sha256').update(Buffer.from(d.image.data.split(',')[1],'base64')).digest('hex'),expected.detections[i].imageSha256);
  pass('Independent preprocessor: 121 exact original image byte hashes');
  browser=await chromium.launch({headless:true,channel:process.env.PLAYWRIGHT_CHANNEL||(process.platform==='win32'?'msedge':undefined)});
  const context=await browser.newContext({viewport:{width:390,height:844},acceptDownloads:true});
  const page=await context.newPage(),pageErrors=[];
  page.on('pageerror',e=>pageErrors.push(e.message));
  page.on('dialog',d=>d.accept());
  const nav=async(view,target=page)=>target.locator('.bottom-nav [data-view="'+view+'"]').click();
  const read=async(target=page)=>target.evaluate(async()=>{const s=await(await import('./storage.js')).loadState();return {modules:s.modules,records:s.records,overall:s.overallRecords||[],rows:s.ogpRows||[],imports:s.ogpImports||[],images:(s.ogpImages||[]).map(p=>({id:p.id,width:p.width,height:p.height,bytes:p.data.length}))};});
  const closed=async(target=page)=>Promise.race([
    target.locator('.modal').waitFor({state:'hidden',timeout:60000}),
    target.waitForFunction(()=>document.querySelector('#form-error')?.textContent.trim(),null,{timeout:60000}).then(async()=>{throw new Error('Form rejected: '+await target.locator('#form-error').innerText());})
  ]);
  await page.goto(origin); await page.locator('.shell').waitFor();
  await page.locator('[data-act="module"]').click();
  await page.locator('#module-id').fill('REGRESSION-QA');await page.locator('#module-operator').fill('QA');await page.locator('#module-program').fill('LDV3-test');
  await page.locator('[form="module-form"]').click();await closed();
  await page.locator('[data-act="new-record"]').first().click();
  await page.locator('#issue-wires').fill('403,404');await page.locator('#issue-pull-tests').fill('W403, 5.2, Heel\nW404, 5.6, First bond');
  await page.locator('#issue-photos').setInputFiles({name:'field.jpeg',mimeType:'image/jpeg',buffer:Buffer.from(portable.detections[0].image.data.split(',')[1],'base64')});
  await page.waitForFunction(()=>document.querySelectorAll('#draft-photos img').length===1);
  await page.locator('[form="record-form"]').click();await closed();
  let s=await read();assert.equal(s.records.length,1);assert.deepEqual(s.records[0].pullTests.map(t=>[t.wire,t.force,t.endpoint]),[['403',5.2,'Heel'],['404',5.6,'First bond']]);
  pass('Per-wire pull tests, mapping snapshots and anomaly photo');
  await nav('records');await page.locator('[data-act="overall-record"]').click();
  await page.locator('#overall-note').fill('总体良好，保留整体照片');
  await page.locator('#overall-photos').setInputFiles({name:'overview.jpeg',mimeType:'image/jpeg',buffer:Buffer.from(portable.detections[1].image.data.split(',')[1],'base64')});
  await page.waitForFunction(()=>document.querySelectorAll('#draft-photos img').length===1);
  await page.locator('[form="overall-form"]').click();await closed();
  s=await read();assert.equal(s.overall.length,1);assert.equal(s.overall[0].photos.length,1);
  await page.locator('[data-act="record-detail"]').first().click();await page.locator('#update-status').selectOption('void');await page.locator('#update-note').fill('测试作废流程，保留原始记录');
  await page.locator('[form="update-form"]').click();await page.locator('.notice').filter({hasText:'此记录已作废'}).waitFor();await page.locator('.modal [data-act="close-modal"]').first().click();
  await nav('lookup');await page.locator('[data-act="side"][data-side="back"]').click();
  const backside=await page.evaluate(async()=>{const {BACKSIDE_ORDER}=await import('./domain-data.js');return BACKSIDE_ORDER;});assert.deepEqual(backside,['H','G','L','K','J','I']);
  await page.locator('[data-act="new-record"]').first().click();assert.equal(await page.locator('#issue-target option').count(),6);
  await page.locator('[form="record-form"]').click();await closed();
  s=await read();assert.equal(s.records.length,2);assert.equal(s.records[0].status,'void');assert.equal(s.records[0].history.length,2);assert.deepEqual(s.records[1].wires,[]);assert.equal(s.records[1].expected,5);
  pass('Overall photo, void audit and backside six-position workflow');
  const legacy=await page.evaluate(async()=>{const m=await import('./storage.js'),s=await m.loadState();delete s.ogpRows;delete s.ogpImages;delete s.ogpImports;delete s.overallRecords;for(const r of s.records){delete r.pullTests;r.force=5.2;}return m.makeBackup(s);});
  const legacyPath=path.join(out,'legacy-backup.json');fs.writeFileSync(legacyPath,JSON.stringify(legacy));
  await nav('ogp');await page.locator('[data-act="ogp-import"]').first().click();await page.locator('#ogp-file').setInputFiles(pdfPath);await page.locator('#ogp-operator').fill('OGP QA');
  await page.locator('[form="ogp-import-form"]').click();await page.locator('#ogp-confirmed').waitFor({timeout:60000});
  s=await read();assert.equal(s.rows.length,0);assert.equal(s.images.length,0);
  await page.locator('[data-act="ogp-confirm"]').click();await page.locator('#form-error').filter({hasText:'勾选确认'}).waitFor();assert.equal((await read()).rows.length,0);
  pass('PDF preview and explicit confirmation do not save early');
  await page.locator('.ogp-preview-item [data-act="ogp-image"]').first().click();await page.locator('[data-act="ogp-zoom"][data-zoom="4"]').click();assert.equal(await page.locator('#ogp-zoom-image').evaluate(e=>e.style.width),'400%');
  await page.locator('[data-act="ogp-preview-return"]').click();await page.locator('#ogp-confirmed').check();await page.locator('[data-act="ogp-confirm"]').click();await closed();
  s=await read();assert.equal(s.rows.length,121);assert.equal(s.images.length,121);assert.equal(s.records.length,2);assert.equal(s.overall.length,1);
  assert.deepEqual(s.imports[0].pages,expected.pages);assert.equal(s.imports[0].source.sha256,expected.source.sha256);
  const counts={};
  for(const [i,row]of s.rows.entries()){
    const target=expected.detections[i];counts[row.moduleId]=(counts[row.moduleId]||0)+1;
    assert.deepEqual([row.moduleId,row.reportedCell,row.confidence,row.sourcePage,row.sourceIndex],[target.moduleId,target.cell,target.confidence,target.page,target.index]);
    assert.equal(typeof row.wire,'string');assert.equal(row.wire,row.mapping.wires[0]);assert.equal(row.originalWire,row.wire);assert.equal(row.status,'pending');
  }
  assert.deepEqual(counts,expected.moduleCounts);
  pass('All six PDF pages, four module IDs, 121 labels/confidences and exactly one first Wire',counts);
  const pixelResult=await page.evaluate(async originals=>{
    const state=await(await import('./storage.js')).loadState();const report=[];
    const image=src=>new Promise((resolve,reject)=>{const i=new Image();i.onload=()=>resolve(i);i.onerror=reject;i.src=src;});
    for(let n=0;n<state.ogpRows.length;n++){
      const row=state.ogpRows[n],stored=state.ogpImages.find(p=>p.id===row.imageId),original=originals[n];
      const [a,b]=await Promise.all([image(stored.data),image(original.data)]);
      if(a.naturalWidth!==640||a.naturalHeight!==480)throw new Error('Native image dimensions lost');
      const canvas=document.createElement('canvas');canvas.width=640;canvas.height=480;const c=canvas.getContext('2d',{willReadFrequently:true});
      c.drawImage(a,0,0);const aa=c.getImageData(0,0,640,480).data;c.drawImage(b,0,0);const bb=c.getImageData(0,0,640,480).data;
      let sum=0,redA=0,redB=0;
      for(let i=0;i<aa.length;i+=4){for(let j=0;j<3;j++)sum+=(aa[i+j]-bb[i+j])**2;if(aa[i]>180&&aa[i]>aa[i+1]*1.5&&aa[i]>aa[i+2]*1.5)redA++;if(bb[i]>180&&bb[i]>bb[i+1]*1.5&&bb[i]>bb[i+2]*1.5)redB++;}
      report.push({page:row.sourcePage,index:row.sourceIndex,rmse:Math.sqrt(sum/(640*480*3)),redRatio:redA/redB});a.src=b.src='';
    }
    return {count:report.length,maxRmse:Math.max(...report.map(r=>r.rmse)),minRedRatio:Math.min(...report.map(r=>r.redRatio)),maxRedRatio:Math.max(...report.map(r=>r.redRatio)),outliers:report.filter(r=>r.redRatio<0.95||r.redRatio>1.05)};
  },portable.detections.map(r=>r.image));
  fs.writeFileSync(path.join(out,'image-validation.json'),JSON.stringify(pixelResult,null,2));console.log('Image comparison:',JSON.stringify(pixelResult));
  // PDF.js and browser JPEG decoders differ slightly in chroma interpolation.
  // Whole-image RMSE guards pairing/fidelity; thresholded red counts also
  // allow small boundary changes while requiring all annotation footprints.
  assert.ok(pixelResult.maxRmse<8,JSON.stringify(pixelResult));assert.ok(pixelResult.minRedRatio>0.95);assert.ok(pixelResult.maxRedRatio<1.12);
  pass('All 121 native crops match independent originals and preserve red annotations',pixelResult);
  await page.screenshot({path:path.join(out,'mobile-ogp.png')});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  const first=s.rows[0];await page.locator('[data-act="ogp-edit"][data-id="'+first.id+'"]').click();await page.locator('#ogp-wire').fill('25');await page.locator('[form="ogp-edit-form"]').click();await page.locator('#form-error').filter({hasText:'修正原因'}).waitFor();
  await page.locator('#ogp-reason').fill('现场 Cell 位置核对');await page.locator('#ogp-edit-operator').fill('Correction QA');await page.locator('#ogp-check-status').selectOption('normal');await page.locator('#ogp-note').fill('看图确认正常，含逗号与"引号"\n第二行备注');
  await page.locator('[form="ogp-edit-form"]').click();await closed();
  s=await read();const corrected=s.rows.find(r=>r.id===first.id);assert.equal(corrected.wire,'25');assert.equal(corrected.originalWire,'211');assert.equal(corrected.history.length,2);assert.equal(corrected.history[1].operator,'Correction QA');assert.equal(corrected.status,'normal');
  assert.ok(await page.locator('.ogp-item .ogp-duplicate').count()>=2);
  await page.reload();await page.locator('.shell').waitFor();await nav('ogp');s=await read();assert.equal(s.rows.find(r=>r.id===first.id).wire,'25');assert.equal(s.images.length,121);
  for(const group of await page.locator('.ogp-module').all()){
    const wires=await group.locator('.ogp-wire-row>b').allTextContents();const nums=wires.map(w=>Number(w.slice(1)));assert.deepEqual(nums,[...nums].sort((a,b)=>a-b));
  }
  const second=s.rows[1];await page.locator('[data-act="ogp-edit"][data-id="'+second.id+'"]').click();await page.locator('#ogp-check-status').selectOption('anomaly');await page.locator('#ogp-note').fill('现场确认异常，待处理');await page.locator('[form="ogp-edit-form"]').click();await closed();assert.equal((await read()).rows.find(r=>r.id===second.id).status,'anomaly');
  pass('Manual correction validation, original/edited audit, duplicates and IndexedDB reload');
  await page.waitForFunction(()=>[...document.querySelectorAll('[data-mobile-status]')].some(e=>e.textContent==='离线已就绪'),null,{timeout:60000});
  await context.setOffline(true);await page.reload();await page.locator('.shell').waitFor();await nav('ogp');assert.match(await page.locator('.ogp-count').innerText(),/121 条检测/);
  await page.locator('.ogp-thumbnail').first().click();await page.locator('#ogp-zoom-image').waitFor();assert.ok(await page.locator('#ogp-zoom-image').evaluate(e=>e.complete&&e.naturalWidth===640));await page.locator('.modal [data-act="ogp-edit"]').click();await page.locator('.modal [data-act="close-modal"]').first().click();
  await page.locator('[data-act="ogp-import"]').first().click();await page.locator('#ogp-file').setInputFiles(pdfPath);await page.locator('#ogp-operator').fill('Offline QA');await page.locator('[form="ogp-import-form"]').click();await page.locator('#ogp-confirmed').waitFor({timeout:60000});
  await page.locator('.ogp-duplicate').filter({hasText:'这份 PDF 已导入过'}).waitFor();await page.locator('#ogp-confirmed').check();await page.locator('[data-act="ogp-confirm"]').click();await closed();
  s=await read();assert.equal(s.rows.length,242);assert.equal(s.imports.length,2);assert.equal(s.images.length,121);
  const shellVersion=fs.readFileSync(path.join(__dirname,'../sw.js'),'utf8').match(/SHELL_VERSION = '([^']+)'/)[1];
  const offlineFiles=await page.evaluate(async version=>{const cache=await caches.open('hgcal-bonding-shell-'+version);return(await cache.keys()).map(r=>r.url);},shellVersion);
  assert.ok(offlineFiles.some(f=>f.endsWith('pdf.worker.min.mjs')));assert.ok(offlineFiles.some(f=>f.endsWith('ogp-pdf.js')));
  pass('Offline reload, image zoom, reusable PDF parsing, repeated rows and complete local worker cache',{rows:s.rows.length,images:s.images.length,cachedFiles:offlineFiles.length});
  await context.setOffline(false);
  const downloadCsv=page.waitForEvent('download');await page.locator('[data-act="ogp-export"]').click();const csvDownload=await downloadCsv;const csvPath=path.join(out,'ogp.csv');await csvDownload.saveAs(csvPath);const csv=fs.readFileSync(csvPath,'utf8');
  assert.ok(csv.startsWith('\uFEFF'));assert.match(csv,/image_id/);assert.match(csv,/yolo_confidence/);assert.ok(csv.includes(first.id));assert.ok(csv.includes(corrected.imageId));assert.ok(csv.includes('""引号""'));
  const downloadBackup=page.waitForEvent('download');await page.locator('[data-act="backup"]').click();const backupDownload=await downloadBackup;const backupPath=path.join(out,'full-backup.json');await backupDownload.saveAs(backupPath);
  const backup=JSON.parse(fs.readFileSync(backupPath,'utf8'));assert.equal(backup.data.ogpRows.length,242);assert.equal(backup.data.ogpImages.length,121);assert.equal(backup.data.records.length,2);assert.equal(backup.data.overallRecords.length,1);assert.ok(backup.data.ogpImages.every(p=>p.data.startsWith('data:image/png;base64,')));
  pass('CSV image IDs / escaped notes and full JSON containing every image byte',{backupBytes:fs.statSync(backupPath).size});
  await page.setViewportSize({width:1440,height:1000});await page.screenshot({path:path.join(out,'desktop-ogp.png')});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  const stable=await context.newPage();await stable.goto(new URL('./stable-v1/',origin).href);await stable.locator('.shell').waitFor();const stableState=await stable.evaluate(async()=>{const s=await(await import('./storage.js')).loadState();return {modules:s.modules.length,records:s.records.length};});assert.deepEqual(stableState,{modules:0,records:0});await stable.close();
  pass('Desktop/mobile fit and separate stable-v1 IndexedDB');
  const restoredContext=await browser.newContext({viewport:{width:390,height:844}}),restored=await restoredContext.newPage();restored.on('pageerror',e=>pageErrors.push(e.message));
  await restored.goto(origin);await restored.locator('.shell').waitFor();await nav('mapping',restored);await restored.locator('[data-act="restore"]').click();await restored.locator('#backup-file').setInputFiles(backupPath);await restored.locator('#restore-confirm').waitFor();await restored.waitForFunction(()=>!document.querySelector('#restore-confirm').disabled,null,{timeout:60000});
  await restored.locator('#restore-confirm').click();await closed(restored);const restoredState=await read(restored);assert.deepEqual(restoredState,s);
  await restored.locator('[data-act="restore"]').click();await restored.locator('#backup-file').setInputFiles(legacyPath);await restored.waitForFunction(()=>!document.querySelector('#restore-confirm').disabled);await restored.locator('#restore-confirm').click();await closed(restored);assert.deepEqual(await read(restored),restoredState);
  pass('Full UI backup restore on empty device and legacy merge preserve all records / images');
  const portableContext=await browser.newContext(),portablePage=await portableContext.newPage();await portablePage.goto(origin);await portablePage.locator('.shell').waitFor();await portablePage.locator('.nav-items [data-view="mapping"]').click();await portablePage.locator('[data-act="restore"]').click();await portablePage.locator('#backup-file').setInputFiles(legacyPath);await portablePage.waitForFunction(()=>!document.querySelector('#restore-confirm').disabled);await portablePage.locator('#restore-confirm').click();await closed(portablePage);const legacyRestored=await read(portablePage);assert.equal(legacyRestored.records.length,2);assert.equal(legacyRestored.records[0].force,5.2);assert.equal(legacyRestored.records[0].pullTests,undefined);assert.equal(legacyRestored.overall.length,0);
  await portablePage.locator('.nav-items [data-view="ogp"]').click();await portablePage.locator('[data-act="ogp-import"]').first().click();await portablePage.locator('#ogp-file').setInputFiles(portablePath);await portablePage.locator('#ogp-operator').fill('Preprocess QA');await portablePage.locator('[form="ogp-import-form"]').click();await portablePage.locator('#ogp-confirmed').waitFor();assert.equal((await read(portablePage)).rows.length,0);await portablePage.locator('#ogp-confirmed').check();await portablePage.locator('[data-act="ogp-confirm"]').click();await closed(portablePage);const portableState=await read(portablePage);assert.equal(portableState.rows.length,121);assert.equal(portableState.images.length,121);assert.ok(portableState.images.reduce((n,i)=>n+i.bytes,0)<10*1024*1024);assert.equal(portableState.records[0].force,5.2);
  pass('Reusable preprocessing JSON import preserves original JPEG bytes',{bytes:portableState.images.reduce((n,i)=>n+i.bytes,0)});
  assert.deepEqual(pageErrors,[]);
  fs.writeFileSync(path.join(out,'browser-tests.json'),JSON.stringify({passed:true,checks,pageErrors},null,2));
  await browser.close();browser=null;
})().catch(async error=>{console.error(error);fs.writeFileSync(path.join(out,'browser-tests.json'),JSON.stringify({passed:false,checks,error:error.stack},null,2));if(browser)await browser.close();process.exitCode=1;});
