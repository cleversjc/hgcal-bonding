// Image bytes are immutable and stored once; normal edits only read/write metadata.
// The original v1 database is intentionally retained for the previous-dev app.
export function createPersistence({ emptyState, validateState }) {
  const NAME = 'hgcal-bonding-workbench-v2', LEGACY = 'hgcal-bonding-workbench';
  let connection, initialization;
  const request = req => new Promise((resolve,reject)=>{req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});
  const finished = tx => new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onerror=tx.onabort=()=>reject(new Error('未能保存，请检查设备空间；已有数据保持不变。'));});
  async function open(name, modern=false) {
    return new Promise((resolve,reject)=>{
      const r=indexedDB.open(name,1);
      r.onupgradeneeded=()=>{const d=r.result;d.createObjectStore('state');if(modern){d.createObjectStore('images',{keyPath:'id'}).createIndex('sha256','sha256');d.createObjectStore('checkpoints');}};
      r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(new Error('无法打开本机存储，请允许保存网站数据。'));
    });
  }
  async function read(database,store,key) {return request(database.transaction(store,'readonly').objectStore(store).get(key));}
  function bytes(data) {const [header,base64]=data.split(',');return {mime:header.slice(5,header.indexOf(';')),bytes:Uint8Array.from(atob(base64),c=>c.charCodeAt(0))};}
  async function digest(raw) {return [...new Uint8Array(await crypto.subtle.digest('SHA-256',raw))].map(n=>n.toString(16).padStart(2,'0')).join('');}
  async function prepare(data) {
    validateState(data,{allowImageRefs:true,allowImageBlobs:true});
    const refs=new Map(),pending=[],remap=new Map(),knownIds=new Map();
    for(const image of data.ogpImages||[])if(!image.data&&!image.blob)refs.set(image.sha256,image);
    async function imageRef(image) {
      const {blob:pendingBlob,data:encoded,...meta}=image;
      const blob=encoded===undefined&&pendingBlob instanceof Blob?pendingBlob:null;
      if(!encoded&&!blob)return image;
      const decoded=blob?null:bytes(encoded);
      const mime=blob?.type??decoded.mime;
      const byteLength=blob?.size??decoded.bytes.length;
      const sha256=await digest(blob?await blob.arrayBuffer():decoded.bytes);
      let existing=refs.get(sha256);
      if(!existing)existing=await request(connection.transaction('images','readonly').objectStore('images').index('sha256').get(sha256));
      const occupied=image.id?(knownIds.get(image.id)||await read(connection,'images',image.id)):null;
      const id=existing?.id||(occupied&&occupied.sha256!==sha256?'image-'+sha256:image.id)||'photo-'+sha256;
      const ref={...meta,id,sha256,mime,byteLength};
      if(!existing){pending.push({...ref,blob:blob||new Blob([decoded.bytes],{type:mime})});refs.set(sha256,ref);knownIds.set(id,ref);}
      return ref;
    }
    const images=[];
    for(const image of data.ogpImages||[]){const ref=await imageRef(image);if(image.id)remap.set(image.id,ref.id);if(!images.some(p=>p.id===ref.id))images.push(ref);}
    const records=[];for(const r of data.records)records.push({...r,photos:await Promise.all(r.photos.map(imageRef))});
    const overall=[];for(const r of data.overallRecords||[])overall.push({...r,photos:await Promise.all(r.photos.map(imageRef))});
    const state={...data,records,overallRecords:overall,ogpImages:images,ogpRows:(data.ogpRows||[]).map(r=>({...r,imageId:remap.get(r.imageId)||r.imageId}))};
    validateState(state,{allowImageRefs:true});return {state,pending};
  }
  async function write(data,{checkpoint}={}) {
    const {state,pending}=await prepare(data),tx=connection.transaction(['state','images','checkpoints'],'readwrite'),done=finished(tx);
    try{
      for(const image of pending)tx.objectStore('images').put(image);
      if(checkpoint)tx.objectStore('checkpoints').put({state,createdAt:new Date().toISOString(),label:checkpoint},checkpoint);
      tx.objectStore('state').put(state,'main');await done;return state;
    }catch(error){try{tx.abort();}catch{}await done.catch(()=>{});throw error;}
  }
  async function ensure() {
    if(initialization)return initialization;
    initialization=(async()=>{
      connection=await open(NAME,true);
      connection.onversionchange=()=>{connection.close();connection=null;initialization=null;};
      const initialize=async()=>{
        const current=await read(connection,'state','main'),handoff=!!await read(connection,'state','handoff-pending');
        if(current&&!handoff)return;
        const legacy=await open(LEGACY);let old;
        try{old=await read(legacy,'state','main');}finally{legacy.close();}
        if(current&&handoff){const tx=connection.transaction('checkpoints','readwrite'),done=finished(tx);tx.objectStore('checkpoints').put({state:current,createdAt:new Date().toISOString(),label:'返回新版前'},'before-legacy-return-'+Date.now());await done;}
        await write(old||emptyState(),{checkpoint:current?'从上一版返回':'更新前数据'});
        if(handoff){const tx=connection.transaction('state','readwrite'),done=finished(tx);tx.objectStore('state').delete('handoff-pending');await done;}
      };
      if(globalThis.navigator?.locks)await navigator.locks.request('hgcal-bonding-v2-init',initialize);else await initialize();
      return connection;
    })().catch(e=>{initialization=null;throw e;});return initialization;
  }
  async function storedImage(id) {await ensure();const result=await read(connection,'images',id);if(!result)throw new Error('原图暂不可读取，请保留数据并恢复完整备份。');return result;}
  async function getImageBlob(id) {const image=await storedImage(id);return image.blob||new Blob([bytes(image.data).bytes],{type:image.mime});}
  async function getImage(id) {
    const image=await storedImage(id);if(image.data)return image;
    const raw=new Uint8Array(await image.blob.arrayBuffer());let binary='';for(let i=0;i<raw.length;i+=8192)binary+=String.fromCharCode(...raw.subarray(i,i+8192));
    const {blob,...metadata}=image;return {...metadata,data:'data:'+image.mime+';base64,'+btoa(binary)};
  }
  async function hydrateState(state) {
    const loaded=new Map();
    async function hydrate(p){if(p.data)return p;if(!loaded.has(p.id))loaded.set(p.id,getImage(p.id));const full=await loaded.get(p.id);return {...full,...p,data:full.data};}
    const images=[];for(const p of state.ogpImages||[])images.push(await hydrate(p));
    const records=[];for(const r of state.records)records.push({...r,photos:await Promise.all(r.photos.map(hydrate))});
    const overall=[];for(const r of state.overallRecords||[])overall.push({...r,photos:await Promise.all(r.photos.map(hydrate))});
    return {...state,ogpImages:images,records,overallRecords:overall};
  }
  async function loadState({images=true}={}) {await ensure();const state=await read(connection,'state','main')||emptyState();return images?hydrateState(state):state;}
  async function saveState(state) {await ensure();return write(state);}
  async function clearOgpAndIssues() {
    await ensure();
    const tx=connection.transaction(['state','images','checkpoints'],'readwrite');
    const done=finished(tx), states=tx.objectStore('state'), images=tx.objectStore('images');
    const removedImages=new Set(), keptImages=new Set();
    let cleaned, failure;
    function clear(snapshot) {
      for (const image of snapshot.ogpImages || []) removedImages.add(image.id);
      for (const record of snapshot.records) for (const photo of record.photos) removedImages.add(photo.id);
      for (const record of snapshot.overallRecords || []) for (const photo of record.photos) keptImages.add(photo.id);
      return {...snapshot, records:[], ogpRows:[], ogpImports:[], ogpImages:[]};
    }
    function step(callback) {
      try { callback(); }
      catch (error) { failure=error; tx.abort(); }
    }
    const handoff=states.get('handoff-pending');
    handoff.onsuccess=()=>step(()=>{
      if (handoff.result) throw new Error('当前记录已交给上一版，请先完成返回流程。');
      const main=states.get('main');
      main.onsuccess=()=>step(()=>{
        cleaned=clear(main.result || emptyState());
        validateState(cleaned,{allowImageRefs:true});
        const checkpoints=tx.objectStore('checkpoints').openCursor();
        checkpoints.onsuccess=()=>step(()=>{
          const cursor=checkpoints.result;
          if (cursor) {
            const snapshot=clear(cursor.value.state);
            validateState(snapshot,{allowImageRefs:true});
            cursor.update({...cursor.value,state:snapshot});
            cursor.continue();
          } else {
            for (const id of removedImages) if (id && !keptImages.has(id)) images.delete(id);
            states.put(cleaned,'main');
            // The last-backup fingerprint contains copies of issue/OGP metadata.
            // Exported files are outside this database.
            states.delete('backup-info');
          }
        });
      });
    });
    try { await done; }
    catch (error) { throw failure || error; }
    return cleaned;
  }
  async function getBackupInfo() {await ensure();return await read(connection,'state','backup-info')||null;}
  async function noteBackup(moduleId=null,exportedState=null) {
    const state=exportedState||await loadState({images:false});
    await ensure();
    const include=r=>!moduleId||r.moduleId===moduleId;
    const idsFor=s=>[...s.records.filter(include).map(r=>'record:'+r.id),...(s.overallRecords||[]).filter(include).map(r=>'overall:'+r.id),...(s.ogpRows||[]).filter(include).map(r=>'ogp:'+r.id)];
    const entry={at:new Date().toISOString(),moduleId,fingerprint:fingerprint(state,moduleId),ids:idsFor(state)};
    const tx=connection.transaction('state','readwrite'),done=finished(tx),store=tx.objectStore('state');
    const current=store.get('main'), previous=store.get('backup-info');
    let info;
    previous.onsuccess=()=>{
      const last=previous.result;
      const liveIds=new Set(idsFor(current.result||emptyState()));
      // A backup already in flight may still finish its download after a clear.
      // Do not put deleted records back into the local fingerprint.
      if (entry.ids.some(id=>!liveIds.has(id))) {info=last||null;return;}
      info={...entry,scopes:{...(last?.scopes||{}),[moduleId||'all']:entry}};
      store.put(info,'backup-info');
    };
    await done;
    return info;
  }
  function fingerprint(state,moduleId=null) {
    const include=r=>!moduleId||r.moduleId===moduleId;
    const photo=p=>({id:p.id||null,sha256:p.sha256||null,name:p.name});
    const record=r=>({...r,photos:r.photos.map(photo)});
    return JSON.stringify({modules:state.modules.filter(m=>!moduleId||m.id===moduleId),records:state.records.filter(include).map(record),overall:(state.overallRecords||[]).filter(include).map(record),rows:(state.ogpRows||[]).filter(include),mapping:state.importedMapping});
  }
  async function checkpointBackup() {await ensure();const original=await read(connection,'checkpoints','更新前数据');if(!original)throw new Error('没有更新前快照。');return hydrateState(original.state);}
  async function prepareRollback() {
    const current=await loadState();validateState(current);
    const legacy=await open(LEGACY);
    try{
      const old=await read(legacy,'state','main'),tx=legacy.transaction('state','readwrite'),done=finished(tx);
      if(old)tx.objectStore('state').put(old,'before-rollback-'+Date.now());
      tx.objectStore('state').put(current,'main');await done;
      const marker=connection.transaction('state','readwrite'),marked=finished(marker);marker.objectStore('state').put(true,'handoff-pending');await marked;
    }finally{legacy.close();}
    return current;
  }
  return {loadState,saveState,clearOgpAndIssues,getImage,getImageBlob,hydrateState,getBackupInfo,noteBackup,fingerprint,checkpointBackup,prepareRollback};
}
