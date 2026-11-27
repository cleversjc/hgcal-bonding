const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

(async () => {
  const ogp = await import('../ogp.js');
  const storage = await import('../storage.js');
  const { BUILTIN_MAPPING, BACKSIDE_ORDER } = await import('../domain-data.js');
  const { parseCaptionItems, pairCaptions } = await import('../ogp-pdf.js');
  const { prepareOgpImport: prepareLegacyImport } = await import('../previous-dev/ogp.js');
  const expectedNumbering = require('./fixtures/ogp-report-mappings.cjs').legacy;
  const now = '2026-11-04T12:00:00.000Z';
  const image = {name:'evidence.png',width:1,height:1,data:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1ioAAAAASUVORK5CYII='};
  const signals = BUILTIN_MAPPING.filter(e=>e.side==='front'&&/^C\d+$/.test(e.target));
  assert.equal(signals.length,198);
  assert.deepEqual(BACKSIDE_ORDER,['H','G','L','K','J','I']);
  const manifest = {app:'HGCAL OGP Import',schemaVersion:1,source:{name:'test.pdf',sha256:'a'.repeat(64),pageCount:1,parser:'test'},pages:[{page:1,moduleId:'320MLF3WDIH0630',count:198}],detections:signals.map((e,i)=>({moduleId:'320MLF3WDIH0630',cell:e.target,confidence:0.52,page:1,index:i+1,caption:'cell '+e.target.slice(1)+' conf 0.52',image}))};
  const draft = ogp.prepareOgpImport(manifest,'QA',now);
  assert.equal(draft.rows.length,198);
  for (const row of draft.rows) {
    const unchanged = signals.find(e=>e.target===row.reportedCell);
    const [target, firstWire] = expectedNumbering[row.reportedCell] || [unchanged.target, unchanged.wires[0]];
    assert.equal(row.mapping.target,target);
    assert.equal(row.wire,firstWire);
    assert.equal(typeof row.wire,'string');
    assert.equal(row.mapping.wires.length,3);
  }
  for (const [cell,wire] of Object.entries({C111:'211',C118:'322',C57:'367',C185:'505',C70:'97'})) assert.equal(draft.rows.find(r=>r.reportedCell===cell).wire,wire);
  const letterLocations = BUILTIN_MAPPING.filter(entry => entry.side === 'front' && /^[A-Z]$/.test(entry.target));
  assert.equal(letterLocations.length, 12);
  const letters = { ...manifest, pages: [{ ...manifest.pages[0], count: letterLocations.length }],
    detections: letterLocations.map(({target}, index) => ({ ...manifest.detections[index], cell: target, caption: 'cell '+target+' conf 0.52' })) };
  for (const mode of ['legacy', 'ld-v3']) {
    const letterRows = ogp.prepareOgpImport(letters, 'QA', now, mode).rows;
    assert.deepEqual(letterRows.map(row => [row.mapping.target, row.wire]), letterLocations.map(entry => [entry.target, entry.wires[0]]));
  }
  assert.throws(() => ogp.prepareOgpImport(manifest, 'QA', now, ''), /不同位点/);
  const directDraft = ogp.prepareOgpImport(manifest, 'QA', now, 'ld-v3');
  for (const [index, row] of directDraft.rows.entries()) {
    const expected = row.reportedCell === 'C143' ? ['C142', '85'] : [signals[index].target, signals[index].wires[0]];
    assert.deepEqual([row.mapping.target, row.wire], expected);
    assert.equal(ogp.pendingOgpNumberingUpdate(row), null);
  }
  assert.deepEqual(signals.filter(entry => ['C142','C143'].includes(entry.target)).map(entry => entry.wires[0]), ['85','337']);
  assert.equal(directDraft.rows.find(row => row.reportedCell === 'C142').mapping.numberingVersion, '2026-11-18-ld-v3-labels');
  const directState = ogp.appendOgpImport(storage.emptyState(), directDraft);
  assert.deepEqual(storage.readBackup(JSON.stringify(storage.makeBackup(directState))).ogpRows, directState.ogpRows);
  const directC143 = directState.ogpRows.find(row => row.reportedCell === 'C143');
  const stateWith = changed => ({ ...directState, ogpRows: directState.ogpRows.map(row => row.id === changed.id ? changed : row) });
  const restore = state => storage.readBackup(JSON.stringify(storage.makeBackup(state)));
  for (const numberingVersion of [undefined, '2026-11-18', '2026-11-25-c143-revert', '2026-11-18-ld-v3-labels']) {
    const mapping = { ...directC143.mapping, target: 'C143', wires: ['337','338','339'] };
    if (numberingVersion) mapping.numberingVersion = numberingVersion;
    else delete mapping.numberingVersion;
    const prior = { ...directC143, mapping, wire: '337', originalWire: '337', history: [{ ...directC143.history[0], wire: '337' }] };
    assert.deepEqual(restore(stateWith(prior)), stateWith(prior));
    assert.equal(ogp.pendingOgpNumberingUpdate(prior).target, 'C142');
    assert.throws(() => ogp.applyOgpNumberingUpdate(prior, 'QA', now), /确认将这条 C143/);
    const corrected = ogp.applyOgpNumberingUpdate(prior, 'QA', now, { confirmedC143: true });
    assert.deepEqual([corrected.mapping, corrected.originalWire, corrected.imageId, corrected.history[0]],
      [prior.mapping, '337', prior.imageId, prior.history[0]]);
    assert.deepEqual([corrected.numberingUpdate.target, corrected.wire], ['C142', '85']);
    assert.equal(ogp.pendingOgpNumberingUpdate(corrected), null);
    assert.deepEqual(restore(stateWith(corrected)), stateWith(corrected));
    const wrongVersion = { ...prior, mapping: { ...mapping, numberingVersion: ogp.OGP_NUMBERING_VERSION } };
    assert.throws(() => restore(stateWith(wrongVersion)), /原始映射/);
  }
  const historicalW85 = { ...directC143, mapping: { ...directC143.mapping, numberingVersion: '2026-11-20-c143' } };
  assert.deepEqual(restore(stateWith(historicalW85)), stateWith(historicalW85));
  assert.equal(ogp.pendingOgpNumberingUpdate(historicalW85), null);
  const original = draft.rows.find(r=>r.reportedCell==='C111');
  const edited = ogp.editOgpRow(original,{wire:'W25',operator:'QA2',status:'normal',note:'看图确认',reason:'现场核对'},'2026-11-04T12:01:00.000Z');
  assert.equal(original.wire,'211'); assert.equal(edited.wire,'25'); assert.equal(edited.originalWire,'211');
  assert.equal(edited.history.length,2); assert.equal(edited.history[1].operator,'QA2'); assert.equal(edited.history[1].reason,'现场核对');
  assert.equal(ogp.hasOgpSpecialHandling(original),false);
  assert.equal(edited.specialHandling,true);
  assert.equal(edited.history.at(-1).specialHandling,true);
  const plainNote=ogp.editOgpRow(edited,{wire:'25',operator:'QA2',status:'normal',note:'普通检查备注',reason:'',specialHandling:false});
  assert.equal(ogp.hasOgpSpecialHandling(plainNote),false,'explicit choice overrides note-based legacy compatibility');
  const legacyNotes=structuredClone(edited);delete legacyNotes.specialHandling;legacyNotes.history.forEach(h=>delete h.specialHandling);
  assert.equal(ogp.hasOgpSpecialHandling(legacyNotes),true);
  legacyNotes.note='';assert.equal(ogp.hasOgpSpecialHandling(legacyNotes),true,'historical treatment remains discoverable');
  assert.throws(()=>ogp.editOgpRow(original,{wire:original.wire,operator:'QA',status:'pending',note:'',reason:'',specialHandling:'yes'}),/特殊处理/);
  for (const wire of ['0','631','-1','2.5','not a wire']) assert.throws(()=>ogp.editOgpRow(original,{wire,operator:'QA',status:'pending',note:'',reason:'test'}));
  assert.equal(ogp.editOgpRow(original,{wire:'W630',operator:'QA',status:'pending',note:'',reason:'test'}).wire,'630');
  assert.throws(()=>ogp.editOgpRow(original,{wire:'25',operator:'QA',status:'pending',note:'',reason:''}),/原因/);
  const state=ogp.appendOgpImport(storage.emptyState(),draft);
  assert.equal(state.ogpImages.length,1,'identical bytes share an image, without merging detections');
  assert.equal(state.ogpRows.length,198);
  const done=ogp.setOgpCompletion(state.ogpRows[0],true,'QA','2026-11-04T12:02:00.000Z');
  assert.equal(done.status,state.ogpRows[0].status,'completion does not infer normal/anomaly');
  assert.equal(done.note,state.ogpRows[0].note);assert.equal(done.wire,state.ogpRows[0].wire);
  assert.equal(done.history.at(-1).action,'complete');assert.equal(done.completedBy,'QA');
  assert.equal(ogp.setOgpCompletion(done,true,'QA').history.length,done.history.length,'double tap is idempotent');
  const completedState={...state,ogpRows:[done,...state.ogpRows.slice(1)]};
  const savedOriginal=state.ogpRows.find(r=>r.id===original.id);
  const treated=ogp.setOgpCompletion(ogp.editOgpRow(savedOriginal,{wire:original.wire,operator:'QA2',status:'pending',note:'已清理并复检',reason:''},'2026-11-04T12:04:00.000Z'),true,'QA2','2026-11-04T12:04:00.000Z');
  assert.equal(treated.status,'pending');assert.equal(treated.imageId,savedOriginal.imageId);
  assert.deepEqual(treated.history.slice(-2).map(h=>h.specialHandling),[true,true]);
  assert.deepEqual(ogp.filterOgpRows([original,edited,treated],'all','special').map(r=>r.id),[edited.id,treated.id]);
  assert.deepEqual(ogp.filterOgpRows([original,edited,treated],'all','special-unfinished').map(r=>r.id),[edited.id]);
  assert.deepEqual(ogp.filterOgpRows([original,edited,treated],'all','special-completed').map(r=>r.id),[treated.id]);
  assert.equal(ogp.filterOgpRows([treated],'320MLF3WDIH0631','special').length,0);
  const treatedState={...state,ogpRows:state.ogpRows.map(r=>r.id===treated.id?treated:r)};
  assert.deepEqual(storage.readBackup(JSON.stringify(storage.makeBackup(treatedState))),treatedState);
  assert.match(ogp.ogpCsv([treated],state.ogpImports).split('\r\n')[0],/"special_handling"/);
  for(const mutate of [s=>s.ogpRows.find(r=>r.id===treated.id).specialHandling='yes',s=>s.ogpRows.find(r=>r.id===treated.id).specialHandling=false,s=>s.ogpRows.find(r=>r.id===treated.id).history.at(-1).specialHandling='yes']){
    const broken=structuredClone(treatedState);mutate(broken);assert.throws(()=>storage.readBackup(JSON.stringify(storage.makeBackup(broken))),/特殊处理/);
  }
  assert.equal(ogp.filterOgpRows(completedState.ogpRows).length,197);
  assert.deepEqual(ogp.filterOgpRows(completedState.ogpRows,'all','completed').map(r=>r.id),[done.id]);
  assert.equal(ogp.filterOgpRows(completedState.ogpRows,'all','all').length,198);
  assert.deepEqual(storage.readBackup(JSON.stringify(storage.makeBackup(completedState))),completedState);
  assert.match(ogp.ogpCsv(completedState.ogpRows,completedState.ogpImports).split('\r\n')[0],/"completed_at","completed_by"/);
  const reopened=ogp.setOgpCompletion(done,false,'QA','2026-11-04T12:03:00.000Z');
  assert.equal(reopened.completedAt,null);assert.equal(reopened.history.at(-1).action,'reopen');
  assert.equal(ogp.filterOgpRows([reopened]).length,1);
  assert.deepEqual(storage.readBackup(JSON.stringify(storage.makeBackup({...state,ogpRows:[reopened,...state.ogpRows.slice(1)]}))).ogpRows[0],reopened);
  const badCompletion=structuredClone(completedState);badCompletion.ogpRows[0].completedAt=now;
  assert.throws(()=>storage.readBackup(JSON.stringify(storage.makeBackup(badCompletion))),/完成/);
  const backup=JSON.stringify(storage.makeBackup(state));
  assert.deepEqual(storage.readBackup(backup),state);
  const second=ogp.appendOgpImport(state,ogp.prepareOgpImport(manifest,'QA',now));
  assert.equal(second.ogpRows.length,396); assert.equal(second.ogpImports.length,2); assert.equal(second.ogpImages.length,1);
  assert.equal(ogp.duplicateOgpWires(second.ogpRows).size,396);
  const merged=storage.mergeBackup(state,second);
  assert.equal(merged.state.ogpRows.length,396); assert.equal(merged.state.ogpImages.length,1);
  assert.equal(merged.added,198); assert.equal(merged.skipped,198);
  assert.equal(storage.mergeBackup(merged.state,second).added,0);
  assert.throws(()=>ogp.appendOgpImport(state,draft),/已经保存/);
  const legacy=storage.emptyState(); delete legacy.ogpRows; delete legacy.ogpImages; delete legacy.ogpImports; delete legacy.overallRecords;
  assert.deepEqual(storage.readBackup(JSON.stringify(storage.makeBackup(legacy))),legacy);
  assert.equal(storage.mergeBackup(state,legacy).state.ogpRows.length,198);
  for (const mutate of [s=>s.ogpImages.pop(),s=>s.ogpRows[0].confidence=2,s=>s.ogpRows[0].wire='2',s=>s.ogpImports[0].pages[0].moduleId='missing',s=>s.ogpRows[0].sourceIndex=s.ogpRows[1].sourceIndex,s=>s.ogpRows[0].imageId='missing']) {
    const broken=structuredClone(state); mutate(broken);
    assert.throws(()=>storage.readBackup(JSON.stringify(storage.makeBackup(broken))));
  }
  const duplicateManifest=structuredClone(manifest); duplicateManifest.detections.push({...duplicateManifest.detections[0],index:199}); duplicateManifest.pages[0].count++;
  const repeatedCell=ogp.prepareOgpImport(duplicateManifest,'QA',now);
  assert.equal(repeatedCell.rows.length,199);
  const numericAliases=Object.entries(expectedNumbering).filter(([, [target]])=>target.startsWith('C')&&!expectedNumbering[target]);
  const expectedDuplicates=new Set([manifest.detections[0].cell,...numericAliases.flatMap(([cell,[target]])=>[cell,target])]);
  assert.deepEqual(ogp.duplicateOgpWires(repeatedCell.rows),new Set(repeatedCell.rows.filter(row=>expectedDuplicates.has(row.reportedCell)).map(row=>row.id)));
  const legacyRow=prepareLegacyImport(manifest,'QA',now).rows.find(row=>row.reportedCell==='C3');
  const updated=ogp.applyOgpNumberingUpdate(legacyRow,'QA','2026-11-18T12:01:00.000Z');
  assert.deepEqual([updated.mapping,updated.originalWire,updated.reportedCell,updated.imageId,updated.history[0]],[legacyRow.mapping,'10','C3',legacyRow.imageId,legacyRow.history[0]]);
  assert.deepEqual([ogp.ogpLocation(updated).target,updated.wire],['M','607']);
  assert.equal(ogp.pendingOgpNumberingUpdate(updated),null);
  assert.equal(ogp.pendingOgpNumberingUpdate(ogp.setOgpCompletion(legacyRow,true,'QA')),null);
  assert.equal(ogp.pendingOgpNumberingUpdate(ogp.editOgpRow(legacyRow,{wire:'9',operator:'QA',status:'pending',note:'',reason:'现场修正'})),null);
  const csv=ogp.ogpCsv(second.ogpRows,second.ogpImports);
  assert.ok(csv.startsWith('\uFEFF')); assert.match(csv,/image_id/); assert.match(csv,/yolo_confidence/); assert.match(csv,/true/); assert.match(csv,/audit_history/);
  assert.equal(csv.split('\r\n').filter(Boolean).length,397);
  const viewport={convertToViewportPoint:(x,y)=>[x,842-y]};
  assert.throws(()=>parseCaptionItems([{str:'cell 1 conf 0.3',transform:[1,0,0,1,30,680]}],viewport,null),/标题/);
  const continued=parseCaptionItems([{str:'cell 1 conf 0.3',transform:[1,0,0,1,30,680]}],viewport,'320MLF3WDIH0631');
  assert.equal(continued.moduleId,'320MLF3WDIH0631'); assert.equal(continued.inherited,true);
  for (const [caption,cell] of [['cell m conf 0.4','M'],['cell C014 conf 0.5','C14'],['cell C conf 0.6','C']]) {
    assert.equal(parseCaptionItems([{str:caption,transform:[1,0,0,1,30,680]}],viewport,continued.moduleId).captions[0].cell,cell);
  }
  for (const bad of ['G','S','0','199']) assert.throws(()=>parseCaptionItems([{str:'cell '+bad+' conf 0.4',transform:[1,0,0,1,30,680]}],viewport,continued.moduleId));
  assert.throws(()=>pairCaptions(continued.captions,[]),/数量/);
  assert.throws(()=>pairCaptions(continued.captions,[{x:200,y:50,width:100,height:70}]),/对应/);
  const sw=fs.readFileSync(path.join(__dirname,'../sw.js'),'utf8'),mobile=fs.readFileSync(path.join(__dirname,'../mobile-app.js'),'utf8');
  assert.equal(sw.match(/SHELL_VERSION = '([^']+)'/)[1],mobile.match(/SHELL_VERSION = '([^']+)'/)[1]);
  assert.ok(sw.includes('pdf.worker.min.mjs')); assert.ok(sw.includes('ogp-pdf.js')); assert.ok(!/\.skipWaiting\(/.test(sw));
  console.log('PASS: 198 signal and 12 letter labels in both modes, C143 W85, historical mappings, duplicate flags, audit, backups, CSV and backside order');
})().catch(error=>{console.error(error);process.exitCode=1;});
