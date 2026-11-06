import { BUILTIN_MAPPING } from './domain-data.js';
import { csvEncode, normalizeWire } from './mapping.js';

export const OGP_STATUSES = { pending: '待确认', normal: '正常', anomaly: '确认异常' };
export const OGP_PARSER = 'hgcal-yolo-grid-v1';
const uid = () => crypto.randomUUID();
const fail = message => { throw new Error(message); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const text = (value, max = 4000, empty = false) => typeof value === 'string' && value.length <= max && (empty || !!value.trim());
const date = value => text(value, 64) && Number.isFinite(Date.parse(value));
const wire = value => typeof value === 'string' && /^[1-9]\d{0,2}$/.test(value) && Number(value) <= 594;
const cell = value => typeof value === 'string' && /^C[1-9]\d{0,2}$/.test(value) && Number(value.slice(1)) <= 198;

export function validateOgpImage(image) {
  if (!object(image) || !text(image.name, 1024, true) || !Number.isInteger(image.width) || !Number.isInteger(image.height) || image.width < 1 || image.height < 1 || image.width > 4096 || image.height > 4096) fail('OGP 图片信息无效。');
  const match = typeof image.data === 'string' && image.data.match(/^data:image\/(jpeg|png);base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!match || match[2].length % 4 || image.data.length > 16 * 1024 * 1024) fail('OGP 图片必须包含完整的 JPEG / PNG 字节。');
  let header;
  try { header = atob(match[2].slice(0, 32)); } catch { fail('OGP 图片编码无效。'); }
  if (match[1] === 'jpeg' ? !header.startsWith('\xff\xd8\xff') : !header.startsWith('\x89PNG\r\n\x1a\n')) fail('OGP 图片文件头无效。');
}

function validateSource(source) {
  if (!object(source) || !text(source.name, 1024) || !/^[a-f0-9]{64}$/.test(source.sha256) || !Number.isInteger(source.pageCount) || source.pageCount < 1 || source.pageCount > 60 || !text(source.parser, 120)) fail('OGP 来源信息无效。');
}

export function validateManifest(manifest) {
  if (!object(manifest) || manifest.app !== 'HGCAL OGP Import' || manifest.schemaVersion !== 1) fail('这不是支持的 OGP 预处理 JSON。');
  validateSource(manifest.source);
  if (!Array.isArray(manifest.detections) || !manifest.detections.length || manifest.detections.length > 2000 || !Array.isArray(manifest.pages) || manifest.pages.length !== manifest.source.pageCount) fail('OGP 页数或检测列表无效。');
  const identities = new Set(), counts = new Map();
  for (const row of manifest.detections) {
    if (!object(row) || !/^320[A-Z0-9]{12}$/.test(row.moduleId) || !cell(row.cell) || typeof row.confidence !== 'number' || !Number.isFinite(row.confidence) || row.confidence < 0 || row.confidence > 1 || !Number.isInteger(row.page) || row.page < 1 || row.page > manifest.source.pageCount || !Number.isInteger(row.index) || row.index < 1 || !text(row.caption, 200)) fail('OGP 检测字段无效。');
    const identity = row.page + ':' + row.index;
    if (identities.has(identity)) fail('检测来源序号重复；重复 Cell 必须保留不同的来源序号。');
    identities.add(identity);
    counts.set(row.page, (counts.get(row.page) || 0) + 1);
    validateOgpImage(row.image);
  }
  for (const [i, page] of manifest.pages.entries()) {
    if (!object(page) || page.page !== i + 1 || !/^320[A-Z0-9]{12}$/.test(page.moduleId) || !Number.isInteger(page.count) || page.count < 1 || page.count !== counts.get(page.page) || manifest.detections.some(r => r.page === page.page && r.moduleId !== page.moduleId)) fail('OGP 每页模块归属或检测数量不一致。');
  }
  return manifest;
}

export function prepareOgpImport(manifest, operator, now = new Date().toISOString()) {
  validateManifest(manifest);
  if (!text(operator, 60)) fail('请填写导入人。');
  const importId = uid(), images = [], rows = [];
  for (const detection of manifest.detections) {
    const entry = BUILTIN_MAPPING.find(e => e.side === 'front' && e.target === detection.cell);
    if (!entry?.wires.length) fail(detection.cell + ' 没有 LD V3 映射，未保存任何检测。');
    const originalWire = String(Number(entry.wires[0])), imageId = uid();
    images.push({ ...detection.image, id: imageId });
    rows.push({
      id: uid(), importId, moduleId: detection.moduleId, reportedCell: detection.cell,
      confidence: detection.confidence, sourcePage: detection.page, sourceIndex: detection.index,
      caption: detection.caption, imageId, originalWire, wire: originalWire,
      mapping: { target: entry.target, wires: entry.wires.map(String), source: entry.source, version: entry.version },
      status: 'pending', note: '', createdAt: now, updatedAt: now,
      history: [{ at: now, operator, wire: originalWire, status: 'pending', note: '', reason: '导入；LD V3 对应列表中的第一根 Wire' }]
    });
  }
  return { report: { id: importId, source: { ...manifest.source }, pages: structuredClone(manifest.pages), rowCount: rows.length, operator, importedAt: now }, rows, images };
}

export function appendOgpImport(state, draft) {
  if ((state.ogpImports || []).some(r => r.id === draft.report.id)) fail('该预览已经保存，请勿重复点击。');
  const modules = [...state.modules];
  for (const moduleId of new Set(draft.rows.map(r => r.moduleId))) {
    if (!modules.some(m => m.id === moduleId)) modules.push({ id: moduleId, operator: draft.report.operator, program: '', type: 'LD V3 Full', createdAt: draft.report.importedAt });
  }
  // Repeated detections remain separate rows. Identical immutable image bytes
  // may share one image ID, keeping repeated report imports / backups compact.
  const imageByData = new Map((state.ogpImages || []).filter(image=>image.data).map(image => [image.data, image.id]));
  const imageIds = new Map(), newImages = [];
  for (const image of draft.images) {
    let id = imageByData.get(image.data);
    if (!id) { id = image.id; newImages.push(image); imageByData.set(image.data, id); }
    imageIds.set(image.id, id);
  }
  return { ...state, modules, activeModuleId: state.activeModuleId || draft.rows[0].moduleId,
    ogpImports: [...(state.ogpImports || []), draft.report], ogpRows: [...(state.ogpRows || []), ...draft.rows.map(r => ({ ...r, imageId: imageIds.get(r.imageId) }))], ogpImages: [...(state.ogpImages || []), ...newImages] };
}

export function editOgpRow(row, values, now = new Date().toISOString()) {
  const editedWire = String(Number(normalizeWire(values.wire)));
  if (!wire(editedWire)) fail('定位 Wire 应为 W1–W594。');
  if (!Object.hasOwn(OGP_STATUSES, values.status) || !text(values.operator, 60) || !text(values.note, 4000, true) || !text(values.reason, 1000, true)) fail('请填写有效的状态、记录人及备注。');
  if (editedWire !== row.wire && !values.reason.trim()) fail('修改 Wire 时请填写修正原因。');
  return { ...row, wire: editedWire, status: values.status, note: values.note, updatedAt: now,
    history: [...row.history, { at: now, operator: values.operator, wire: editedWire, status: values.status, note: values.note, reason: values.reason || '更新检查结果' }] };
}

export function setOgpCompletion(row, completed, operator, now = new Date().toISOString()) {
  if (typeof completed !== 'boolean' || !text(operator, 60) || !date(now)) fail('完成记录信息无效。');
  if (!!row.completedAt === completed) return row;
  return { ...row, completedAt: completed ? now : null, completedBy: completed ? operator : null, updatedAt: now,
    history: [...row.history, { at: now, operator, wire: row.wire, status: row.status, note: row.note,
      reason: completed ? '确认修改完成' : '恢复为未完成', action: completed ? 'complete' : 'reopen' }] };
}

export function filterOgpRows(rows, moduleId = 'all', view = 'unfinished') {
  return rows.filter(row => (moduleId === 'all' || row.moduleId === moduleId) &&
    (view === 'all' || (view === 'completed' ? !!row.completedAt : !row.completedAt && (view === 'unfinished' || row.status === view))));
}

export function sortedOgpRows(rows) {
  return [...rows].sort((a, b) => a.moduleId.localeCompare(b.moduleId) || Number(a.wire) - Number(b.wire) || a.createdAt.localeCompare(b.createdAt) || a.sourcePage - b.sourcePage || a.sourceIndex - b.sourceIndex || a.id.localeCompare(b.id));
}
export function duplicateOgpWires(rows) {
  const counts = new Map();
  for (const row of rows) { const key = row.moduleId + ':' + Number(row.wire); counts.set(key, (counts.get(key) || 0) + 1); }
  return new Set(rows.filter(r => counts.get(r.moduleId + ':' + Number(r.wire)) > 1).map(r => r.id));
}
export function ogpCsv(rows, reports, duplicateRows = rows) {
  const sources = new Map(reports.map(r => [r.id, r.source]));
  const duplicates = duplicateOgpWires(duplicateRows);
  return '\uFEFF' + csvEncode(['detection_id','import_id','module_id','ogp_cell','original_wire','wire','yolo_confidence','status','note','image_id','source_pdf','source_sha256','source_page','source_index','duplicate_wire_review','mapping_snapshot','created_at','updated_at','audit_history','completed_at','completed_by'],
    sortedOgpRows(rows).map(r => [r.id, r.importId, r.moduleId, r.reportedCell, r.originalWire, r.wire, r.confidence, r.status, r.note, r.imageId, sources.get(r.importId)?.name || '', sources.get(r.importId)?.sha256 || '', r.sourcePage, r.sourceIndex, duplicates.has(r.id), JSON.stringify(r.mapping), r.createdAt, r.updatedAt, JSON.stringify(r.history), r.completedAt || '', r.completedBy || '']));
}

// Optional extension of schema-v1: legacy backups without these arrays remain valid.
export function validateOgpState(state, {allowImageRefs=false}={}) {
  const reports = state.ogpImports === undefined ? [] : state.ogpImports, rows = state.ogpRows === undefined ? [] : state.ogpRows, images = state.ogpImages === undefined ? [] : state.ogpImages;
  if (![reports, rows, images].every(Array.isArray)) fail('OGP 保存列表无效。');
  const unique = (list, label) => { const ids = new Set(); for (const item of list) { if (!object(item) || !text(item.id, 128) || ids.has(item.id)) fail(label + ' ID 无效或重复。'); ids.add(item.id); } return ids; };
  const reportIds = unique(reports, 'OGP 导入'), imageIds = unique(images, 'OGP 图片'); unique(rows, 'OGP 检测');
  for (const image of images) {
    if (allowImageRefs && image.data === undefined && /^[a-f0-9]{64}$/.test(image.sha256) && Number.isInteger(image.byteLength) && image.byteLength > 0 && /^image\/(jpeg|png)$/.test(image.mime) && Number.isInteger(image.width) && Number.isInteger(image.height) && image.width > 0 && image.height > 0) continue;
    validateOgpImage(image);
  }
  const modules = new Set(state.modules.map(m => m.id));
  for (const report of reports) {
    validateSource(report.source);
    if (!date(report.importedAt) || !text(report.operator, 60) || !Number.isInteger(report.rowCount) || report.rowCount < 1 || report.rowCount !== rows.filter(r => r.importId === report.id).length || !Array.isArray(report.pages) || (report.partial ? (!Number.isInteger(report.originalRowCount) || report.originalRowCount < report.rowCount || report.pages.length > report.source.pageCount) : report.pages.length !== report.source.pageCount)) fail('OGP 导入记录无效。');
    for (const [i, page] of report.pages.entries()) {
      const pageRows = rows.filter(r => r.importId === report.id && r.sourcePage === page.page);
      if (!object(page) || (!Number.isInteger(page.page) || page.page < 1 || page.page > report.source.pageCount || (report.partial ? (i > 0 && page.page <= report.pages[i-1].page) : page.page !== i + 1)) || !modules.has(page.moduleId) || page.count !== pageRows.length || page.count < 1 || pageRows.some(r => r.moduleId !== page.moduleId)) fail('OGP 分页归属无效。');
    }
  }
  const sourceKeys = new Set(), referencedImages = new Set();
  for (const row of rows) {
    if (!reportIds.has(row.importId) || !modules.has(row.moduleId) || !cell(row.reportedCell) || !wire(row.wire) || !wire(row.originalWire) || !Number.isFinite(row.confidence) || row.confidence < 0 || row.confidence > 1 || !Object.hasOwn(OGP_STATUSES, row.status) || !text(row.note, 4000, true) || !text(row.caption, 200) || !imageIds.has(row.imageId) || !date(row.createdAt) || !date(row.updatedAt) || !Number.isInteger(row.sourcePage) || row.sourcePage < 1 || !Number.isInteger(row.sourceIndex) || row.sourceIndex < 1) fail('OGP 检测保存字段无效。');
    const key = row.importId + ':' + row.sourcePage + ':' + row.sourceIndex;
    if (sourceKeys.has(key)) fail('OGP 来源序号重复。'); sourceKeys.add(key); referencedImages.add(row.imageId);
    if (!object(row.mapping) || row.mapping.target !== row.reportedCell || !Array.isArray(row.mapping.wires) || !row.mapping.wires.length || row.mapping.wires.some(w => !wire(w)) || row.mapping.wires[0] !== row.originalWire || !text(row.mapping.source, 2048) || !text(row.mapping.version, 1024)) fail('OGP 原始映射快照无效。');
    if (!Array.isArray(row.history) || !row.history.length) fail('OGP 修改记录缺失。');
    for (const event of row.history) if (!object(event) || !date(event.at) || !text(event.operator, 60) || !wire(event.wire) || !Object.hasOwn(OGP_STATUSES, event.status) || !text(event.note, 4000, true) || !text(event.reason, 1000)) fail('OGP 修改记录无效。');
    for (const event of row.history) if (event.action !== undefined && !['complete', 'reopen'].includes(event.action)) fail('OGP 完成操作无效。');
    const completion = row.history.findLast(event => event.action);
    if (row.completedAt != null) {
      if (!date(row.completedAt) || !text(row.completedBy, 60) || completion?.action !== 'complete' || completion.at !== row.completedAt || completion.operator !== row.completedBy) fail('OGP 完成记录与历史不一致。');
    } else if (row.completedBy != null || completion?.action === 'complete') fail('OGP 完成记录缺失。');
    const last = row.history.at(-1);
    if (row.history[0].wire !== row.originalWire || row.history[0].at !== row.createdAt || last.at !== row.updatedAt || last.wire !== row.wire || last.status !== row.status || last.note !== row.note) fail('OGP 当前值与修改历史不一致。');
    if (!reports.find(r => r.id === row.importId)?.pages.some(p => p.page === row.sourcePage)) fail('OGP 来源页不存在。');
  }
  if (referencedImages.size !== images.length) fail('OGP 图片引用不完整。');
}
