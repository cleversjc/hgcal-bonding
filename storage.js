import { getMappings, normalizeTarget, normalizeWire, wireKey } from './mapping.js';

const NAME = 'hgcal-bonding-workbench';
let connection;
export function emptyState() { return { schemaVersion: 1, modules: [], records: [], importedMapping: [], mappingMeta: null, activeModuleId: null }; }
async function db() {
  if (connection) return connection;
  connection = await new Promise((resolve, reject) => {
    const request = indexedDB.open(NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('state');
    request.onsuccess = () => { request.result.onversionchange = () => { request.result.close(); connection = null; }; resolve(request.result); };
    request.onerror = () => reject(new Error('无法打开本机存储，请允许此浏览器保存网站数据。'));
    request.onblocked = () => reject(new Error('请关闭其他 Bonding 页面后重新打开。'));
  });
  return connection;
}
export async function loadState() {
  const database = await db();
  return new Promise((resolve, reject) => {
    const tx = database.transaction('state', 'readonly');
    const request = tx.objectStore('state').get('main');
    request.onsuccess = () => resolve(request.result || emptyState());
    request.onerror = () => reject(request.error);
  });
}
export async function saveState(state) {
  validateState(state);
  const database = await db();
  return new Promise((resolve, reject) => {
    const tx = database.transaction('state', 'readwrite');
    tx.objectStore('state').put(state, 'main');
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(new Error('未能保存。请检查设备可用空间，导出备份后再试。'));
  });
}
export function makeBackup(state) {
  return { app: 'HGCAL Bonding Workbench', schemaVersion: 1, exportedAt: new Date().toISOString(), data: state };
}
export function readBackup(text) {
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw new Error('备份不是有效的 JSON 文件。'); }
  if (!isObject(parsed) || parsed.app !== 'HGCAL Bonding Workbench' || parsed.schemaVersion !== 1) throw new Error('这不是受支持的 Bonding 工作台备份。');
  requireDate(parsed.exportedAt, '备份导出时间');
  validateState(parsed.data);
  return parsed.data;
}
export function mergeBackup(current, incoming) {
  validateState(current);
  validateState(incoming);
  const modules = [...current.modules];
  const moduleIds = new Set(modules.map(m => m.id));
  incoming.modules.forEach(m => { if (!moduleIds.has(m.id)) { modules.push(m); moduleIds.add(m.id); } });
  const records = [...current.records];
  const recordIds = new Set(records.map(r => r.id));
  let added = 0, skipped = 0;
  incoming.records.forEach(r => { if (recordIds.has(r.id)) skipped++; else { records.push(r); recordIds.add(r.id); added++; } });
  return { state: { ...current, modules, records, activeModuleId: current.activeModuleId || incoming.activeModuleId, importedMapping: current.importedMapping.length ? current.importedMapping : incoming.importedMapping, mappingMeta: current.importedMapping.length ? current.mappingMeta : incoming.mappingMeta }, added, skipped };
}

