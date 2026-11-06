const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {chromium}=require('playwright');
const [backupPath,url='http://127.0.0.1:8765/']=process.argv.slice(2),out=path.resolve(process.env.BONDING_TEST_OUTPUT||'.dev-evidence/large-rollback');fs.mkdirSync(out,{recursive:true});let browser;
async function summary(page){return page.evaluate(async()=>{
  const base=new URL('storage.js',document.querySelector('script[src$="app.js"]').src),s=await(await import(base)).loadState();
  const digest=async text=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)))].map(n=>n.toString(16).padStart(2,'0')).join('');
  const photos=async r=>({...r,photos:await Promise.all(r.photos.map(async p=>({name:p.name,sha256:await digest(p.data)})))});
  const images=[];for(const p of s.ogpImages||[])images.push({id:p.id,name:p.name,width:p.width,height:p.height,sha256:await digest(p.data)});
  const records=[];for(const r of s.records)records.push(await photos(r));const overall=[];for(const r of s.overallRecords||[])overall.push(await photos(r));
  return {modules:s.modules,activeModuleId:s.activeModuleId,records,overall,rows:s.ogpRows,imports:s.ogpImports,images,mapping:s.importedMapping,mappingMeta:s.mappingMeta};
});}
(async()=>{
  browser=await chromium.launch({headless:true,channel:process.env.PLAYWRIGHT_CHANNEL||(process.platform==='win32'?'msedge':undefined)});const context=await browser.newContext({viewport:{width:390,height:844}}),page=await context.newPage();
  await page.goto(new URL('previous-dev/',url).href);await page.locator('.shell').waitFor();await page.locator('.bottom-nav [data-view="mapping"]').click();await page.locator('[data-act="restore"]').click();await page.locator('#backup-file').setInputFiles(backupPath);await page.waitForFunction(()=>!document.querySelector('#restore-confirm').disabled,null,{timeout:90000});await page.locator('#restore-confirm').click();await page.locator('.modal').waitFor({state:'hidden',timeout:90000});const original=await summary(page);
  await page.goto(url);await page.locator('.shell').waitFor({timeout:90000});const migrated=await summary(page);assert.deepEqual(migrated,original);
  const bytes=await page.evaluate(async()=>new TextEncoder().encode(JSON.stringify(await(await import('./storage.js')).loadState({images:false}))).byteLength);assert.ok(bytes<500000);
  await page.locator('.bottom-nav [data-view="mapping"]').click();await page.locator('[data-act="previous-version"]').click();await page.locator('[data-act="confirm-previous-version"]').click();await page.waitForURL('**/previous-dev/',{timeout:90000});await page.locator('.shell').waitFor();assert.deepEqual(await summary(page),original);
  await page.locator('#return-new-version').click();await page.waitForURL(url,{timeout:90000});await page.locator('.shell').waitFor({timeout:90000});assert.deepEqual(await summary(page),original);
  const result={passed:true,inputBackupBytes:fs.statSync(backupPath).size,metadataBytes:bytes,rows:original.rows.length,images:original.images.length,migrationExact:true,downgradeExact:true,returnExact:true,allImageAndPhotoHashesPreserved:true};fs.writeFileSync(path.join(out,'large-tests.json'),JSON.stringify(result,null,2));console.log('PASS:',JSON.stringify(result));await browser.close();browser=null;
})().catch(async error=>{console.error(error);if(browser)await browser.close();process.exitCode=1;});
