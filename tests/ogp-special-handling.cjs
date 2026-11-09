// User workflow regression: record treatment and finish in one atomic save.
// NODE_PATH=<playwright> node tests/ogp-special-handling.cjs report.ogp.json [url]
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {chromium}=require('playwright');
const [fixturePath,url='http://127.0.0.1:8765/']=process.argv.slice(2);
const out=path.resolve(process.env.BONDING_TEST_OUTPUT||'.dev-evidence/special-handling');fs.mkdirSync(out,{recursive:true});
let browser;
(async()=>{
  const manifest=JSON.parse(fs.readFileSync(fixturePath,'utf8'));
  manifest.detections=manifest.detections.slice(0,3);
  manifest.detections.push({...manifest.detections[2],index:4});
  manifest.detections.push({...manifest.detections[0],moduleId:'320MLF3WDIH0631',page:2,index:1});
  manifest.source.pageCount=2;manifest.pages=[{page:1,moduleId:'320MLF3WDIH0630',count:4},{page:2,moduleId:'320MLF3WDIH0631',count:1}];
  browser=await chromium.launch({headless:true,channel:process.env.PLAYWRIGHT_CHANNEL||(process.platform==='win32'?'msedge':undefined)});
  const context=await browser.newContext({viewport:{width:390,height:844},acceptDownloads:true}),page=await context.newPage(),errors=[],dialogs=[];
  page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>{dialogs.push(d.message());d.accept();});
  const nav=async(view,p=page)=>p.locator('.bottom-nav [data-view="'+view+'"]').click();
  const read=async(p=page)=>p.evaluate(async()=>await(await import('./storage.js')).loadState());
  const card=(id,p=page)=>p.locator('[data-detection-id="'+id+'"]');
  const edit=async(id,p=page)=>p.locator('[data-act="ogp-edit"][data-id="'+id+'"]').click();
  const save=async(complete=false,p=page)=>{await p.locator('[form="ogp-edit-form"][value="'+(complete?'complete':'save')+'"]').click();await p.locator('.modal').waitFor({state:'hidden'});};
  await page.goto(url);await page.locator('.shell').waitFor();
  const ids=await page.evaluate(async manifest=>{
    const store=await import('./storage.js'),ogp=await import('./ogp.js');let s=ogp.appendOgpImport(store.emptyState(),ogp.prepareOgpImport(manifest,'Treatment QA'));
    s.ogpRows=s.ogpRows.map((row,i)=>{
      if(i===0||i===4)row=ogp.setOgpCompletion(ogp.editOgpRow(row,{wire:row.wire,status:'normal',operator:'Legacy QA',note:'历史处理：补胶并复检',reason:''}),true,'Legacy QA');
      if(i===1)row=ogp.editOgpRow(row,{wire:row.wire,status:'anomaly',operator:'Legacy QA',note:'',reason:''});
      delete row.specialHandling;row.history.forEach(h=>delete h.specialHandling);return row;
    });await store.saveState(s);return s.ogpRows.map(r=>r.id);
  },manifest);
  await page.reload();await page.locator('.shell').waitFor();await nav('ogp');
  const target=ids[2],duplicate=ids[3],initial=(await read()).ogpRows.find(r=>r.id===target);
  await edit(target);await page.locator('#ogp-wire').fill(initial.wire==='25'?'26':'25');await page.locator('#ogp-note').fill('清理漏胶，重新键合\n显微镜复检通过');
  assert.equal(await page.locator('#ogp-special-handling').isChecked(),true);
  await page.locator('#ogp-save-complete').click();await page.locator('#form-error').filter({hasText:'修正原因'}).waitFor();
  assert.deepEqual((await read()).ogpRows.find(r=>r.id===target),initial,'invalid edit must not mark completion');
  assert.equal(await page.locator('[form="ogp-edit-form"]:disabled').count(),0);
  await page.locator('#ogp-reason').fill('机台现场核对位置');await page.locator('#ogp-edit-operator').fill('处理员甲');
  await page.locator('#ogp-special-handling').scrollIntoViewIfNeeded();await page.screenshot({path:path.join(out,'mobile-review.png')});
  await page.evaluate(()=>{const button=document.querySelector('#ogp-save-complete');button.click();button.click();});
  await page.locator('.modal').waitFor({state:'hidden'});assert.equal(await card(target).count(),0);await card(duplicate).waitFor();
  let state=await read(),done=state.ogpRows.find(r=>r.id===target);
  assert.ok(done.completedAt);assert.equal(done.completedBy,'处理员甲');assert.equal(done.specialHandling,true);assert.equal(done.status,'pending');
  assert.equal(done.imageId,initial.imageId);assert.equal(done.originalWire,initial.originalWire);assert.equal(done.history.length,initial.history.length+2);
  assert.deepEqual(done.history.slice(-2).map(h=>h.specialHandling),[true,true]);assert.equal(done.history.at(-1).action,'complete');
  assert.equal(state.ogpRows.find(r=>r.id===duplicate).completedAt,undefined,'duplicate Wire remains a separate task');assert.deepEqual(dialogs,[]);
  await page.locator('[data-act="ogp-undo"]').click();await card(target).waitFor();
  let reopened=(await read()).ogpRows.find(r=>r.id===target);assert.equal(reopened.completedAt,null);assert.equal(reopened.note,done.note);assert.equal(reopened.specialHandling,true);
  await edit(target);await save(true);await card(target).waitFor({state:'hidden'});
  await page.locator('#ogp-status').selectOption('special');assert.equal(await page.locator('.ogp-item').count(),2);await card(ids[0]).waitFor();await card(target).waitFor();
  assert.match(await card(target).innerText(),/已完成/);assert.match(await card(target).innerText(),/特殊处理/);
  await page.locator('#ogp-status').selectOption('special-unfinished');assert.equal(await page.locator('.ogp-item').count(),0);
  await page.locator('#ogp-status').selectOption('special-completed');assert.equal(await page.locator('.ogp-item').count(),2);
  await page.locator('#ogp-module').selectOption('all');assert.equal(await page.locator('.ogp-item').count(),3);
  await page.locator('#ogp-module').selectOption('320MLF3WDIH0630');await page.locator('#ogp-status').selectOption('unfinished');
  // A normal note can be explicitly excluded; a special task can be saved unfinished.
  await edit(duplicate);await page.locator('#ogp-note').fill('普通检查，无需特殊处理');await page.locator('#ogp-special-handling').uncheck();await save();
  assert.equal((await read()).ogpRows.find(r=>r.id===duplicate).specialHandling,false);
  await page.locator('#ogp-status').selectOption('special');assert.equal(await card(duplicate).count(),0);
  await page.locator('#ogp-status').selectOption('unfinished');await edit(ids[1]);await page.locator('#ogp-special-handling').check();await save();
  await page.locator('#ogp-status').selectOption('special-unfinished');await card(ids[1]).waitFor();assert.equal(await page.locator('.ogp-item').count(),1);
  // Storage failure preserves the complete previous record and the editable draft.
  await edit(ids[1]);const beforeFailure=(await read()).ogpRows.find(r=>r.id===ids[1]);await page.locator('#ogp-note').fill('更换受损线并复检');
  await page.evaluate(()=>{window.originalOgpPut=IDBObjectStore.prototype.put;IDBObjectStore.prototype.put=function(value,key){if(this.transaction.db.name==='hgcal-bonding-workbench-v2'&&this.name==='state'&&key==='main')throw new DOMException('injected quota failure','QuotaExceededError');return window.originalOgpPut.apply(this,arguments);};});
  await page.locator('#ogp-save-complete').click();await page.locator('#form-error').filter({hasText:'injected quota failure'}).waitFor();
  assert.deepEqual((await read()).ogpRows.find(r=>r.id===ids[1]),beforeFailure);assert.equal(await page.locator('#ogp-note').inputValue(),'更换受损线并复检');assert.equal(await page.locator('[form="ogp-edit-form"]:disabled').count(),0);
  await page.evaluate(()=>{IDBObjectStore.prototype.put=window.originalOgpPut;});await save(true);assert.equal(await page.locator('.ogp-item').count(),0);
  // Concurrent saves must reject a stale combined completion rather than lose another edit.
  await page.locator('#ogp-status').selectOption('unfinished');await edit(duplicate);await page.locator('#ogp-note').fill('过期窗口草稿');
  const other=await context.newPage();await other.goto(url);await other.locator('.shell').waitFor();await nav('ogp',other);await other.locator('#ogp-status').selectOption('unfinished');await edit(duplicate,other);await other.locator('#ogp-note').fill('另一窗口已核对');await save(false,other);
  await page.locator('#ogp-save-complete').click();await page.locator('#form-error').filter({hasText:'其他窗口更新'}).waitFor();
  const concurrent=(await read()).ogpRows.find(r=>r.id===duplicate);assert.equal(concurrent.note,'另一窗口已核对');assert.equal(concurrent.completedAt,undefined);
  await page.locator('.modal-head [data-act="close-modal"]').click();await page.locator('.modal').waitFor({state:'hidden'});await other.close();
  // Filtered CSV and both complete backup formats retain the treatment flag and original images.
  await page.locator('#ogp-status').selectOption('special');await page.locator('.field-module').scrollIntoViewIfNeeded();await page.screenshot({path:path.join(out,'mobile-special-filter.png')});
  const csvEvent=page.waitForEvent('download');await page.locator('[data-act="ogp-export"]').click();const csvPath=path.join(out,'special.csv');await(await csvEvent).saveAs(csvPath);const csv=fs.readFileSync(csvPath,'utf8');
  assert.match(csv,/"special_handling"/);assert.ok(csv.includes(target));assert.ok(csv.includes(ids[1]));assert.ok(!csv.includes(ids[4]),'CSV respects module filter');assert.match(csv,/"true"/);
  const jsonEvent=page.waitForEvent('download');await page.locator('[data-act="backup"]').click();const jsonPath=path.join(out,'special.json');await(await jsonEvent).saveAs(jsonPath);
  await nav('mapping');const zipEvent=page.waitForEvent('download');await page.locator('[data-act="backup-zip"]').click();const zipPath=path.join(out,'special.zip');await(await zipEvent).saveAs(zipPath);state=await read();
  for(const file of [jsonPath,zipPath]){
    const restoreContext=await browser.newContext({viewport:{width:390,height:844}}),p=await restoreContext.newPage();p.on('pageerror',e=>errors.push(e.message));await p.goto(url);await p.locator('.shell').waitFor();await nav('mapping',p);await p.locator('[data-act="restore"]').click();await p.locator('#backup-file').setInputFiles(file);await p.waitForFunction(()=>!document.querySelector('#restore-confirm').disabled);await p.locator('#restore-confirm').click();await p.locator('.modal').waitFor({state:'hidden'});assert.deepEqual(await read(p),state);await nav('ogp',p);await p.locator('#ogp-status').selectOption('special-completed');assert.equal(await p.locator('.ogp-item').count(),3);await restoreContext.close();
  }
  // The existing previous-version handoff also carries the new optional flag.
  await page.locator('[data-act="previous-version"]').click();await page.locator('[data-act="confirm-previous-version"]').click();await page.waitForURL('**/previous-dev/');await page.locator('.shell').waitFor();
  assert.deepEqual((await read()).ogpRows,state.ogpRows);assert.deepEqual((await read()).ogpImages,state.ogpImages);
  await page.locator('#return-new-version').click();await page.waitForURL(url);await page.locator('.shell').waitFor();assert.deepEqual(await read(),state);
  await nav('ogp');await page.locator('#ogp-status').selectOption('special-completed');
  await page.waitForFunction(()=>[...document.querySelectorAll('[data-mobile-status]')].some(e=>e.textContent==='离线已就绪'));
  await context.setOffline(true);await page.reload();await page.locator('.shell').waitFor();assert.equal(await page.locator('#ogp-status').inputValue(),'special-completed');assert.equal(await page.locator('.ogp-item').count(),3);assert.deepEqual(await read(),state);await context.setOffline(false);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);assert.deepEqual(errors,[]);
  const result={passed:true,saveAndCompleteWithoutExtraClick:true,completionDoesNotInferInspectionResult:true,wireCorrectionAndAudit:true,duplicateTaskUntouched:true,doubleClickIdempotent:true,undoRetainsTreatment:true,legacyNotesIncluded:true,specialFiltersIncludeCompleted:true,moduleScopeAndCsv:true,manualSpecialFlag:true,saveOnlyRemainsUnfinished:true,failedSaveAtomicAndRetryable:true,staleCombinedSaveRejected:true,jsonAndZipRestoreExact:true,previousVersionRoundtripExact:true,offlineFilterResume:true,originalImagesPreserved:true,pageErrors:errors};
  fs.writeFileSync(path.join(out,'special-tests.json'),JSON.stringify(result,null,2));console.log('PASS:',JSON.stringify(result));await browser.close();browser=null;
})().catch(async error=>{console.error(error);if(browser)await browser.close();process.exitCode=1;});
