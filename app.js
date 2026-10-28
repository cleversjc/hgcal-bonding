import { CELL_POSITIONS, GROUP_POSITIONS, MAP_IMAGE, BUILTIN_MAPPING, GROUNDING, BACKSIDE_ORDER, DOMAIN_NOTES, REFERENCE_MAP_METADATA, REFERENCE_COORDINATES } from './domain-data.js';
import { normalizeTarget, normalizeWire, wireKey, parseMapping, validateAgainstBuiltin, getMappings, resolveStoredMappings, lookupTarget, lookupWire, coverage, csvEncode } from './mapping.js';
import { loadState, saveState, makeBackup, readBackup, mergeBackup } from './storage.js';
import { BACKSIDE_POSITIONS, renderBacksideMap } from './backside-map.js';
import { initMobileApp, getMobileAppState, promptMobileInstall } from './mobile-app.js';
import { lookupOgpCandidates } from './ogp-candidates.js';

const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const e = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const uniqueId = () => typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : 'rec_' + [...crypto.getRandomValues(new Uint8Array(16))].map(n=>n.toString(16).padStart(2,'0')).join('');
const paths = {
  map:'<path d="m3 6 6-3 6 3 6-3v15l-6 3-6-3-6 3V6Z"/><path d="M9 3v15M15 6v15"/>',
  log:'<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4V2h6v2M9 10h6M9 14h6M9 18h3"/>',
  data:'<path d="m12 3 9 5-9 5-9-5 9-5ZM3 12l9 5 9-5M3 16l9 5 9-5"/>',
  search:'<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4.5 4.5"/>',
  plus:'<path d="M12 5v14M5 12h14"/>',
  minus:'<path d="M5 12h14"/>',
  chevron:'<path d="m9 5 7 7-7 7"/>',
  down:'<path d="m6 9 6 6 6-6"/>',
  info:'<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/>',
  close:'<path d="m6 6 12 12M18 6 6 18"/>',
  check:'<path d="m5 12 4 4L19 6"/>',
  camera:'<path d="M8 5 9 3h6l1 2h4a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Z"/><circle cx="12" cy="12" r="4"/>',
  download:'<path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/>',
  upload:'<path d="M12 16V4m-5 5 5-5 5 5M4 16v5h16v-5"/>',
  hex:'<path d="m12 2 9 5v10l-9 5-9-5V7Z"/><path d="m3 7 9 5 9-5M12 12v10"/>',
  clock:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  repair:'<path d="M14 6a5 5 0 0 0-6 6l-5 5a2 2 0 0 0 4 4l5-5a5 5 0 0 0 6-6l-3 3-4-4 3-3Z"/>',
  reset:'<path d="M4 10a8 8 0 1 1 1 7M4 4v6h6"/>',
  arrow:'<path d="M5 12h14m-5-5 5 5-5 5"/>',
  rotate:'<path d="M20 8a8 8 0 1 0 0 8M20 3v5h-5"/>',
  link:'<path d="m10 13 4-4M8 15l-2 2a4 4 0 0 1-5-5l5-5a4 4 0 0 1 5 0M13 17a4 4 0 0 0 5 0l5-5a4 4 0 0 0-5-5l-2 2"/>',
  shield:'<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z"/><path d="m8 12 3 3 5-6"/>'
};
const icon = name => '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">' + (paths[name] || paths.info) + '</svg>';
const STATUS = {open:'待处理',repaired:'待复检',closed:'已关闭',void:'已作废'};
const KINDS = {signal:'信号键合 · Signal',shield:'屏蔽键合 · Shield',guard:'保护环 · Guard ring',back:'背面键合 · Backside'};
const TYPES = ['线数不足','无法键合','断线','焊点脱落','线形 / 位置异常','污染 / 异物','TD / 机台报警','Pull test 异常','电测异常','其他'];
const PHASES = ['绑定中','绑定前检查','绑定后目检','Pull test','电子学测试','返修 / 复检'];
let state, entries = [], mappingConflicts = [], pendingPhotos = [], stagedImport = null, stagedBackup = null, recordContext = null;
let toastTimer, returnFocus, modalKind = '', modalEpoch = 0, dirty = false, photoBusy = false, commitQueue = Promise.resolve();
let channel;
const ui = {view:'lookup',side:'front',mode:'cell',cellSource:'ogp',ogpInput:'C19',ogpCandidate:'',target:'C19',wire:'',query:'19',zoom:1,rotated:false,backMachine:false,filter:'all',recordSearch:'',scope:'module'};
const activeModule = () => state.modules.find(m => m.id === state.activeModuleId);
const moduleRecords = () => state.records.filter(r => r.moduleId === state.activeModuleId && r.status !== 'void');
const date = (v, full = false) => new Intl.DateTimeFormat('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',...(full?{year:'numeric'}:{}),hour12:false}).format(new Date(v));
const sideName = side => side === 'back' ? '背面' : '正面';
const badge = (s) => '<span class="badge ' + (s === 'open'?'amber':s === 'void'?'red':'') + '">' + e(STATUS[s] || s) + '</span>';
const button = (act, label, ic = '', cls = '') => '<button type="button" class="button ' + cls + '" data-act="' + act + '">' + (ic?icon(ic):'') + label + '</button>';
const selectOptions = (items, value) => items.map(x => '<option value="'+e(x)+'" '+(x === value?'selected':'')+'>'+e(x)+'</option>').join('');
const footer = () => '<footer class="page-footer"><span>HGCAL / BONDING WORKBENCH</span><span>LD V3 · OGP 候选 v2 · 本机记录</span></footer>';

