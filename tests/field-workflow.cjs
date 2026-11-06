const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {chromium}=require('playwright');
const [portablePath,url='http://127.0.0.1:8765/']=process.argv.slice(2);
const out=path.resolve(process.env.BONDING_TEST_OUTPUT||'.dev-evidence/field-workflow');fs.mkdirSync(out,{recursive:true});
let browser;
(async()=>{
  const manifest=JSON.parse(fs.readFileSync(portablePath,'utf8'));
  browser=await chromium.launch({headless:true,channel:process.env.PLAYWRIGHT_CHANNEL||(process.platform==='win32'?'msedge':undefined)});
  const context=await browser.newContext({viewport:{width:390,height:844},acceptDownloads:true}),page=await context.newPage(),errors=[];
  page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.dismiss());
  const nav=async(view,p=page)=>p.locator('.bottom-nav [data-view="'+view+'"]').click();
  const read=async(p=page)=>p.evaluate(async()=>await(await import(new URL('storage.js',document.querySelector('script[src$="app.js"]').src))).loadState());
  await page.goto(new URL('previous-dev/',url).href);await page.locator('.shell').waitFor();
  // Seed the actual previous-version database, including ordinary field photos.
  const seeded=await page.evaluate(async manifest=>{
    const storage=await import('./storage.js'),ogp=await import('./ogp.js');let state=ogp.appendOgpImport(storage.emptyState(),ogp.prepareOgpImport(manifest,'Legacy QA'));
    const row=state.ogpRows[0],now=new Date().toISOString(),photo={name:'legacy-field.jpeg',data:manifest.detections[0].image.data};
    state.records.push({id:'legacy-anomaly',moduleId:row.moduleId,moduleType:'LD V3 Full',program:'',side:'front',target:row.reportedCell,wires:[row.wire],type:'线数不足',expected:3,actual:2,phase:'绑定中',force:null,endpoint:'未指定',pullTests:[{wire:row.wire,force:5.2,endpoint:'Heel'}],operator:'Legacy QA',note:'legacy photo must survive',photos:[photo],status:'open',createdAt:now,updatedAt:now,mapping:{status:'documented',version:row.mapping.version,source:row.mapping.source,target:row.reportedCell,wires:[row.wire],expectedWires:row.mapping.wires,sources:[]},history:[{at:now,operator:'Legacy QA',status:'open',note:'创建异常记录'}]});
    state.overallRecords.push({id:'legacy-overall',moduleId:row.moduleId,side:'all',condition:'good',operator:'Legacy QA',note:'overall photo must survive',photos:[{...photo,name:'legacy-overall.jpeg'}],createdAt:now});
    await storage.saveState(state);return {ids:state.ogpRows.map(r=>r.id),firstImage:row.imageId,photo:photo.data};
  },manifest);
  await page.goto(url);await page.locator('.shell').waitFor();await nav('ogp');
  let state=await read();assert.equal(state.ogpRows.length,121);assert.equal(state.records[0].photos[0].data,seeded.photo);assert.equal(state.overallRecords[0].photos[0].data,seeded.photo);
  assert.equal(await page.locator('#ogp-module').inputValue(),'320MLF3WDIH0630');assert.match(await page.locator('.field-module').innerText(),/320MLF3WDIH0630/);
  const storageSize=await page.evaluate(async()=>{const s=await(await import('./storage.js')).loadState({images:false});return {bytes:new TextEncoder().encode(JSON.stringify(s)).byteLength,noImageData:s.ogpImages.every(p=>!p.data),noPhotoData:s.records.every(r=>r.photos.every(p=>!p.data))};});
  assert.ok(storageSize.bytes<250000);assert.equal(storageSize.noImageData,true);assert.equal(storageSize.noPhotoData,true);
  // Jump to a late item, verify next focus, then immediate undo without a form.
  const firstModule=state.ogpRows.filter(r=>r.moduleId==='320MLF3WDIH0630').sort((a,b)=>Number(a.wire)-Number(b.wire)),target=firstModule[3],next=firstModule[4];
  await page.locator('#ogp-jump').fill(target.wire);await page.locator('#ogp-jump-form button').click();await page.locator('[data-detection-id="'+target.id+'"].is-current').waitFor();
  await page.evaluate(()=>{window.imageWrites=0;const put=IDBObjectStore.prototype.put;IDBObjectStore.prototype.put=function(...args){if(this.name==='images')window.imageWrites++;return put.apply(this,args);};});
  await page.locator('[data-act="ogp-complete"][data-id="'+target.id+'"]').click();await page.locator('[data-detection-id="'+next.id+'"].is-current').waitFor();assert.equal(await page.locator('.modal').count(),0);assert.equal(await page.evaluate(()=>imageWrites),0);
  await page.locator('#toast [data-act="ogp-undo"]').click();await page.locator('[data-detection-id="'+target.id+'"].is-current').waitFor();assert.equal((await read()).ogpRows.find(r=>r.id===target.id).completedAt,null);
  await page.locator('[data-act="ogp-complete"][data-id="'+target.id+'"]').click();await page.locator('[data-detection-id="'+next.id+'"].is-current').waitFor();
  await page.locator('#ogp-module').selectOption('320MLF3WDIH0631');await page.waitForFunction(()=>document.querySelector('.field-module').textContent==='320MLF3WDIH0631');
  state=await read();const late=state.ogpRows.filter(r=>r.moduleId==='320MLF3WDIH0631').sort((a,b)=>Number(a.wire)-Number(b.wire))[32];
  await page.locator('#ogp-jump').fill(late.wire);await page.locator('#ogp-jump-form button').click();await page.locator('[data-detection-id="'+late.id+'"].is-current').waitFor();
  await page.reload();await page.locator('.shell').waitFor();assert.equal(await page.locator('#ogp-module').inputValue(),'320MLF3WDIH0631');await page.locator('[data-detection-id="'+late.id+'"].is-current').waitFor();assert.match(await page.locator('.field-current').innerText(),new RegExp('W'+late.wire));
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.locator('.field-module-row .text-button').click();await page.locator('#modal-title').filter({hasText:'选择生产模块'}).waitFor();await page.locator('.modal-head [data-act="close-modal"]').click();
  await page.screenshot({path:path.join(out,'mobile-field-mode.png')});
  // Module ZIP contains all original images for this module and original source pages 2/3.
  const moduleDownload=page.waitForEvent('download');await page.locator('.field-panel [data-act="backup-module"]').click();const modulePath=path.join(out,'module.zip');await(await moduleDownload).saveAs(modulePath);
  const moduleInfo=await page.evaluate(async()=>{const info=await(await import('./storage.js')).getBackupInfo();return {moduleId:info.moduleId,at:info.at};});assert.equal(moduleInfo.moduleId,'320MLF3WDIH0631');
  const moduleBytes=fs.readFileSync(modulePath);
  const inspected=await page.evaluate(async encoded=>{const {readArchive}=await import('./archive.js');const bytes=Uint8Array.from(atob(encoded),c=>c.charCodeAt(0));const s=await readArchive(new File([bytes],'module.zip'));window.moduleRestore=s;return {modules:s.modules.map(m=>m.id),rows:s.ogpRows.length,pages:s.ogpImports[0].pages.map(p=>p.page),partial:s.ogpImports[0].partial,images:s.ogpImages.length};},moduleBytes.toString('base64'));
  assert.deepEqual(inspected,{modules:['320MLF3WDIH0631'],rows:44,pages:[2,3],partial:true,images:44});
  // Restore a partial packet on an empty device, then merge the full packet without dropping rows.
  const emptyContext=await browser.newContext({viewport:{width:390,height:844}}),empty=await emptyContext.newPage();await empty.goto(url);await empty.locator('.shell').waitFor();await nav('mapping',empty);await empty.locator('[data-act="restore"]').click();await empty.locator('#backup-file').setInputFiles(modulePath);await empty.waitForFunction(()=>!document.querySelector('#restore-confirm').disabled);await empty.locator('#restore-confirm').click();await empty.locator('.modal').waitFor({state:'hidden'});assert.equal((await read(empty)).ogpRows.length,44);await nav('ogp',empty);assert.equal(await empty.locator('#ogp-module').inputValue(),'320MLF3WDIH0631');await nav('mapping',empty);
  await nav('mapping');const fullZipDownload=page.waitForEvent('download');await page.locator('[data-act="backup-zip"]').click();const fullPath=path.join(out,'all.zip');await(await fullZipDownload).saveAs(fullPath);
  const jsonDownload=page.waitForEvent('download');await page.locator('[data-act="backup"]').click();const jsonPath=path.join(out,'all.json');await(await jsonDownload).saveAs(jsonPath);
  assert.ok(fs.statSync(fullPath).size<fs.statSync(jsonPath).size*0.80);
  let fullState=JSON.parse(fs.readFileSync(jsonPath,'utf8')).data;
  await empty.locator('[data-act="restore"]').click();await empty.locator('#backup-file').setInputFiles(fullPath);await empty.waitForFunction(()=>!document.querySelector('#restore-confirm').disabled);await empty.locator('#restore-confirm').click();await empty.locator('.modal').waitFor({state:'hidden'});const merged=await read(empty);assert.equal(merged.ogpRows.length,121);assert.equal(merged.ogpImports[0].partial,false);assert.equal(merged.records[0].photos[0].data,seeded.photo);
  const immutable=await empty.evaluate(async()=>{
    const storage=await import('./storage.js'),state=await storage.loadState(),first=state.ogpImages[0],original=(await storage.getImage(first.id)).data;
    first.data=state.ogpImages[1].data;await storage.saveState(state);
    return (await storage.getImage(first.id)).data===original;
  });assert.equal(immutable,true);
  await nav('records');await page.locator('[data-act="new-record"]').first().click();await page.locator('#issue-note').fill('新增后应提示尚未备份');await page.locator('[form="record-form"]').click();await page.locator('.modal').waitFor({state:'hidden'});await nav('mapping');await page.locator('.essential-note').filter({hasText:'新增 1 条待备份'}).waitFor();fullState=await read();
  // The untouched legacy database is still the pre-upgrade state until rollback is requested.
  const oldStill=await page.evaluate(async()=>{const s=await(await import('./previous-dev/storage.js')).loadState();return {rows:s.ogpRows.length,completed:s.ogpRows.filter(r=>r.completedAt).length};});assert.deepEqual(oldStill,{rows:121,completed:0});
  const originalDownload=page.waitForEvent('download');await page.locator('[data-act="pre-upgrade-backup"]').click();const originalPath=path.join(out,'before-upgrade.json');await(await originalDownload).saveAs(originalPath);const original=JSON.parse(fs.readFileSync(originalPath,'utf8')).data;assert.equal(original.ogpRows.filter(r=>r.completedAt).length,0);assert.equal(original.records[0].photos[0].data,seeded.photo);
  // Real UI downgrade/upgrade roundtrip keeps later edits, including ordinary photos.
  await page.locator('[data-act="previous-version"]').click();await page.locator('[data-act="confirm-previous-version"]').click();await page.waitForURL('**/previous-dev/');await page.locator('.shell').waitFor();const downgraded=await read();assert.deepEqual(downgraded,fullState);assert.equal(await page.locator('.field-panel').count(),0);
  await nav('ogp');const oldTarget=downgraded.ogpRows.find(r=>!r.completedAt&&r.moduleId==='320MLF3WDIH0630');await page.locator('[data-act="ogp-complete"][data-id="'+oldTarget.id+'"]').click();await page.waitForFunction(async()=>{const s=await(await import('./storage.js')).loadState();return s.ogpRows.filter(r=>r.completedAt).length===2;});
  await page.locator('#return-new-version').click();await page.waitForURL(url);await page.locator('.shell').waitFor();state=await read();assert.equal(state.ogpRows.length,121);assert.equal(state.ogpRows.filter(r=>r.completedAt).length,2);assert.equal(state.records[0].photos[0].data,seeded.photo);assert.equal(state.overallRecords[0].photos[0].data,seeded.photo);
  await nav('ogp');await page.waitForFunction(()=>[...document.querySelectorAll('[data-mobile-status]')].some(n=>n.textContent==='离线已就绪'));await context.setOffline(true);await page.reload();await page.locator('.field-panel').waitFor();assert.equal((await read()).ogpRows.filter(r=>r.completedAt).length,2);
  await page.setViewportSize({width:1440,height:1000});await page.screenshot({path:path.join(out,'desktop-field-mode.png')});
  assert.deepEqual(errors,[]);
  const result={passed:true,legacyMigration:true,legacyUnchangedUntilExplicitRollback:true,ordinaryAndOgpPhotosPreserved:true,metadataBytes:storageSize.bytes,imageWritesOnComplete:0,currentModuleMode:true,wireJump:true,nextFocus:true,undo:true,resumeModuleAndPosition:true,moduleZip:inspected,fullZipBytes:fs.statSync(fullPath).size,compatibleJsonBytes:fs.statSync(jsonPath).size,zipRestoredAndPartialFullMerge:true,newRecordBackupReminder:true,immutableStoredImages:true,preUpgradeSnapshot:true,realDowngradeUpgradeWithEdits:true,offlineAfterReturn:true,pageErrors:errors};
  fs.writeFileSync(path.join(out,'field-tests.json'),JSON.stringify(result,null,2));console.log('PASS:',JSON.stringify(result));await browser.close();browser=null;
})().catch(async error=>{console.error(error);if(browser)await browser.close();process.exitCode=1;});
