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
  async function digest(data) {const b=bytes(data);return {...b,sha256:[...new Uint8Array(await crypto.subtle.digest('SHA-256',b.bytes))].map(n=>n.toString(16).padStart(2,'0')).join('')};}
  async function prepare(data) {
    validateState(data,{allowImageRefs:true});
    const refs=new Map(),pending=[],remap=new Map(),knownIds=new Map();
    for(const image of data.ogpImages||[])if(!image.data)refs.set(image.sha256,image);
    async function imageRef(image) {
      if(!image.data)return image;
      const {sha256,mime,bytes:raw}=await digest(image.data);
      let existing=refs.get(sha256);
      if(!existing)existing=await request(connection.transaction('images','readonly').objectStore('images').index('sha256').get(sha256));
      const occupied=image.id?(knownIds.get(image.id)||await read(connection,'images',image.id)):null;
      const id=existing?.id||(occupied&&occupied.sha256!==sha256?'image-'+sha256:image.id)||'photo-'+sha256;
      const {data:unused,...meta}=image;
      const ref={...meta,id,sha256,mime,byteLength:raw.length};
      if(!existing){pending.push({...ref,blob:new Blob([raw],{type:mime})});refs.set(sha256,ref);knownIds.set(id,ref);}
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
  async function getBackupInfo() {await ensure();return await read(connection,'state','backup-info')||null;}
  async function noteBackup(moduleId=null,exportedState=null) {
    const state=exportedState||await loadState({images:false}),last=await getBackupInfo()||{},include=r=>!moduleId||r.moduleId===moduleId;
    const entry={at:new Date().toISOString(),moduleId,fingerprint:fingerprint(state,moduleId),ids:[...state.records.filter(include).map(r=>'record:'+r.id),...(state.overallRecords||[]).filter(include).map(r=>'overall:'+r.id),...(state.ogpRows||[]).filter(include).map(r=>'ogp:'+r.id)]};
    const info={...entry,scopes:{...(last.scopes||{}),[moduleId||'all']:entry}};
    const tx=connection.transaction('state','readwrite'),done=finished(tx);tx.objectStore('state').put(info,'backup-info');await done;return info;
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
  return {loadState,saveState,getImage,getImageBlob,hydrateState,getBackupInfo,noteBackup,fingerprint,checkpointBackup,prepareRollback};
}