function mobileStatusLabel() {
  if(getMobileAppState().updateAvailable)return '新版已准备，保存后关闭所有窗口并重开';
  const status=getMobileAppState().offlineStatus;
  return status==='ready'?'离线使用已准备':status==='preparing'?'正在准备离线使用…':status==='error'?'离线缓存尚未完成，请联网后重开':'当前环境暂不支持离线打开';
}
function mobileUsageStrip() {
  return '<div class="mobile-usage-strip"><div><b>免登录 · 数据保存在本机</b><span data-mobile-status>'+mobileStatusLabel()+'</span></div><button type="button" class="button small" data-act="mobile-help" data-mobile-cta>'+(getMobileAppState().installed?'手机使用说明':'安装到手机')+'</button></div>';
}
function refreshMobileStatus() {
  $$('[data-mobile-status]').forEach(el=>el.textContent=mobileStatusLabel());
  $$('[data-mobile-cta]').forEach(el=>el.textContent=getMobileAppState().installed?'手机使用说明':'安装到手机');
  $$('[data-mobile-install]').forEach(el=>el.hidden=!getMobileAppState().canInstall);
}
function mobileHelpModal() {
  modalKind='mobile-help';
  openModal('安装到手机与本地保存','无需 ChatGPT、Google 或其他账号。',
    '<div class="mobile-help"><div class="notice info">'+icon('check')+'<div><b data-mobile-status>'+mobileStatusLabel()+'</b><p>首次联网打开，等离线准备完成后，再从桌面图标使用。</p></div></div><div class="install-platforms"><section><h3>Android · Chrome</h3><ol><li>用 Chrome 打开本应用。</li><li>点右上角 ⋮，选择“安装和创建快捷方式”→“安装”；部分版本显示“安装应用”或“添加到主屏幕”。</li><li>确认后，从桌面 Bonding 图标打开。</li></ol></section><section><h3>iPhone · Safari</h3><ol><li>用 Safari 打开本应用。</li><li>点“共享”→“添加到主屏幕”；部分布局先打开页面菜单。</li><li>若有“作为网页 App 打开”，保持开启，再点“添加”。</li></ol></section></div><div class="local-data-note"><h3>先添加到主屏幕，再开始正式记录</h3><p>浏览器与桌面网页 App 的本地数据可能分开，尤其是 iPhone。已有记录时，先在原入口选择“映射与资料 → 完整备份”，再在新入口通过“恢复备份”导入。</p><p>模块、异常和照片只保存在当前设备的浏览器 / 网页 App 内，不会自动上传或同步。请定期导出完整 JSON 备份；清除网站数据、卸载或更换手机前先备份。记录人的姓名只是记录字段，不是账号。</p></div><div class="install-quick-start"><h3>开始使用</h3><p>选择 / 新建模块 → 正面查号或背面点选 → 记录异常 → 补充返修与复检 → 导出备份。</p></div></div>',
    button('close-modal','知道了')+'<button type="button" class="button primary" data-act="mobile-install" data-mobile-install '+(getMobileAppState().canInstall?'':'hidden')+'>安装 Bonding</button>',true);
}
function toast(message) {
  $('#toast').textContent = message; $('#toast').classList.add('visible');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => $('#toast').classList.remove('visible'), 4000);
}
function error(message) {
  const box = $('#form-error'); if (box) { box.textContent = message; box.scrollIntoView({block:'nearest'}); } else toast(message);
}
function updateEntries() {
  const resolved=resolveStoredMappings(BUILTIN_MAPPING,state.importedMapping);
  entries=resolved.entries.filter(entry=>entry.side==='front');mappingConflicts=resolved.conflicts;
}
function mappingConflictNotice() {
  return mappingConflicts.length?'<div class="notice" style="margin-bottom:18px">'+icon('info')+'<div>此前导入的 '+mappingConflicts.length+' 个位点与完整编号表冲突，已暂停用于查号。原始导入及历史记录均保留。<br><button class="text-button" data-act="nav" data-view="mapping">查看并导出待核对条目 '+icon('chevron')+'</button></div></div>':'';
}
function mappingConflictPanel() {
  if(!mappingConflicts.length)return '';
  return '<section class="card" style="margin-bottom:20px"><div class="card-head"><h2>此前导入的映射需要核对</h2><span class="badge amber">'+mappingConflicts.length+' 个位点未启用</span></div><div class="card-pad"><p class="small muted" style="line-height:1.8">完整编号表更新后，以下旧条目不再用于当前查号。原始导入仍保存在本机，历史记录及其映射快照保持原样。</p><details style="margin-top:14px"><summary class="small" style="cursor:pointer">查看冲突条目</summary><ul class="source-notes" style="margin-top:14px">'+mappingConflicts.map(c=>'<li><b class="mono">'+e(c.entry.target)+'</b> · '+sideName(c.entry.side)+' · '+e(c.entry.wires.map(w=>'W'+w).join(', '))+'<br>'+e(c.reason)+'</li>').join('')+'</ul></details><div class="settings-actions">'+button('export-stored-mapping','导出原始用户映射','download','small')+button('backup','完整备份','download','small')+'</div></div></section>';
}
function referenceCoordinate(side,target) {
  const point=REFERENCE_COORDINATES[side+':'+target];
  if(!point)return '';
  return '<details class="reference-xy"><summary>原表 XY <span class="mono">'+e(point.raw)+'</span>'+(point.needsReview?' <span class="xy-review-tag">待核对</span>':'')+'</summary><p>编号表第 '+point.sourcePage+' 页的原值；单位及机台校准坐标系未注明。'+(point.needsReview?'此值与教程图的邻近关系存在疑点，已保留原文，请现场核对。':'')+'</p></details>';
}
function historicalMappingMismatch(record) {
  if(!record.target)return false;
  const targetEntry=lookupTarget(entries,record.target,record.side);
  if(!targetEntry)return false;
  const oldWires=record.wires.length?record.wires:record.mapping.expectedWires;
  return oldWires.some(w=>!targetEntry.wires.some(current=>wireKey(w)===wireKey(current)));
}
async function commit(updater) {
  const operation = async () => {
    const work = async () => {
      const latest = await loadState();
      const next = updater(latest);
      await saveState(next); state = next; updateEntries(); render();
      channel?.postMessage('updated');
    };
    if (navigator.locks) await navigator.locks.request('hgcal-bonding-save', work); else await work();
  };
  commitQueue = commitQueue.catch(() => {}).then(operation);
  return commitQueue;
}
function nav(mobile = false) {
  const items = [['lookup','编号对照','map'],['records','异常记录','log'],['mapping','映射与资料','data']];
  return '<nav class="'+(mobile?'bottom-nav':'nav-items')+'" aria-label="主导航">' + items.map(([view,title,ic]) => '<button type="button" class="nav-btn '+(ui.view === view?'active':'')+'" data-act="nav" data-view="'+view+'" '+(ui.view===view?'aria-current="page"':'')+'>'+icon(ic)+'<span>'+title+'</span>'+(view==='records'?'<b class="nav-count">'+state.records.filter(r=>r.status!=='void').length+'</b>':'')+'</button>').join('') + '</nav>';
}
function render() {
  const mod = activeModule();
  const pageTitle = {lookup:'编号对照',records:'异常记录',mapping:'映射与资料'}[ui.view];
  $('#app').innerHTML = '<div class="shell"><aside class="sidebar"><div class="brand"><img src="assets/icon.svg" alt=""><div><strong>Bonding</strong><span class="upper">CMS · HGCAL WORKSPACE</span></div></div><div><p class="rail-label">WORKSPACE</p>'+nav()+'</div><div class="rail-bottom"><div class="rail-scope"><span class="upper">ACTIVE TEMPLATE</span><strong>LD V3 / Full</strong><p>正面 198 cells · 背面 6 位置</p></div><p><span class="save-dot"></span>记录保存在此设备<br>导出备份，保留每次处理。</p></div></aside><main class="main"><header class="topbar"><div class="breadcrumb">生产工作台 '+icon('chevron')+' <b>'+pageTitle+'</b></div><div class="mobile-brand"><img src="assets/icon.svg" alt=""><div><strong>Bonding</strong><small>CMS · HGCAL</small></div></div><div class="top-right"><span class="connection"><span class="save-dot"></span>本机保存</span><button class="module-button" data-act="module"><span class="module-icon">'+icon('hex')+'</span><span><small>CURRENT MODULE</small><span class="mono">'+e(mod?.id || '选择 / 新建模块')+'</span></span>'+icon('down')+'</button></div></header><div class="content">'+(ui.view==='lookup'?lookupPage():ui.view==='records'?recordsPage():mappingPage())+footer()+'</div></main>'+nav(true)+'</div>';
}
function sideToggle() {
  return '<div class="side-toggle" aria-label="模块正反面"><button type="button" data-act="side" data-side="front" aria-pressed="'+(ui.side==='front')+'" class="'+(ui.side==='front'?'active':'')+'">正面</button><button type="button" data-act="side" data-side="back" aria-pressed="'+(ui.side==='back')+'" class="'+(ui.side==='back'?'active':'')+'">背面</button></div>';
}
function currentOgpResult() {
  if(ui.side!=='front'||ui.mode!=='cell'||ui.cellSource!=='ogp'||!ui.ogpInput)return null;
  return lookupOgpCandidates(entries,ui.ogpInput);
}
function cellSourceBar() {
  if(ui.side!=='front'||ui.mode!=='cell')return '';
  return '<div class="cell-source-bar"><span>输入编号来源</span><div class="cell-source-options" role="group" aria-label="Cell 编号来源"><button type="button" data-act="cell-source" data-source="ogp" aria-pressed="'+(ui.cellSource==='ogp')+'" class="'+(ui.cellSource==='ogp'?'active':'')+'">OGP 编号 · 查候选</button><button type="button" data-act="cell-source" data-source="exact" aria-pressed="'+(ui.cellSource==='exact')+'" class="'+(ui.cellSource==='exact'?'active':'')+'">实际 Cell · 精确查</button></div><p>'+(ui.cellSource==='ogp'?'奔驰标可能借用相邻 cell 的编号；查询后列出可核对的候选。A–F / M–R 仍按位点精确查号。':'按实际 cell 与编号表精确对应；若编号来自 OGP，请切换到候选查询。')+'</p></div>';
}
function ogpCandidatesCard(result) {
  const labels={baseline:'同编号基准',junction:'图示交点候选 · 同级',neighbor:'其他相邻候选 · 同级',special:'小 Cell 区域候选 · 待核对'};
  const order=['baseline','junction','neighbor','special'];
  const shortReason={baseline:'同编号的精确表关系，作为核查基准',junction:'教程图示交点关联；OGP 命名待确认',neighbor:'相邻 cell，保留为待排查候选',special:'小 cell 区域，边界与交点归属待核对'};
  const groups=order.map(tier=>{
    const candidates=result.candidates.filter(c=>c.tier===tier);
    if(!candidates.length)return '';
    return '<section class="ogp-tier"><h3>'+labels[tier]+'</h3><div class="ogp-candidate-list">'+candidates.map(c=>'<button type="button" class="ogp-candidate '+(ui.ogpCandidate===c.target?'active':'')+'" data-act="ogp-candidate" data-target="'+e(c.target)+'" aria-pressed="'+(ui.ogpCandidate===c.target)+'" aria-label="选择候选 '+e(c.target)+'"><span class="ogp-candidate-heading"><b class="mono">'+e(c.target)+'</b><span>'+(ui.ogpCandidate===c.target?'已选，待现场核对':'选择')+icon(ui.ogpCandidate===c.target?'check':'chevron')+'</span></span><span class="ogp-wires mono">'+(c.wires.length?c.wires.map(w=>'W'+e(w)).join(' · '):'暂无确认 wire 映射')+'</span><small title="'+e(c.reason)+'">'+e(shortReason[c.tier])+'</small></button>').join('')+'</div></section>';
  }).join('');
  const chosen=result.candidates.find(c=>c.target===ui.ogpCandidate);
  return '<section class="card ogp-card"><div class="card-head"><div><h2>OGP <span class="mono">'+e(result.input)+'</span> 的候选</h2><p>原编号保留 · 实际位置待确认</p></div><span class="badge amber">'+result.candidates.length+' 个候选</span></div><div class="ogp-intro"><p><b>待核对候选，顺序不代表实际概率。</b>同编号作基准，图示交点随后，其余相邻候选保留。同级按编号排列。</p><details><summary>候选范围与排序依据</summary><p>'+e(result.assumption)+'</p><p>同编号先列作核查基准，不表示它更可能。没有已确认的 OGP 命名规则或统计样本，目前无法给出可信的概率排名。</p><p>图示交点依据教程第 18 页蓝色孔位；未画出蓝色叶片的相邻 cell 仍保留。OGP 的实际命名规则尚未确认，此列表不是已确认的 OGP 映射。</p><p>小 cell 的精确边界无法从标签位置确定，按相邻区域扩展并标注。若 OGP 使用其他编号体系或跨区域命名，需要对应点位表。</p></details></div>'+(result.warnings?.length?'<div class="ogp-special-note">'+result.warnings.map(e).join('<br>')+'</div>':'')+groups+'<div class="ogp-record-action"><p>'+(chosen?'已选择 <b class="mono">'+e(chosen.target)+'</b>。请核对 OGP 图片和实际位置后记录。':'点击一个候选查看图上位置，现场确认后再记录异常。')+'</p><button type="button" class="button primary wide" data-act="new-record" '+(!chosen?'disabled':'')+'>'+icon('plus')+(chosen?'确认 '+e(chosen.target)+' 并记录':'先选择实际位置候选')+'</button><button type="button" class="button wide ogp-map-link" data-act="ogp-map">'+icon('map')+'查看候选位置图</button></div></section>';
}
function lookupPage() {
  const cov = coverage(entries), back = ui.side==='back';
  const query = back
    ? '<div class="query-card back-query-card"><div class="back-query-title"><b>点选背面 cell 位置</b><span>H / G / L / K / J / I</span></div>'+sideToggle()+'</div>'
    : '<form class="query-card" id="query-form"><div class="segmented" aria-label="查找方式"><button type="button" data-act="query-mode" data-mode="cell" class="'+(ui.mode==='cell'?'active':'')+'">Cell → Wire</button><button type="button" data-act="query-mode" data-mode="wire" class="'+(ui.mode==='wire'?'active':'')+'">Wire → Cell</button></div><div class="search-box">'+icon('search')+'<input id="query-input" name="query" aria-label="'+(ui.mode==='cell'?(ui.cellSource==='ogp'?'OGP Cell 编号或位点':'实际 Cell 或位点编号'):'Wire 编号')+'" autocomplete="off" autocapitalize="characters" inputmode="'+(ui.mode==='wire'?'numeric':'text')+'" value="'+e(ui.query)+'" placeholder="'+(ui.mode==='cell'?(ui.cellSource==='ogp'?'输入 OGP 编号，如 73':'输入实际编号，如 19、C19、A'):'输入 wire 编号，如 403')+'"><span class="key-hint">↵</span></div><div class="query-end"><button class="button primary query-submit" type="submit">查找</button>'+sideToggle()+'</div></form>';
  return '<div class="page-title"><div><div class="eyebrow upper">PRECISION IN EVERY CONNECTION</div><h1>'+(back?'背面定位':'编号对照')+'</h1><p>'+(back?'按六个 cell 位置记录 bonding 异常。':'OGP 编号查候选，实际 Cell / Wire 精确对照。')+'</p></div><span class="badge title-action">'+(back?'6 个位置 · 每组 5 根':cov.signalCells===198&&cov.signalWires===594?'完整信号映射 · 198/198':'部分映射 · '+cov.signalCells+'/198')+'</span></div>'+
    mobileUsageStrip()+(back?'':mappingConflictNotice())+'<div class="lookup-grid '+(back?'backside-layout':'')+'">'+query+cellSourceBar()+'<div class="map-column">'+mapCard()+'<div class="reference-line">'+icon('info')+(back?'位置依据：你提供的背面图。':'图示来自教程第 18 页；位置仅用于点选，不是机台 XY。')+'</div></div><aside class="detail-column stack">'+selectedCard()+(currentOgpResult()&&!ui.ogpCandidate?'':groundingNote())+'<section class="card summary-card"><div class="card-head"><h2>当前模块概览</h2><span class="muted small">'+(activeModule()?'本机':'尚未选择')+'</span></div><div class="mini-stat-row"><div><strong>'+moduleRecords().filter(r=>r.status==='open'||r.status==='repaired').length+'</strong><span>待处理 / 待复检</span></div><div><strong>'+moduleRecords().length+'</strong><span>异常记录</span></div></div></section><section class="card recent-card"><div class="card-head"><h2>最近记录</h2><button class="text-button" data-act="nav" data-view="records">查看全部 '+icon('chevron')+'</button></div>'+recentRecords()+'</section></aside></div>';
}
function mapCard() {
  const cov = coverage(entries);
  let body;
  if(ui.side === 'back') {
    const flagged=moduleRecords().filter(r=>r.side==='back').map(r=>r.target);
    return '<section class="card map-card backside-card"><div class="card-head"><div><h2>背面六个 cell 位置</h2><p>LD V3 · BACKSIDE</p></div><span class="badge">点选位置</span></div>'+renderBacksideMap({target:ui.target,machineView:ui.backMachine,flagged})+'</section>';
  } else {
    const flagged = new Set(moduleRecords().filter(r=>r.side==='front').map(r=>r.target));
    const ogp=currentOgpResult(), possible=new Set(ogp?.candidates.map(c=>c.target)||[]);
    const special = new Set([13,14,61,62,69,70,142,143,153,154,162,163]);
    const circles = CELL_POSITIONS.map(p => { const target='C'+p.cell; return '<circle class="cell-hit '+(flagged.has(target)?'flagged ':'')+(ogp?(target===ui.ogpCandidate?'selected ':target===ogp.input?'ogp-origin ':possible.has(target)?'ogp-possible ':''):(target===ui.target?'selected':''))+'" cx="'+p.x+'" cy="'+p.y+'" r="'+(special.has(p.cell)?9:24)+'" role="button" tabindex="0" aria-label="选择 Cell '+p.cell+'" data-act="target" data-target="'+target+'"><title>Cell '+p.cell+'</title></circle>'; }).join('') + GROUP_POSITIONS.map(p=>'<circle class="cell-hit '+(flagged.has(p.target)?'flagged ':'')+(p.target===ui.target?'selected':'')+'" cx="'+p.x+'" cy="'+p.y+'" r="15" role="button" tabindex="0" aria-label="选择位点 '+p.target+'" data-act="target" data-target="'+p.target+'"><title>位点 '+p.target+'</title></circle>').join('');
    body = '<div class="map-wrap"><div class="map-scroll" id="map-scroll"><svg class="cell-map" id="cell-map" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 '+MAP_IMAGE.width+' '+MAP_IMAGE.height+'" style="width:'+ui.zoom*100+'%" role="group" aria-label="可点选的 198 个 cell 正面示意图"><g transform="'+(ui.rotated?'rotate(180 602 536.5)':'')+'"><image href="'+MAP_IMAGE.src+'" width="'+MAP_IMAGE.width+'" height="'+MAP_IMAGE.height+'"/>'+circles+'</g></svg></div></div><div class="map-legend"><div class="legend-items"><span><i class="legend-dot sel"></i>当前选择</span>'+(ogp?'<span><i class="legend-dot origin"></i>OGP 原编号</span><span><i class="legend-dot possible"></i>候选</span>':'')+'<span><i class="legend-dot warn"></i>有异常记录</span><span><i class="legend-dot"></i>未选中</span></div><span>'+ (ui.rotated?'视图已旋转 180°':'教程正面视角')+'</span></div><p class="map-foot">浅色不代表已检验合格。点图上的 cell 将切换到实际 Cell 精确查询；相邻小 cell 可放大选择。</p>';
  }
  return '<section class="card map-card"><div class="card-head"><div><h2>模块定位 <span class="muted">/ '+sideName(ui.side)+'</span></h2><p>LD V3 · FULL MODULE</p></div>'+(ui.side==='front'?'<div class="map-toolbar"><button class="icon-button" data-act="zoom-out" aria-label="缩小">'+icon('minus')+'</button><span class="zoom-label">'+Math.round(ui.zoom*100)+'%</span><button class="icon-button" data-act="zoom-in" aria-label="放大">'+icon('plus')+'</button><button class="icon-button" data-act="zoom-reset" aria-label="还原视图">'+icon('reset')+'</button><button class="icon-button" data-act="rotate" aria-label="旋转视图 180 度">'+icon('rotate')+'</button></div>':'')+'</div>'+body+'<div class="card-head" style="border-bottom:0;border-top:1px solid var(--line);padding-top:13px;padding-bottom:13px"><div class="coverage-row"><span>信号映射 <b class="mono">'+cov.signalCells+' / 198</b></span><span class="meter"><i style="width:'+(100*cov.signalCells/198)+'%"></i></span><span>附加位点 <b class="mono">'+cov.groups+' / 12</b></span></div><button class="text-button" data-act="nav" data-view="mapping">管理映射 '+icon('chevron')+'</button></div></section>';
}
function selectedCard() {
  const ogp=currentOgpResult();
  if(ogp)return ogpCandidatesCard(ogp);
  if(ui.side==='front'&&!ui.target&&!ui.wire){
    return '<section class="card lookup-empty"><div class="card-pad"><h2>输入'+(ui.mode==='wire'?' Wire 编号':ui.cellSource==='ogp'?' OGP Cell 编号':'实际 Cell 编号')+'开始查询</h2><p>不同来源分别查询，选择方式后请重新输入编号。</p></div></section>';
  }
  if(ui.side==='back') {
    const point=BACKSIDE_POSITIONS.find(p=>p.target===ui.target)||BACKSIDE_POSITIONS[0];
    return '<section class="card selected-card backside-selection"><div class="card-pad"><div class="selected-title"><span class="upper">SELECTED POSITION</span><div class="selection-heading"><span>CELL</span>'+e(point.target)+'</div><div class="kind-label">背面键合 · Backside</div></div><div class="back-position-section"><span class="back-location">'+(ui.backMachine?'机台朝向 · '+point.machineLocation:'参考图 · '+point.referenceLocation)+'</span><strong>5 <small>根 / 组</small></strong><span>打线顺序 '+(BACKSIDE_ORDER.indexOf(point.target)+1)+' / 6</span></div><button class="button lime wide action-record" data-act="new-record">'+icon('plus')+'记录此处异常'+icon('arrow')+'</button></div></section>';
  }
  const entry = ui.target ? lookupTarget(entries,ui.target,ui.side) : null;
  const isCell = /^C\d+$/.test(ui.target);
  const kind = entry?.kind || (ui.side==='back'?'back':isCell?'signal':/[A-F]/.test(ui.target)?'shield':'guard');
  const heading = ui.target ? (isCell?'<span>CELL</span>'+e(ui.target.slice(1)):'<span>位点</span>'+e(ui.target)):'<span>WIRE</span>'+e(ui.wire);
  return '<section class="card selected-card"><div class="card-pad"><div class="selected-title"><span class="upper">SELECTED POSITION</span><div class="selection-heading">'+heading+'</div><div class="kind-label">'+(ui.target?KINDS[kind]:'待确认对应 cell')+'<br>'+sideName(ui.side)+'</div></div><div class="divider"></div><div class="wire-section"><div class="wire-label"><span>对应 WIRE 编号</span><span>'+(entry?entry.wires.length+' 根':'待补映射')+'</span></div>'+(entry?'<div class="wire-chips">'+entry.wires.map(w=>'<button class="wire-chip '+(ui.wire && wireKey(ui.wire)===wireKey(w)?'active':'')+'" data-act="wire" data-wire="'+e(w)+'">W'+e(w)+'</button>').join('')+'</div><p class="source">'+e(entry.source)+'<br>'+e(entry.version)+'</p>':'<div class="unknown-mapping">尚无此位置的确认映射。<br>可先记录已知编号，待原始表核对。</div>')+referenceCoordinate(ui.side,ui.target)+'</div><button class="button lime wide action-record" data-act="new-record">'+icon('plus')+'记录此处异常'+icon('arrow')+'</button></div></section>';
}
function groundingNote() {
  if(ui.side!=='front'||!/^C\d+$/.test(ui.target)) return '';
  const n=Number(ui.target.slice(1));
  let note='';
  if(GROUNDING.avoid.includes(n)) note='教程第 13 页将此 cell 列为没有安全接地键合方案的位置，建议不要尝试接地。';
  else if(GROUNDING.span.includes(n)) note='教程第 13 页将此 cell 列为接地需跨越整个阶梯孔的位置。';
  else if(GROUNDING.nearby.includes(n)) note='教程第 13 页提示此 cell 附近有元件，接地时存在避让限制。';
  return note?'<div class="notice '+(GROUNDING.avoid.includes(n)?'danger':'')+'">'+icon('info')+'<div><b>教程中的接地提示</b><p>'+note+'具体模块 / 程序适用性须现场核对。</p></div></div>':'';
}
function recentRecords() {
  const rows=moduleRecords().slice().sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).slice(0,3);
  return rows.length?rows.map(r=>'<button class="record-mini" data-act="record-detail" data-id="'+e(r.id)+'"><i class="record-dot '+(r.status==='closed'?'closed':'')+'"></i><span><b>'+e(r.type)+'</b><small>'+date(r.createdAt)+' · '+sideName(r.side)+'</small></span><span class="spacer"></span><span class="mono">'+e(r.target || 'W'+r.wires[0])+'</span></button>').join(''):'<div class="empty-inline">'+(activeModule()?'当前模块还没有异常记录':'选择模块后，在这里查看最近记录')+'</div>';
}
function filteredRecords() {
  return state.records.filter(r=>(ui.scope==='all'||!state.activeModuleId||r.moduleId===state.activeModuleId) && (ui.filter==='all'?r.status!=='void':r.status===ui.filter) && (!ui.recordSearch || [r.moduleId,r.target,r.ogp?.reportedCell||'',r.type,r.note,r.operator,...r.wires.map(w=>'W'+w)].join(' ').toLowerCase().includes(ui.recordSearch.toLowerCase()))).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
}
function recordsPage() {
  const rows=state.records.filter(r=>(ui.scope==='all'||!state.activeModuleId||r.moduleId===state.activeModuleId)&&r.status!=='void');
  return '<div class="page-title"><div><div class="eyebrow upper">ISSUE LOG & TRACEABILITY</div><h1>异常记录</h1><p>从发现到复检，保留每一步处理。</p></div>'+button('new-record','新增记录','plus','primary title-action')+'</div><div class="stats-row">'+[['记录总数',rows.length,'log'],['待处理',rows.filter(r=>r.status==='open').length,'clock'],['待复检',rows.filter(r=>r.status==='repaired').length,'repair'],['已关闭',rows.filter(r=>r.status==='closed').length,'check']].map(([s,n,ic])=>'<div class="stat-box"><div><p>'+s+'</p><strong>'+n+'</strong></div><div class="stat-icon">'+icon(ic)+'</div></div>').join('')+'</div><section class="card"><div class="card-head"><div class="flex wrap"><h2>记录列表</h2><select id="record-scope" aria-label="模块范围" style="width:auto;min-height:31px;font-size:10px;padding:6px 9px"><option value="module" '+(ui.scope==='module'?'selected':'')+'>当前模块'+(!activeModule()?'（未选择，显示全部）':'')+'</option><option value="all" '+(ui.scope==='all'?'selected':'')+'>全部模块</option></select></div>'+button('export-csv','导出 CSV','download','small')+'</div><div class="filter-row"><div class="filter-chips">'+[['all','全部'],['open','待处理'],['repaired','待复检'],['closed','已关闭'],['void','已作废']].map(([s,t])=>'<button data-act="filter" data-filter="'+s+'" class="'+(ui.filter===s?'active':'')+'">'+t+'</button>').join('')+'</div><div class="filter-search">'+icon('search')+'<input id="record-search" aria-label="搜索异常记录" placeholder="搜索模块、cell、wire 或异常" value="'+e(ui.recordSearch)+'"></div></div><div id="record-list">'+recordsList()+'</div></section><div class="reference-line">'+icon('info')+'误录或测试记录：打开详情，将状态改为“已作废”。作废后不计入有效异常，原始内容保留且当前不可恢复。CSV 导出当前筛选结果；照片请用 JSON 备份。</div>';
}
function recordsList() {
  const rows=filteredRecords();
  if(!rows.length) return '<div class="empty-state"><div class="empty-icon">'+icon('log')+'</div><h3>'+(state.records.length?'没有符合条件的记录':'开始记录第一处异常')+'</h3><p>'+(state.records.length?'调整筛选条件，或选择其他模块。':'在正面查询 cell / wire，或点选背面位置，将异常、照片和处理状态关联到具体位置。')+'</p>'+button(state.records.length?'clear-filter':'new-record',state.records.length?'清除筛选':'新增异常记录','plus','primary')+'</div>';
  return '<table class="records-table"><thead><tr><th>位置 / MODULE</th><th>异常与线数</th><th>状态</th><th>发现时间</th><th>记录人</th><th></th></tr></thead><tbody>'+rows.map(r=>'<tr data-act="record-detail" data-id="'+e(r.id)+'" tabindex="0" role="button" aria-label="查看 '+e(r.target||r.wires.join(','))+' '+e(r.type)+'"><td><div class="record-target">'+e(r.target || '仅 Wire')+' <span class="small muted">'+e(r.wires.map(w=>'W'+w).join(' · '))+'</span></div><div class="secondary mono">'+e(r.moduleId)+' · '+sideName(r.side)+'</div>'+(r.ogp?'<div class="ogp-record-context">OGP '+e(r.ogp.reportedCell)+' → 现场确认 '+e(r.ogp.selectedCell)+'</div>':'')+'</td><td>'+e(r.type)+(r.photos.length?'<span class="photo-mark">'+icon('camera')+r.photos.length+'</span>':'')+'<div class="secondary">'+(r.actual!==null&&r.actual!==undefined?'实际 '+e(r.actual)+' 根':'未填写线数')+(r.expected!==null&&r.expected!==undefined?' / 计划 '+e(r.expected)+' 根':'')+' · '+e(r.phase)+'</div></td><td>'+badge(r.status)+'</td><td>'+date(r.createdAt)+'</td><td>'+e(r.operator)+'</td><td>'+icon('chevron')+'</td></tr>').join('')+'</tbody></table>';
}
function mappingPage() {
  const cov=coverage(entries);
  return '<div class="page-title"><div><div class="eyebrow upper">REFERENCE & DATA</div><h1>映射与资料</h1><p>编号有来源，记录可追溯。</p></div>'+button('import-mapping','导入映射','upload','primary title-action')+'</div>'+mappingConflictPanel()+'<div class="mapping-layout"><div class="stack"><section class="card"><div class="card-head"><h2>正面映射覆盖</h2><span class="badge">'+(cov.signalCells===198&&cov.signalWires===594?'完整信号映射':'部分映射')+'</span></div><div class="card-pad"><span class="upper muted">SIGNAL CELLS MAPPED</span><div class="big-coverage">'+cov.signalCells+' <span>/ 198</span></div><p class="small muted">已知 '+cov.signalWires+' 根信号线 · '+cov.groups+' 个附加位点</p><div class="progress-track"><i style="width:'+100*cov.signalCells/198+'%"></i></div><div class="divider"></div><div class="notice info">'+icon('check')+'<div>完整编号表已内置：198 个信号 cell、12 个附加位点，覆盖正面 <b>W1–630</b>。已核对无重复、无遗漏。<br>来源：LD_V3_Channels线编号_XY位置.pdf，第 1–2 页。</div></div><p class="small muted" style="margin-top:14px;line-height:1.8">'+(state.mappingMeta?'用户导入：'+e(state.mappingMeta.version)+'<br>'+e(state.mappingMeta.source)+' · '+date(state.mappingMeta.importedAt,true):'内置映射：'+e(REFERENCE_MAP_METADATA.version)+'<br>编号表与教程已知的 13 组关系一致。')+'</p><div class="settings-actions">'+button('import-mapping','导入 CSV / TSV','upload','small')+button('mapping-template','下载格式示例','download','small')+button('export-mapping','导出当前映射','download','small')+'</div></div></section><section class="card"><div class="card-head"><h2>屏蔽 / 保护环对应关系</h2><span class="muted small">编号表 p.2</span></div><table class="mapping-table"><thead><tr><th>类型</th><th>Cell / 位点</th><th>Wire 编号</th></tr></thead><tbody>'+BUILTIN_MAPPING.filter(r=>r.kind!=='signal').map(r=>'<tr><td>'+e(KINDS[r.kind].split(' · ')[0])+'</td><td class="mono">'+r.target+'</td><td class="mono">W'+r.wires[0]+'–'+r.wires.at(-1)+'</td></tr>').join('')+'</tbody></table></section><section class="card"><div class="card-head"><h2>编号与坐标说明</h2>'+icon('info')+'</div><div class="card-pad"><ul class="source-notes">'+[DOMAIN_NOTES[3],DOMAIN_NOTES[4],DOMAIN_NOTES[5],DOMAIN_NOTES[9],DOMAIN_NOTES[10],DOMAIN_NOTES[8]].map(n=>'<li>'+e(n)+'</li>').join('')+'</ul></div></section></div><div class="stack"><section class="card"><div class="card-head"><h2>记录与备份</h2>'+icon('shield')+'</div><div class="card-pad"><div class="info-list"><div class="info-item"><span class="info-num">01</span><div><h3>此设备保存</h3><p>当前 '+state.modules.length+' 个模块，'+state.records.length+' 条记录。数据保存在当前浏览器；更换手机或清除网站数据前，请导出备份。</p></div></div><div class="info-item"><span class="info-num">02</span><div><h3>完整 JSON 备份</h3><p>包含模块、映射、异常、照片及处理历史。恢复时补入新记录；同 ID 记录保留本机版本，不覆盖现有内容。</p></div></div><div class="info-item"><span class="info-num">03</span><div><h3>CSV 交接</h3><p>用于整理与人工核对。当前版本未连接现场数据库或 Greenlight 流程。</p></div></div></div><div class="settings-actions">'+button('backup','完整备份','download','primary small')+button('restore','恢复备份','upload','small')+'</div><div class="install-note"><b>免登录 · 安装到手机</b><br>Android 用 Chrome，iPhone 用 Safari 添加到主屏幕。模块、异常和照片保存在本机。<p data-mobile-status>'+mobileStatusLabel()+'</p><button type="button" class="button small" data-act="mobile-help" style="margin-top:10px">安装与使用说明</button></div></div></section><section class="card"><div class="card-head"><h2>使用流程</h2><span class="upper muted">QUICK START</span></div><div class="card-pad"><div class="info-list"><div class="info-item"><span class="info-num">01</span><div><h3>选择生产模块</h3><p>填写完整 Module ID、记录人和实际机台程序名，减少跨模块误记。</p></div></div><div class="info-item"><span class="info-num">02</span><div><h3>查编号、记录异常</h3><p>OGP 编号先查候选并现场确认；实际 Cell / Wire 仍精确对应。背面直接点选六个位置。</p></div></div><div class="info-item"><span class="info-num">03</span><div><h3>补充处理与复检</h3><p>误录可在详情中将状态改为“已作废”，作废后原始信息保留且当前不可恢复。处理状态可更新，异常与时间线保留。软件不自动判断模块合格或允许流转。</p></div></div></div></div></section><section class="card"><div class="card-head"><h2>适用范围</h2><span class="badge">LD V3 / Full</span></div><div class="card-pad"><p class="small muted" style="line-height:1.9">这一版按你提供教程中的完整 LD 模块制作。HD、partial module 或其他程序版本需要独立映射模板。图上 198 个 cell 包含单独标注的小 cell。</p><p class="small muted" style="margin-top:12px;line-height:1.9">现场验收标准、拉力阈值和接地操作以当前 SOP 为准；此处只记录观测数据和教程中已有的提示。</p></div></section></div></div>';
}