const STATUSES = new Set(['open', 'repaired', 'closed', 'void']);
const MAPPING_STATUSES = new Set(['documented', 'manual_unverified', 'cell_only', 'wire_only']);
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function invalid(label) { throw new Error(`${label}格式无效，未导入或保存任何数据。`); }
function requireString(value, label, { empty = false, max = 4000 } = {}) {
  if (typeof value !== 'string' || (!empty && !value.trim()) || value.length > max) invalid(label);
}
function requireDate(value, label) {
  if (typeof value !== 'string' || !value.trim() || !Number.isFinite(Date.parse(value))) invalid(label);
}
function nullableNumber(value, label, max, integer = false) {
  if (value === null) return;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > max || (integer && !Number.isInteger(value))) invalid(label);
}
function requireWires(wires, label, maxCount = 1000000) {
  if (!Array.isArray(wires) || wires.length > maxCount) invalid(label);
  const seen = new Set();
  for (const wire of wires) {
    if (typeof wire !== 'string' || !/^\d+$/.test(wire)) invalid(label);
    let key;
    try { normalizeWire(wire); key = wireKey(wire); } catch { invalid(label); }
    if (seen.has(key)) invalid(`${label}（编号重复）`);
    seen.add(key);
  }
}
function requireTarget(target, side, label) {
  requireString(target, label, { empty: true, max: 20 });
  if (!target) return;
  let normalized;
  try { normalized = normalizeTarget(target); } catch { invalid(label); }
  if (normalized !== target) invalid(label);
  if (side === 'back' ? !/^[G-L]$/.test(target)
    : !(/^[A-FM-R]$/.test(target) || (/^C\d+$/.test(target) && Number(target.slice(1)) >= 1 && Number(target.slice(1)) <= 198))) invalid(label);
}
function requirePhoto(photo) {
  if (!isObject(photo)) invalid('备份照片');
  requireString(photo.name, '照片名称', { empty: true, max: 1024 });
  if (typeof photo.data !== 'string') invalid('备份照片');
  const match = photo.data.match(/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!match || match[2].length % 4 !== 0) invalid('备份照片');
  // Only passive raster formats are accepted. Validate their signature without
  // decoding a complete multi-megabyte image during every storage operation.
  let header;
  try { header = atob(match[2].slice(0, 32)); } catch { invalid('备份照片'); }
  if (match[1] === 'jpeg' && !header.startsWith('\xff\xd8\xff')) invalid('JPEG 照片');
  if (match[1] === 'png' && !header.startsWith('\x89PNG\r\n\x1a\n')) invalid('PNG 照片');
  if (match[1] === 'webp' && !(header.startsWith('RIFF') && header.slice(8, 12) === 'WEBP')) invalid('WebP 照片');
}
function requireMappingSnapshot(mapping, record) {
  if (!isObject(mapping) || !MAPPING_STATUSES.has(mapping.status)) invalid('记录的映射快照');
  requireString(mapping.version, '映射快照版本', { max: 1024 });
  requireString(mapping.source, '映射快照来源', { max: 2048 });
  if (mapping.target !== (record.target || null)) invalid('映射快照的位点');
  requireWires(mapping.wires, '映射快照 wire', 30);
  if (mapping.wires.length !== record.wires.length || mapping.wires.some((wire, i) => wireKey(wire) !== wireKey(record.wires[i]))) invalid('映射快照与记录 wire 的对应');
  requireWires(mapping.expectedWires, '映射快照预期 wire');
  if (!Array.isArray(mapping.sources)) invalid('映射快照的来源列表');
  for (const source of mapping.sources) {
    if (!isObject(source)) invalid('映射快照的来源条目');
    requireString(source.source, '映射来源', { max: 2048 });
    requireString(source.version, '映射版本', { max: 1024 });
    requireWires(source.wires, '映射来源 wire');
  }
  if (mapping.status === 'documented' && (!record.target || !mapping.expectedWires.length || record.wires.some(wire => !mapping.expectedWires.some(expected => wireKey(wire) === wireKey(expected))))) invalid('有映射依据的记录快照');
  if (mapping.status === 'manual_unverified' && (!record.target || !record.wires.length)) invalid('人工填写的记录快照');
  if (mapping.status === 'cell_only' && (!record.target || record.wires.length)) invalid('仅位点的记录快照');
  if (mapping.status === 'wire_only' && (record.target || !record.wires.length)) invalid('仅 wire 的记录快照');
}
function validateState(data) {
  if (!isObject(data) || data.schemaVersion !== 1) invalid('数据版本');
  if (!Array.isArray(data.modules) || !Array.isArray(data.records) || !Array.isArray(data.importedMapping)) invalid('必要的数据列表');
  const modules = new Map();
  for (const module of data.modules) {
    if (!isObject(module)) invalid('模块');
    requireString(module.id, '模块编号', { max: 80 });
    requireString(module.operator, '模块记录人', { max: 60 });
    requireString(module.program, '模块程序', { empty: true, max: 120 });
    requireString(module.type, '模块类型', { max: 120 });
    requireDate(module.createdAt, '模块创建时间');
    if (modules.has(module.id)) invalid('模块编号（重复）');
    modules.set(module.id, module);
  }
  const recordIds = new Set();
  for (const record of data.records) {
    if (!isObject(record)) invalid('异常记录');
    requireString(record.id, '异常记录 ID', { max: 128 });
    if (recordIds.has(record.id)) invalid('异常记录 ID（重复）');
    recordIds.add(record.id);
    requireString(record.moduleId, '记录的模块编号', { max: 80 });
    if (!modules.has(record.moduleId)) invalid('记录所属模块（不存在）');
    requireString(record.moduleType, '记录的模块类型', { max: 120 });
    requireString(record.program, '记录的机台程序', { empty: true, max: 120 });
    if (!STATUSES.has(record.status) || !['front', 'back'].includes(record.side)) invalid('记录状态或正反面');
    requireTarget(record.target, record.side, '记录的 cell / 位点');
    requireWires(record.wires, '记录的 wire', 30);
    if (!record.target && !record.wires.length) invalid('记录位置（cell 和 wire 均为空）');
    requireString(record.type, '异常类型', { max: 120 });
    requireString(record.operator, '异常记录人', { max: 60 });
    requireString(record.phase, '发现阶段', { max: 120 });
    requireString(record.endpoint, '位置 / 端点', { max: 120 });
    requireString(record.note, '异常备注', { empty: true, max: 4000 });
    nullableNumber(record.expected, '计划线数', 100, true);
    nullableNumber(record.actual, '实际线数', 100, true);
    nullableNumber(record.force, '拉力数值', 10000);
    requireDate(record.createdAt, '异常创建时间');
    requireDate(record.updatedAt, '异常更新时间');
    if (!Array.isArray(record.photos) || record.photos.length > 3) invalid('记录照片列表');
    record.photos.forEach(requirePhoto);
    if (!Array.isArray(record.history) || !record.history.length) invalid('处理历史');
    for (const event of record.history) {
      if (!isObject(event) || !STATUSES.has(event.status)) invalid('处理历史状态');
      requireString(event.operator, '处理历史记录人', { max: 60 });
      requireString(event.note, '处理历史说明', { max: 4000 });
      requireDate(event.at, '处理历史时间');
    }
    if (record.history.at(-1).status !== record.status) invalid('当前状态与处理历史的对应');
    requireMappingSnapshot(record.mapping, record);
  }
  if (data.activeModuleId !== null && (typeof data.activeModuleId !== 'string' || !modules.has(data.activeModuleId))) invalid('当前模块');
  for (const entry of data.importedMapping) {
    if (!isObject(entry)) invalid('导入映射');
    requireString(entry.source, '导入映射来源', { max: 2048 });
    requireString(entry.version, '导入映射版本', { max: 1024 });
    requireWires(entry.wires, '导入映射 wire');
  }
  // Saved records and imported mappings are historical evidence. A later
  // built-in reference may conflict with a mapping accepted by an older app.
  // Validate stored mappings structurally and internally here; the UI's
  // resolveStoredMappings decides which entries can be active for lookup.
  // Fresh mapping imports retain their strict built-in compatibility check.
  getMappings([], data.importedMapping);
  if (data.importedMapping.length) {
    if (!isObject(data.mappingMeta)) invalid('用户映射版本信息');
    requireString(data.mappingMeta.version, '用户映射版本', { max: 1024 });
    requireString(data.mappingMeta.source, '用户映射来源', { max: 2048 });
    requireDate(data.mappingMeta.importedAt, '映射导入时间');
  } else if (data.mappingMeta !== null) invalid('空映射的版本信息');
}
