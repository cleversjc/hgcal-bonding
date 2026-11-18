import {makeBackup,readBackup,getImageBlob} from './storage.js';
const hash=async bytes=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(n=>n.toString(16).padStart(2,'0')).join('');
async function zipLibrary(){if(!globalThis.JSZip)await import('./vendor/zip/jszip.min.js');return globalThis.JSZip;}
export function moduleState(state,moduleId) {
  const rows=(state.ogpRows||[]).filter(r=>r.moduleId===moduleId),ids=new Set(rows.map(r=>r.imageId));
  const reports=(state.ogpImports||[]).filter(r=>rows.some(row=>row.importId===r.id)).map(report=>{
    const selected=rows.filter(r=>r.importId===report.id),pages=report.pages.filter(p=>selected.some(r=>r.sourcePage===p.page));
    return {...report,pages,rowCount:selected.length,...(selected.length===report.rowCount?{}:{partial:true,originalRowCount:report.originalRowCount||report.rowCount})};
  });
  return {...state,modules:state.modules.filter(m=>m.id===moduleId),records:state.records.filter(r=>r.moduleId===moduleId),overallRecords:(state.overallRecords||[]).filter(r=>r.moduleId===moduleId),activeModuleId:moduleId,ogpRows:rows,ogpImports:reports,ogpImages:(state.ogpImages||[]).filter(p=>ids.has(p.id))};
}
export async function createArchive(state,{moduleId=null}={}) {
  const JSZip=await zipLibrary(),zip=new JSZip(),copy=structuredClone(moduleId?moduleState(state,moduleId):state),media=new Map();
  const images=[...(copy.ogpImages||[]),...copy.records.flatMap(r=>r.photos),...(copy.overallRecords||[]).flatMap(r=>r.photos)];
  for(const image of new Set(images)){
    let bytes,mime,blob;
    if(typeof image.data==='string'){const [prefix,base64]=image.data.split(',');mime=prefix.slice(5,prefix.indexOf(';'));bytes=Uint8Array.from(atob(base64),c=>c.charCodeAt(0));}
    else{blob=await getImageBlob(image.id);mime=blob.type;bytes=new Uint8Array(await blob.arrayBuffer());}
    const sha256=await hash(bytes),extension=mime.includes('png')?'png':mime.includes('webp')?'webp':'jpeg',path='media/'+sha256+'.'+extension;
    if(image.sha256&&image.sha256!==sha256)throw new Error('原图校验失败，未生成备份。');
    if(!media.has(path)){zip.file(path,blob||bytes,{compression:'STORE'});media.set(path,{sha256,bytes:bytes.length});}
    delete image.data;image.archivePath=path;
  }
  zip.file('manifest.json',JSON.stringify({app:'HGCAL Bonding Archive',schemaVersion:1,moduleId,media:Object.fromEntries(media),backup:makeBackup(copy)}));
  return zip.generateAsync({type:'blob',compression:'STORE',mimeType:'application/zip'});
}
export async function readArchive(file) {
  const JSZip=await zipLibrary(),buffer=await file.arrayBuffer();let zip=await JSZip.loadAsync(buffer);
  const files=Object.values(zip.files);if(files.length>10000||files.reduce((n,f)=>n+(f._data?.uncompressedSize||0),0)>512*1024*1024)throw new Error('备份过大，请按模块恢复。');
  zip=await JSZip.loadAsync(buffer,{checkCRC32:true});
  const manifest=JSON.parse(await zip.file('manifest.json')?.async('string'));
  if(manifest.app!=='HGCAL Bonding Archive'||manifest.schemaVersion!==1||!manifest.backup?.data||!manifest.media)throw new Error('不是受支持的完整 ZIP 备份。');
  const data=manifest.backup.data,images=[...(data.ogpImages||[]),...data.records.flatMap(r=>r.photos),...(data.overallRecords||[]).flatMap(r=>r.photos)],loaded=new Map();
  for(const image of images){
    const path=image.archivePath,meta=manifest.media[path];
    if(!/^media\/[a-f0-9]{64}\.(jpeg|png|webp)$/.test(path)||!meta||!zip.file(path))throw new Error('备份缺少原图。');
    if(!loaded.has(path)){
      const bytes=await zip.file(path).async('uint8array');if(bytes.length!==meta.bytes||await hash(bytes)!==meta.sha256)throw new Error('备份图片校验失败。');
      let binary='';for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));
      loaded.set(path,'data:image/'+path.split('.').at(-1)+';base64,'+btoa(binary));
    }
    image.data=loaded.get(path);delete image.archivePath;
  }
  return readBackup(JSON.stringify(manifest.backup));
}
