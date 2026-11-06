const KEY='hgcal-bonding-field-session-v1';
export function readFieldSession() {
  try {
    const value=JSON.parse(localStorage.getItem(KEY));
    if(!value||typeof value.moduleId!=='string'||value.moduleId.length>80||!['unfinished','completed','all','pending','normal','anomaly'].includes(value.status))return null;
    return {...value,currentId:typeof value.currentId==='string'?value.currentId.slice(0,128):'',scrollY:Number.isFinite(value.scrollY)?Math.max(0,Math.min(value.scrollY,10000000)):0,limits:Object.fromEntries(Object.entries(value.limits||{}).filter(([key,n])=>key.length<=80&&Number.isInteger(n)&&n>0&&n<=10000))};
  }catch{return null;}
}
export function saveFieldSession(value) {try{localStorage.setItem(KEY,JSON.stringify(value));}catch{/* Records remain in IndexedDB even if preferences cannot be retained. */}}
export function nextOgpRow(rows,id) {const index=rows.findIndex(r=>r.id===id);return rows[index+1]||rows[index-1]||null;}
export function progressFor(rows,moduleId) {const group=rows.filter(r=>moduleId==='all'||r.moduleId===moduleId);const completed=group.filter(r=>r.completedAt).length;return {total:group.length,completed,remaining:group.length-completed};}
