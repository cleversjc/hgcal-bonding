// The explicit return link hands the latest legacy records back to the new app.
// Keep this intent in IndexedDB, independently of optional UI preferences.
document.querySelector('#return-new-version')?.addEventListener('click',event=>{
  event.preventDefault();const destination=event.currentTarget.href;
  let fresh=false;
  const failed=()=>{let box=document.querySelector('#return-new-error');if(!box){box=document.createElement('p');box.id='return-new-error';box.setAttribute('role','alert');document.querySelector('#return-new-version').parentElement.append(box);}box.textContent='暂未切换。请保留此窗口，导出当前完整 JSON 后再试。';};
  try{
    const request=indexedDB.open('hgcal-bonding-workbench-v2');
    request.onupgradeneeded=()=>{fresh=true;request.transaction.abort();};
    request.onerror=()=>fresh?location.assign(destination):failed();
    request.onsuccess=()=>{
      const db=request.result;
      try{const tx=db.transaction('state','readwrite');tx.objectStore('state').put(true,'handoff-pending');tx.oncomplete=()=>{db.close();location.assign(destination);};tx.onerror=tx.onabort=()=>{db.close();failed();};}
      catch{db.close();failed();}
    };
  }catch{failed();}
});