function openModal(title,subtitle,body,foot='',large=false) {
  modalEpoch++;
  returnFocus=document.activeElement;
  $('#app').inert=true; document.body.style.overflow='hidden';
  $('#overlay-root').innerHTML='<div class="modal-layer"><section class="modal '+(large?'large':'')+'" role="dialog" aria-modal="true" aria-labelledby="modal-title"><header class="modal-head"><div><h2 id="modal-title">'+title+'</h2><p>'+subtitle+'</p></div><button class="icon-button" data-act="close-modal" aria-label="关闭对话框">'+icon('close')+'</button></header><div class="modal-body">'+body+'<div id="form-error" class="form-error" role="alert"></div></div>'+(foot?'<footer class="modal-foot">'+foot+'</footer>':'')+'</section></div>';
  dirty=false; setTimeout(()=>$('.modal-head .icon-button')?.focus(),30);
}
function closeModal(force=false) {
  if(!force && (photoBusy || dirty) && !confirm(photoBusy?'照片正在处理，确定放弃吗？':'尚有未保存内容，确定放弃吗？')) return;
  $('#overlay-root').innerHTML=''; $('#app').inert=false; document.body.style.overflow='';
  modalEpoch++;modalKind='';dirty=false;photoBusy=false;pendingPhotos=[];stagedImport=null;stagedBackup=null;recordContext=null;
  if(returnFocus?.isConnected) returnFocus.focus();
}
function moduleModal(afterRecord=false) {
  modalKind=afterRecord?'module-record':'module';
  const list=state.modules.length?'<h3 class="modal-subtitle">切换已有模块</h3><div class="module-list">'+state.modules.slice().reverse().map(m=>'<button class="module-option '+(m.id===state.activeModuleId?'active':'')+'" data-act="select-module" data-id="'+e(m.id)+'"><span><strong>'+e(m.id)+'</strong><small>'+e(m.operator)+' · '+e(m.program||'未填程序')+'</small></span>'+icon(m.id===state.activeModuleId?'check':'chevron')+'</button>').join('')+'</div><div class="divider"></div>':'';
  openModal('选择生产模块',afterRecord?'先关联模块，再保存异常。':'按完整编号区分生产记录。',list+'<h3 class="modal-subtitle">新建模块</h3><form id="module-form"><div class="form-grid"><div class="field full"><label class="req" for="module-id">Module ID</label><input id="module-id" name="id" required maxlength="80" autocomplete="off" autocapitalize="characters" placeholder="输入完整模块编号"><span class="help">保留原始字符和前导零。</span></div><div class="field"><label class="req" for="module-operator">记录人</label><input id="module-operator" name="operator" required maxlength="60" value="'+e(activeModule()?.operator||'')+'" placeholder="姓名 / 姓名缩写"></div><div class="field"><label for="module-type">模块模板</label><input id="module-type" value="LD V3 · 完整模块" readonly></div><div class="field full"><label for="module-program">机台程序 / 版本（选填）</label><input id="module-program" name="program" maxlength="120" placeholder="按现场实际程序填写"></div></div></form>','<small>当前设备独立保存</small>'+button('close-modal','取消')+'<button class="button primary" type="submit" form="module-form">创建并使用 '+icon('arrow')+'</button>');
}
function recordModal() {
  const ogp=currentOgpResult();
  if(ogp&&!ogp.candidates.some(c=>c.target===ui.ogpCandidate)){
    ui.view='lookup';render();toast('OGP 编号有多个候选，请先选择并现场核对实际 cell。');return;
  }
  if(!activeModule()){moduleModal(true);return;}
  modalKind='record'; pendingPhotos=[];photoBusy=false;
  recordContext={module:structuredClone(activeModule()),side:ui.side,entries:structuredClone(entries),mappingMeta:structuredClone(state.mappingMeta),ogp:ogp?{reportedCell:ogp.input,selectedCell:ui.ogpCandidate,candidateTargets:ogp.candidates.map(c=>c.target),version:ogp.version,source:ogp.source,ranking:'review_order_not_probability'}:null};
  const back=recordContext.side==='back';
  const entry=!back&&ui.target?lookupTarget(entries,ui.target,ui.side):null;
  const locationFields=back
    ? '<div class="field full"><label class="req" for="issue-target">背面 cell 位置</label><select id="issue-target" name="target" required>'+BACKSIDE_ORDER.map((t,i)=>'<option value="'+t+'" '+(t===ui.target?'selected':'')+'>'+t+' · 参考图'+BACKSIDE_POSITIONS.find(p=>p.target===t).referenceLocation+' · 顺序 '+(i+1)+'</option>').join('')+'</select><span class="help">按位置记录异常，每组计划 5 根。</span></div>'
    : '<div class="field"><label for="issue-target">实际 Cell / 位点</label><input id="issue-target" name="target" value="'+e(ui.target)+'" '+(recordContext.ogp?'readonly':'')+' placeholder="如 C19、A" autocomplete="off"><span class="help">C1–C198；A–F / M–R</span></div><div class="field"><label for="issue-wires">受影响的 Wire（选填）</label><input id="issue-wires" name="wires" value="'+e(ui.wire)+'" placeholder="如 403,404" autocomplete="off" inputmode="text"><span class="help">多根用逗号分隔；留空表示位点整体。</span></div>';
  const ogpConfirmation=recordContext.ogp?'<div class="field full ogp-confirmation"><div class="notice">'+icon('info')+'<div>OGP 原始编号 <b class="mono">'+e(recordContext.ogp.reportedCell)+'</b> → 当前候选 <b class="mono">'+e(recordContext.ogp.selectedCell)+'</b><br>候选不是确定映射。请结合 OGP 照片与实际位置核对；这两个编号将分别保存在记录中。</div></div><label class="check-label"><input id="ogp-confirmed" type="checkbox" name="ogpConfirmed" required>我已现场确认实际 cell 为 '+e(recordContext.ogp.selectedCell)+'，不是仅凭 OGP 编号推定。</label></div>':'';
  openModal('记录 bonding 异常',e(activeModule().id)+' · '+sideName(ui.side),'<form id="record-form"><div class="form-grid">'+ogpConfirmation+locationFields+'<div class="field full"><div class="notice info" id="record-mapping-hint">'+icon('info')+'<span>'+(back?'记录归属所选背面位置，可填写实际线数、异常现象和照片。':'位置与 wire 会在保存时校验；未知对应会标记为人工填写、待核对。')+'</span></div></div><div class="field full"><span class="field-label req">异常类型 *</span><div class="choice-grid">'+TYPES.map((t,i)=>'<label><input type="radio" name="type" value="'+e(t)+'" '+(!i?'checked':'')+'>'+e(t)+'</label>').join('')+'</div></div><div class="field"><label for="issue-expected">计划线数（选填）</label><input id="issue-expected" name="expected" type="number" min="0" max="100" step="1" inputmode="numeric" value="'+(back?5:entry?entry.wires.length:'')+'" placeholder="按实际计划"></div><div class="field"><label for="issue-actual">实际线数（选填）</label><input id="issue-actual" name="actual" type="number" min="0" max="100" step="1" inputmode="numeric" placeholder="当前观测根数"></div><div class="field"><label for="issue-phase">发现阶段</label><select id="issue-phase" name="phase">'+selectOptions(PHASES,'绑定中')+'</select></div><div class="field"><label class="req" for="issue-operator">记录人</label><input id="issue-operator" name="operator" required maxlength="60" value="'+e(activeModule().operator)+'"></div><div class="field"><label for="issue-force">拉力 gf（选填）</label><input id="issue-force" name="force" type="number" min="0" max="10000" step="any" inputmode="decimal" placeholder="保留测量值"></div><div class="field"><label for="issue-endpoint">位置 / 端点（选填）</label><select id="issue-endpoint" name="endpoint">'+selectOptions(['未指定','First bond','Second bond','Heel','Wire span / loop','Sensor 端','PCB 端'],'未指定')+'</select></div><div class="field full"><label for="issue-note">现象与备注</label><textarea id="issue-note" name="note" maxlength="4000" placeholder="记录观测到的情况、机台报警信息，或已采取的处理…"></textarea></div><div class="field full"><span class="field-label">现场照片（最多 3 张）</span><label class="upload-button">'+icon('camera')+'拍照 / 选择照片<input id="issue-photos" type="file" accept="image/*" multiple capture="environment"></label><span class="help">照片随本机记录保存，完整备份会包含照片。</span><div class="photos-row" id="draft-photos"></div></div></div></form>','<small>初始状态：待处理</small>'+button('close-modal','取消')+'<button type="submit" form="record-form" id="save-record" class="button primary">'+icon('check')+'保存异常</button>',true);
}
function mappingSnapshot(target,wires,side,mappingEntries=entries,mappingMeta=state.mappingMeta) {
  if(side==='back') {
    if(!BACKSIDE_ORDER.includes(target))throw new Error('请选择背面 cell 位置。');
    return {status:'cell_only',version:'背面位置图 · H/G/L/K/J/I',source:'用户提供的背面位置图（image.png）',target,wires:[],expectedWires:[],sources:[]};
  }
  const byTarget=target?lookupTarget(mappingEntries,target,side):null;
  const related=[];
  for(const wire of wires) {
    const byWire=lookupWire(mappingEntries,wire,side);
    if(byWire && target && byWire.target!==target) throw new Error('W'+wire+' 的已知对应为 '+byWire.target+'，与填写的 '+target+' 不一致。');
    if(target && byTarget && !byTarget.wires.some(w=>wireKey(w)===wireKey(wire))) throw new Error('W'+wire+' 不在 '+target+' 的已确认 wire 列表中。');
    if(byWire) related.push(byWire);
  }
  const allKnown=!!byTarget && (!wires.length || wires.every(w=>byTarget.wires.some(k=>wireKey(w)===wireKey(k))));
  return {status:allKnown?'documented':target&&wires.length?'manual_unverified':target?'cell_only':'wire_only',version:byTarget?.version||mappingMeta?.version||REFERENCE_MAP_METADATA.version,source:byTarget?.source||'人工填写，映射待核对',target:target||null,wires:[...wires],expectedWires:byTarget?.wires.map(String)||[],sources:byTarget?.sources||related.map(r=>({source:r.source,version:r.version,wires:r.wires.map(String)}))};
}
function checkTarget(value,side) {
  if(!value.trim()) return '';
  const target=normalizeTarget(value);
  if(side==='back'&&!/^[G-L]$/.test(target)) throw new Error('背面位点仅支持 G–L。');
  if(side==='front'&&!(/^C(?:[1-9]|[1-9]\d|1\d\d)$/.test(target)&&Number(target.slice(1))<=198)&&!(/^[A-FM-R]$/.test(target))) throw new Error('正面位点应为 C1–C198、A–F 或 M–R。');
  return target;
}
function recordDetail(id) {
  const r=state.records.find(x=>x.id===id); if(!r)return;
  modalKind='detail';
  const data=[['模块',r.moduleId],['正 / 反面',sideName(r.side)],['记录人',r.operator],['发现阶段',r.phase],['计划 / 实际线数',(r.expected??'未填')+' / '+(r.actual??'未填')],['拉力 / 位置',(r.force===null||r.force===undefined?'未填':r.force+' gf')+' · '+r.endpoint],['机台程序',r.program||'未填'],[r.side==='back'?'记录方式':'映射状态',r.side==='back'?(r.wires.length?'历史记录（保留原始编号）':'按背面 cell 位置记录'):r.mapping.status==='documented'?'记录时有映射依据':'人工填写 / 待核对']];
  if(r.ogp)data.push(['OGP 原始编号',r.ogp.reportedCell],['现场确认实际 Cell',r.ogp.selectedCell],['当时的候选',r.ogp.candidateTargets.join('、')],['OGP 核查方式','候选按核查顺序，非概率排名；保存时人工确认']);
  openModal('异常详情',date(r.createdAt,true),'<div class="record-summary"><div><h3>'+e((r.side==='back'?'背面 ':'')+(r.target||'Wire'))+'</h3><span class="small muted mono">'+e(r.wires.map(w=>'W'+w).join(' · ')||(r.side==='back'?'位置整体':'位点整体'))+'</span></div>'+badge(r.status)+'</div>'+(historicalMappingMismatch(r)?'<div class="notice" style="margin-bottom:16px">'+icon('info')+'<div>这条历史记录的 wire 与当前完整编号表不一致。原始记录和当时映射已保留，请复核后补充处理说明。</div></div>':'')+'<h3 style="margin-bottom:16px">'+e(r.type)+'</h3><dl class="detail-grid">'+data.map(([k,v])=>'<div><dt>'+k+'</dt><dd>'+e(v)+'</dd></div>').join('')+'</dl>'+(r.note?'<div class="detail-note">'+e(r.note)+'</div>':'')+'<div class="detail-photos">'+r.photos.map((p,i)=>'<button style="border:0;background:none;padding:0;cursor:zoom-in" data-act="view-photo" data-id="'+e(r.id)+'" data-index="'+i+'" aria-label="查看照片 '+(i+1)+'"><img width="110" height="90" src="'+e(p.data)+'" alt="异常现场照片 '+(i+1)+'"></button>').join('')+'</div><div class="divider"></div><p class="small muted" style="font-size:10px;line-height:1.9">'+(r.side==='back'?'记录时位置依据：':'记录时映射：')+e(r.mapping.version)+'<br>来源：'+e(r.mapping.source)+'</p><div class="divider"></div><h3>处理时间线</h3><div class="timeline">'+r.history.map(h=>'<div class="timeline-item"><small>'+date(h.at,true)+' · '+e(h.operator)+' · '+e(STATUS[h.status])+'</small><p>'+e(h.note)+'</p></div>').join('')+'</div>'+(r.status==='void'?'<div class="notice">此记录已作废，保留原始信息供追溯。</div>':'<form id="update-form" data-id="'+e(r.id)+'"><div class="form-grid"><div class="field"><label for="update-status">更新状态</label><select id="update-status" name="status">'+Object.entries(STATUS).map(([k,v])=>'<option value="'+k+'" '+(k===r.status?'selected':'')+'>'+v+'</option>').join('')+'</select></div><div class="field"><label class="req" for="update-operator">处理 / 复检人</label><input id="update-operator" name="operator" required maxlength="60" value="'+e(activeModule()?.operator||r.operator)+'"></div><div class="field full"><label class="req" for="update-note">处理说明 / 复检结果</label><textarea id="update-note" name="note" maxlength="4000" required placeholder="补充采取的处理、复检结果或作废原因；原始记录会保留。"></textarea></div></div></form>'),button('close-modal','关闭')+(r.status==='void'?'':'<button type="submit" form="update-form" class="button primary">'+icon('check')+'保存处理记录</button>'),true);
}
function importModal() {
  modalKind='import';stagedImport=null;
  openModal('导入 cell / wire 映射','仅导入 LD V3 完整模块的正面编号映射。','<form id="mapping-form"><div class="form-grid"><div class="field full"><label class="req" for="mapping-version">映射版本 / 程序标识</label><input id="mapping-version" name="version" maxlength="100" required placeholder="填写原始映射文件或机台程序的版本"></div><div class="field full"><label for="mapping-file">选择文件</label><input id="mapping-file" type="file" accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values,text/plain"><span class="help">UTF-8 CSV / TSV，支持一根 wire 一行，或起止编号。XLSX 请先另存为 CSV。</span></div><div class="field full"><label class="req" for="mapping-text">映射内容</label><textarea id="mapping-text" name="text" required style="min-height:140px;font:12px/1.8 monospace" placeholder="cell,wire&#10;19,403&#10;19,404&#10;19,405"></textarea></div></div><p class="small muted" style="margin-top:13px;font-size:10px;line-height:1.9">可选列：side（front）、kind（signal/shield/guard）。正面位点为 C1–C198、A–F、M–R。范围格式：cell,wire_start,wire_end。背面直接按位置记录。</p></form><div id="mapping-preview"></div>','<small>先校验，再确认导入</small>'+button('mapping-template','格式示例','download','small')+'<button class="button primary" type="submit" form="mapping-form">校验并预览 '+icon('arrow')+'</button>',true);
}
function restoreModal() {
  modalKind='restore';stagedBackup=null;
  openModal('恢复完整备份','合并新模块和新记录，保留现有记录。','<div class="notice info">'+icon('info')+'<div>同 ID 的记录不会覆盖，即使备份中的版本较新也会跳过。已有用户映射时保留当前映射。JSON 备份包括照片。</div></div><div class="field" style="margin-top:18px"><label for="backup-file">选择 Bonding 工作台 JSON 备份</label><input id="backup-file" type="file" accept=".json,application/json"></div><div id="backup-preview"></div>',button('close-modal','取消')+'<button class="button primary" data-act="restore-confirm" id="restore-confirm" disabled>合并恢复</button>');
}
function download(name,content,type) {
  const blob=new Blob([content],{type}),url=URL.createObjectURL(blob),a=document.createElement('a');
  a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);
}
function stamp(){return new Date().toISOString().slice(0,19).replace(/[:T]/g,'-');}
function exportCsv() {
  const headers=['record_id','module_id','module_type','program','side','cell_or_group','wires','anomaly','expected_wires','actual_wires','stage','pull_gf','endpoint','status','operator','created_at','updated_at','note','photo_count','mapping_status','mapping_version','mapping_source','mapping_snapshot','history','ogp_reported_cell','ogp_confirmed_cell','ogp_candidates','ogp_snapshot'];
  const rows=filteredRecords().map(r=>[r.id,r.moduleId,r.moduleType,r.program,r.side,r.target,r.wires.map(w=>'W'+w).join(';'),r.type,r.expected??'',r.actual??'',r.phase,r.force??'',r.endpoint,STATUS[r.status],r.operator,r.createdAt,r.updatedAt,r.note,r.photos.length,r.mapping.status,r.mapping.version,r.mapping.source,JSON.stringify(r.mapping),JSON.stringify(r.history),r.ogp?.reportedCell||'',r.ogp?.selectedCell||'',r.ogp?.candidateTargets.join(';')||'',r.ogp?JSON.stringify(r.ogp):'']);
  download('bonding-records-'+stamp()+'.csv','\uFEFF'+csvEncode(headers,rows),'text/csv;charset=utf-8');
  toast('已导出 '+rows.length+' 条筛选记录；照片请使用完整备份。');
}
async function photoData(file) {
  if(!file.type.startsWith('image/'))throw new Error('请选择图片文件。');
  if(file.size>20*1024*1024)throw new Error('单张照片请小于 20 MB。');
  const url=URL.createObjectURL(file);
  try{
    const image=new Image();await new Promise((res,rej)=>{image.onload=res;image.onerror=()=>rej(new Error('照片无法读取，请使用 JPEG、PNG 或 WebP。'));image.src=url;});
    const scale=Math.min(1,1600/Math.max(image.naturalWidth,image.naturalHeight)),canvas=document.createElement('canvas');
    canvas.width=Math.round(image.naturalWidth*scale);canvas.height=Math.round(image.naturalHeight*scale);
    const context=canvas.getContext('2d');context.fillStyle='white';context.fillRect(0,0,canvas.width,canvas.height);context.drawImage(image,0,0,canvas.width,canvas.height);
    return {name:file.name,data:canvas.toDataURL('image/jpeg',.86)};
  }finally{URL.revokeObjectURL(url);}
}
function drawDraftPhotos(){const box=$('#draft-photos');if(box)box.innerHTML=pendingPhotos.map((p,i)=>'<div class="photo-thumb"><img src="'+p.data+'" alt="待保存照片 '+(i+1)+'"><button type="button" data-act="remove-photo" data-index="'+i+'" aria-label="移除照片 '+(i+1)+'">×</button></div>').join('');}
function selectTarget(target){
  ui.target=checkTarget(target,ui.side);ui.wire='';ui.query=target;
  if(ui.side==='front'){ui.mode='cell';ui.cellSource='exact';ui.ogpInput='';ui.ogpCandidate='';}
  render();
}
function search(value) {
  if(ui.side==='back')return;
  const v=value.trim();if(!v){toast('请输入需要查找的编号。');return;}
  if(ui.mode==='wire'){
    const wire=normalizeWire(v), entry=lookupWire(entries,wire,ui.side);
    ui.wire=wire;ui.target=entry?.target||'';ui.ogpInput='';ui.ogpCandidate='';
    if(!entry)toast('暂无 W'+wire+' 的确认映射，可记录原始 wire 编号。');
  }else{
    ui.target=checkTarget(v,ui.side);ui.wire='';ui.ogpCandidate='';
    ui.ogpInput=ui.cellSource==='ogp'&&/^C\d+$/.test(ui.target)?ui.target:'';
  }
  ui.query=v;render();
}
async function onAction(el) {
  const a=el.dataset.act;
  if(a==='nav'){ui.view=el.dataset.view;render();window.scrollTo({top:0});}
  if(a==='module')moduleModal();
  if(a==='mobile-help')mobileHelpModal();
  if(a==='mobile-install'){const outcome=await promptMobileInstall();refreshMobileStatus();toast(outcome==='accepted'?'已接受安装，请从桌面 Bonding 图标打开。':outcome==='dismissed'?'已取消安装，仍可在浏览器中使用。':'请按说明通过浏览器菜单添加到主屏幕。');}
  if(a==='close-modal')closeModal();
  if(a==='query-mode'&&ui.side==='front'){
    ui.mode=el.dataset.mode;ui.query='';ui.wire='';ui.target='';ui.ogpCandidate='';ui.ogpInput='';
    render();$('#query-input')?.focus();
  }
  if(a==='cell-source'&&ui.side==='front'){
    const original=ui.ogpInput||ui.target;
    ui.cellSource=el.dataset.source;ui.mode='cell';ui.wire='';ui.ogpCandidate='';
    ui.ogpInput=ui.cellSource==='ogp'&&/^C\d+$/.test(original)?original:'';
    if(original){ui.target=original;ui.query=original;}
    render();
  }
  if(a==='ogp-candidate'){
    const result=currentOgpResult(), candidate=result?.candidates.find(c=>c.target===el.dataset.target);
    if(!candidate)return;
    ui.ogpCandidate=candidate.target;ui.target=candidate.target;ui.wire='';render();
  }
  if(a==='ogp-map')$('.map-column')?.scrollIntoView({block:'start',behavior:'smooth'});
  if(a==='side'){
    ui.side=el.dataset.side;ui.mode='cell';ui.target=ui.side==='front'?'C19':'H';ui.wire='';ui.query=ui.side==='front'?'19':'';ui.zoom=1;ui.rotated=false;ui.ogpCandidate='';
    ui.ogpInput=ui.side==='front'&&ui.cellSource==='ogp'?'C19':'';render();
  }
  if(a==='target'){
    selectTarget(el.dataset.target);
    if(ui.side==='back'&&window.matchMedia('(max-width:760px)').matches) $('.backside-selection')?.scrollIntoView({block:'nearest',behavior:'smooth'});
  }
  if(a==='back-orientation'){ui.backMachine=el.dataset.view==='machine';render();}
  if(a==='wire'&&ui.side==='front'){ui.wire=ui.wire&&wireKey(ui.wire)===wireKey(el.dataset.wire)?'':el.dataset.wire;render();}
  if(a==='zoom-in'||a==='zoom-out'||a==='zoom-reset'){
    ui.zoom=a==='zoom-reset'?1:Math.max(1,Math.min(3,ui.zoom+(a==='zoom-in'?.5:-.5)));
    if(a==='zoom-reset')ui.rotated=false;
    render();
  }
  if(a==='rotate'){ui.rotated=!ui.rotated;render();}
  if(a==='new-record')recordModal();
  if(a==='select-module'){
    const after=modalKind==='module-record';
    await commit(s=>({...s,activeModuleId:el.dataset.id}));
    closeModal(true);toast('已切换模块 '+el.dataset.id);if(after)recordModal();
  }
  if(a==='record-detail')recordDetail(el.dataset.id);
  if(a==='filter'){ui.filter=el.dataset.filter;render();}
  if(a==='clear-filter'){ui.filter='all';ui.recordSearch='';ui.scope='all';render();}
  if(a==='export-csv')exportCsv();
  if(a==='backup'){download('bonding-backup-'+stamp()+'.json',JSON.stringify(makeBackup(state)), 'application/json');toast('已导出完整备份，包含照片与处理历史。');}
  if(a==='restore')restoreModal();
  if(a==='restore-confirm'){
    if(!stagedBackup)return;
    const incoming=stagedBackup;let result;
    await commit(s=>{result=mergeBackup(s,incoming);resolveStoredMappings(BUILTIN_MAPPING,result.state.importedMapping);return result.state;});
    closeModal(true);toast('已补入 '+result.added+' 条记录，跳过 '+result.skipped+' 条已有记录。');
  }
  if(a==='import-mapping')importModal();
  if(a==='mapping-template')download('bonding-mapping-example.csv','\uFEFF'+csvEncode(['side','kind','cell','wire_start','wire_end'],[['front','signal','19','403','405'],['front','shield','A','628','630']]),'text/csv;charset=utf-8');
  if(a==='export-mapping'){
    download('bonding-mapping-'+stamp()+'.csv','\uFEFF'+csvEncode(['side','kind','cell','wire','source','version'],entries.flatMap(r=>r.wires.map(w=>[r.side,r.kind,r.target,w,r.source,r.version]))),'text/csv;charset=utf-8');toast('已导出当前映射及来源。');
  }
  if(a==='export-stored-mapping'){
    const rows=state.importedMapping.flatMap(r=>{
      const conflict=mappingConflicts.find(c=>c.entry.side===r.side&&c.entry.target===r.target);
      return r.wires.map(w=>[r.side,r.kind,r.target,w,r.source,r.version,r.side==='back'?'历史保留':conflict?'未启用':'已启用',r.side==='back'?'背面按位置记录，不启用 wire 映射':conflict?.reason||'']);
    });
    download('bonding-original-user-mapping-'+stamp()+'.csv','\uFEFF'+csvEncode(['side','kind','cell','wire','source','version','runtime_status','conflict_reason'],rows),'text/csv;charset=utf-8');
    toast('已导出保留的原始用户映射，包含暂停启用的条目。');
  }
  if(a==='confirm-mapping'){
    if(!stagedImport||!$('#mapping-confirmed')?.checked){error('请确认映射适用于当前 LD V3 模板。');return;}
    const incoming=stagedImport;
    await commit(s=>({...s,importedMapping:incoming.entries,mappingMeta:{version:incoming.version,source:incoming.source,importedAt:new Date().toISOString()}}));
    closeModal(true);toast('映射已导入，已有异常记录保留原映射快照。');
  }
  if(a==='remove-photo'){pendingPhotos.splice(Number(el.dataset.index),1);dirty=true;drawDraftPhotos();}
  if(a==='view-photo'){
    const r=state.records.find(x=>x.id===el.dataset.id),p=r?.photos[Number(el.dataset.index)];if(!p)return;
    if(dirty&&!confirm('处理说明还未保存，先放弃编辑并查看照片？'))return;
    modalKind='photo';openModal('现场照片',e(r.target||r.wires.join(', ')),'<img class="photo-view" src="'+e(p.data)+'" alt="异常现场照片">', '<button class="button primary" data-act="record-detail" data-id="'+e(r.id)+'">返回异常详情</button>');
  }
}
document.addEventListener('click',event=>{const el=event.target.closest('[data-act]');if(!el||el.disabled)return;onAction(el).catch(ex=>error(ex.message||'操作未完成，请重试。'));});
document.addEventListener('keydown',event=>{
  if(event.key==='Escape'&&modalKind){event.preventDefault();closeModal();return;}
  const el=event.target.closest('[role="button"][data-act]');
  if(el&&(event.key==='Enter'||event.key===' ')){event.preventDefault();onAction(el).catch(ex=>error(ex.message));}
  if(event.key==='Tab'&&modalKind){
    const nodes=$$('button:not([disabled]),a[href],input:not([disabled]):not([type="hidden"]),select,textarea,[tabindex="0"]',$('.modal')).filter(n=>n.getClientRects().length);
    if(!nodes.length)return;
    const first=nodes[0],last=nodes.at(-1);
    if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}
    else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}
  }
});
document.addEventListener('input',event=>{
  if(event.target.closest('.modal'))dirty=true;
  if(event.target.id==='query-input')ui.query=event.target.value;
  if(event.target.id==='record-search'){ui.recordSearch=event.target.value;$('#record-list').innerHTML=recordsList();}
  if(['mapping-text','mapping-version'].includes(event.target.id)){stagedImport=null;$('#mapping-preview').innerHTML='';}
});
document.addEventListener('change',async event=>{
  const epoch=modalEpoch;
  try{
    if(event.target.id==='record-scope'){ui.scope=event.target.value;render();}
    if(event.target.id==='mapping-file'){
      const file=event.target.files[0];if(!file)return;if(file.size>2*1024*1024)throw new Error('映射文件请小于 2 MB。');
      $('#mapping-text').value=await file.text();$('#mapping-text').dataset.filename=file.name;stagedImport=null;$('#mapping-preview').innerHTML='';dirty=true;
    }
    if(event.target.id==='backup-file'){
      const file=event.target.files[0];if(!file)return;if(file.size>100*1024*1024)throw new Error('备份超过 100 MB，暂不支持在此导入。');
      stagedBackup=readBackup(await file.text());
      const result=mergeBackup(state,stagedBackup);
      const backupMapping=resolveStoredMappings(BUILTIN_MAPPING,result.state.importedMapping);
      $('#backup-preview').innerHTML='<div class="notice info" style="margin-top:18px">'+icon('check')+'<div>文件校验通过：'+stagedBackup.modules.length+' 个模块，'+stagedBackup.records.length+' 条记录。<br>将补入 '+result.added+' 条；'+result.skipped+' 条同 ID 记录将跳过。'+(backupMapping.conflicts.length?'<br>另有 '+backupMapping.conflicts.length+' 个旧映射位点与当前参考表冲突；会保留原始数据，但暂停用于查号。':'')+'</div></div>';
      $('#restore-confirm').disabled=false;
    }
    if(event.target.id==='issue-photos'){
      const files=[...event.target.files];if(files.length+pendingPhotos.length>3)throw new Error('每条异常最多保存 3 张照片。');
      photoBusy=true;event.target.disabled=true;$('#save-record').disabled=true;toast('正在处理照片…');
      const photos=[];for(const f of files)photos.push(await photoData(f));
      if(modalKind==='record'&&epoch===modalEpoch){pendingPhotos.push(...photos);dirty=true;drawDraftPhotos();toast('照片已加入，保存异常后留存在本机。');}
    }
  }catch(ex){if(event.target.id==='backup-file'){stagedBackup=null;$('#restore-confirm').disabled=true;}error(ex.message);}
  finally{if(event.target.id==='issue-photos'&&epoch===modalEpoch){photoBusy=false;if($('#save-record'))$('#save-record').disabled=false;event.target.value='';event.target.disabled=false;}}
});
document.addEventListener('submit',async event=>{
  event.preventDefault();const form=event.target,formId=form.getAttribute('id');
  if(form.dataset.saving==='true')return;
  form.dataset.saving='true';
  const fd=new FormData(form),val=n=>String(fd.get(n)??'').trim();
  const submit=$('[type="submit"][form="'+formId+'"]')||$('button[type="submit"]',form);if(submit)submit.disabled=true;
  if($('#form-error'))$('#form-error').textContent='';
  try{
    if(formId==='query-form')search(val('query'));
    if(formId==='module-form'){
      const id=val('id'),operator=val('operator'),program=val('program'),after=modalKind==='module-record';
      if(!id||!operator)throw new Error('请填写模块编号和记录人。');
      await commit(s=>{
        if(s.modules.some(m=>m.id===id))throw new Error('该模块已存在，请在上方列表中选择。');
        return {...s,modules:[...s.modules,{id,operator,program,type:'LD V3 Full',createdAt:new Date().toISOString()}],activeModuleId:id};
      });
      closeModal(true);toast('模块已创建：'+id);if(after)recordModal();
    }
    if(formId==='record-form'){
      if(photoBusy)throw new Error('照片仍在处理中，请稍候。');
      if(!recordContext)throw new Error('记录上下文已关闭，请重新打开记录表单。');
      const context=recordContext;
      const target=checkTarget(val('target'),context.side),wires=context.side==='back'?[]:val('wires')?val('wires').split(/[,，;；\s]+/).filter(Boolean).map(normalizeWire):[];
      if(context.side==='back'&&!target)throw new Error('请选择背面 cell 位置。');
      if(!target&&!wires.length)throw new Error('请至少填写 cell / 位点或 wire 编号。');
      if(wires.length>30)throw new Error('单条记录最多关联 30 根 wire。');
      if(new Set(wires.map(wireKey)).size!==wires.length)throw new Error('Wire 编号有重复，请核对。');
      const number=n=>val(n)===''?null:Number(val(n));
      const expected=number('expected'),actual=number('actual'),force=number('force'),operator=val('operator');
      if(!operator)throw new Error('请填写记录人。');
      if([expected,actual].some(n=>n!==null&&(!Number.isInteger(n)||n<0||n>100)))throw new Error('线数必须是 0–100 的整数。');
      if(force!==null&&(!Number.isFinite(force)||force<0||force>10000))throw new Error('请填写有效的拉力数值。');
      const now=new Date().toISOString(),mod=context.module;
      if(context.ogp&&(!form.elements.ogpConfirmed?.checked||target!==context.ogp.selectedCell))throw new Error('请先现场确认所选实际 cell；需要换位置时，请返回重新选择候选。');
      const snapshot=mappingSnapshot(target,wires,context.side,context.entries,context.mappingMeta);
      const record={id:uniqueId(),moduleId:mod.id,moduleType:mod.type,program:mod.program,side:context.side,target,wires,type:val('type'),expected,actual,phase:val('phase'),force,endpoint:val('endpoint'),operator,note:val('note'),photos:[...pendingPhotos],status:'open',createdAt:now,updatedAt:now,mapping:snapshot,...(context.ogp?{ogp:{...structuredClone(context.ogp),confirmedAt:now}}:{}),history:[{at:now,operator,status:'open',note:'创建异常记录'}]};
      await commit(s=>{if(!s.modules.some(m=>m.id===mod.id))throw new Error('原模块不存在，请重新选择模块。');return {...s,records:[...s.records,record]};});
      closeModal(true);toast('异常已保存在此设备。');
    }
    if(formId==='update-form'){
      const id=form.dataset.id,status=val('status'),note=val('note'),operator=val('operator');
      if(!note||!operator)throw new Error('请填写处理人及处理说明。');
      if(!Object.hasOwn(STATUS,status))throw new Error('处理状态无效。');
      await commit(s=>({...s,records:s.records.map(r=>{if(r.id!==id)return r;if(r.status==='void')throw new Error('记录已作废，请刷新详情。');const now=new Date().toISOString();return {...r,status,updatedAt:now,history:[...r.history,{at:now,operator,status,note}]};})}));
      closeModal(true);toast('处理记录已保存，原始异常信息已保留。');recordDetail(id);
    }
    if(formId==='mapping-form'){
      const version=val('version'),source=$('#mapping-text').dataset.filename||'手动粘贴 CSV';
      if(!version)throw new Error('请填写映射版本。');
      const parsed=parseMapping(val('text'),{version,source});
      if(parsed.entries.some(entry=>entry.side==='back'))throw new Error('背面按位置记录，无需导入 wire 编号。请只保留正面映射。');
      validateAgainstBuiltin(parsed.entries,BUILTIN_MAPPING);
      const merged=getMappings(BUILTIN_MAPPING,parsed.entries),cov=coverage(merged);
      stagedImport={entries:parsed.entries,source,version};
      $('#mapping-preview').innerHTML='<div class="notice info" style="margin-top:17px">'+icon('check')+'<div>校验通过：'+parsed.stats.entries+' 个位点、'+parsed.stats.wires+' 根 wire。<br>合并后信号映射覆盖 '+cov.signalCells+' / 198 cells。</div></div><div class="import-preview"><table class="mapping-table"><thead><tr><th>面</th><th>位点</th><th>Wire</th></tr></thead><tbody>'+parsed.entries.slice(0,10).map(r=>'<tr><td>'+sideName(r.side)+'</td><td class="mono">'+e(r.target)+'</td><td class="mono">'+e(r.wires.map(w=>'W'+w).join(', '))+'</td></tr>').join('')+'</tbody></table></div><label class="check-label"><input type="checkbox" id="mapping-confirmed">我已核对：这份映射适用于当前 LD V3 完整模块及实际程序。本次导入会替换此前的用户映射，保留教程明确的关系；已有异常保留记录时映射。</label>'+button('confirm-mapping','确认导入','check','primary wide')+'<p class="small muted" style="margin-top:9px;font-size:10px">校验检查格式与已知冲突；用户仍需核对原始机台文件。</p>';
      $('#mapping-preview').scrollIntoView({block:'nearest'});
    }
  }catch(ex){error(ex.message||'保存未完成，请重试。');}
  finally{form.dataset.saving='false';if(submit?.isConnected)submit.disabled=false;}
});
window.addEventListener('beforeunload',event=>{if(dirty){event.preventDefault();event.returnValue='';}});

try{
  state=await loadState();updateEntries();render();
  initMobileApp(refreshMobileStatus);
  if('BroadcastChannel' in window){
    channel=new BroadcastChannel('hgcal-bonding-updates');
    channel.onmessage=async()=>{try{state=await loadState();updateEntries();render();}catch{toast('其他窗口更新后读取失败，请刷新。');}};
  }
}catch(ex){
  $('#app').innerHTML='<div class="boot"><span class="boot-hex">⬡</span><h1>本机记录暂时无法读取</h1><p>'+e(ex.message)+'</p><p>请使用允许保存网站数据的浏览器，并刷新重试。</p></div>';
}
