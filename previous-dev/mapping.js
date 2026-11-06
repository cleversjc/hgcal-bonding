/**
 * LD V3 full-module lookup helpers. This module never infers the signal bonding
 * sequence from cell numbers. Only explicit entries can resolve a lookup.
 */

const FRONT_SHIELD = /^[A-F]$/;
const FRONT_GUARD = /^[M-R]$/;
const BACK_GROUP = /^[G-L]$/;
const FIELD_ALIASES = {
  target: 'target', cell: 'target', cell_id: 'target', cell_number: 'target',
  wire: 'wire', wire_id: 'wire', wire_number: 'wire',
  wire_start: 'wire_start', wire_end: 'wire_end',
  side: 'side', kind: 'kind',
};

function fail(message, line) {
  throw new Error(`${line ? `第 ${line} 行：` : ''}${message}`);
}

export function normalizeTarget(value) {
  const input = String(value ?? '').trim();
  if (/^[A-R]$/i.test(input)) return input.toUpperCase();
  const match = input.match(/^(?:(?:cell|c)\s*#?\s*)?(\d+)$/i);
  if (!match || !Number.isSafeInteger(Number(match[1])) || Number(match[1]) < 1) {
    fail('cell / 组编号无效，请填写 C19、19 或 A–R。');
  }
  return `C${Number(match[1])}`;
}

export function normalizeWire(value) {
  const input = String(value ?? '').trim().replace(/^(?:wire|w)\s*#?\s*/i, '');
  if (!/^\d+$/.test(input) || !Number.isSafeInteger(Number(input)) || Number(input) < 1) {
    fail('wire 编号无效，请填写正整数，例如 403 或 W403。');
  }
  return input;
}

export function wireKey(value) {
  return String(Number(normalizeWire(value)));
}

function normalizeSide(value = 'front') {
  const side = String(value || 'front').trim().toLowerCase();
  if (side !== 'front' && side !== 'back') fail('side 只能是 front 或 back。');
  return side;
}

function inferredKind(target, side) {
  if (side === 'back') return 'back';
  if (/^C\d+$/.test(target)) return 'signal';
  if (FRONT_SHIELD.test(target)) return 'shield';
  if (FRONT_GUARD.test(target)) return 'guard';
  return '';
}

function validateEntryIdentity(target, side, kind) {
  if (side === 'back') {
    if (!BACK_GROUP.test(target) || kind !== 'back') {
      fail('背面仅支持 G–L 组，kind 应为 back。');
    }
    return;
  }
  if (/^C\d+$/.test(target)) {
    const cell = Number(target.slice(1));
    if (cell < 1 || cell > 198) fail('当前 LD V3 模板的信号 cell 范围是 C1–C198。');
    if (kind !== 'signal') fail(`${target} 的 kind 应为 signal。`);
  } else if (FRONT_SHIELD.test(target)) {
    if (kind !== 'shield') fail(`${target} 的 kind 应为 shield。`);
  } else if (FRONT_GUARD.test(target)) {
    if (kind !== 'guard') fail(`${target} 的 kind 应为 guard。`);
  } else {
    fail('正面仅支持 C1–C198、A–F（shield）和 M–R（guard）。');
  }
}

function validateWireRange(wire, side, kind) {
  const n = Number(wireKey(wire));
  // The tutorial specifies 30 physical backside wires, not a machine-number
  // origin. A backside program may use a continuing sequence such as W631.
  const bounds = side === 'back' ? [1, 1000000]
    : kind === 'signal' ? [1, 594]
      : kind === 'guard' ? [595, 612] : [613, 630];
  if (n < bounds[0] || n > bounds[1]) {
    fail(`${side === 'back' ? '背面' : '正面'} ${kind} 的 wire 范围应为 W${bounds[0]}–W${bounds[1]}。`);
  }
}

function identity(entry) {
  return `${entry.side}|${entry.kind}|${entry.target}`;
}

function wireIdentity(side, wire) {
  return `${side}|${wireKey(wire)}`;
}

function sortWires(wires) {
  return wires.sort((a, b) => Number(wireKey(a)) - Number(wireKey(b)));
}

function normalizedEntry(entry) {
  if (!entry || typeof entry !== 'object') fail('映射条目格式无效。');
  const target = normalizeTarget(entry.target ?? entry.cell);
  const side = normalizeSide(entry.side);
  const kind = String(entry.kind || inferredKind(target, side)).trim().toLowerCase();
  validateEntryIdentity(target, side, kind);
  if (!Array.isArray(entry.wires) || !entry.wires.length) fail(`${target} 缺少 wire 编号。`);
  const wires = entry.wires.map(wire => {
    const normalized = normalizeWire(wire);
    validateWireRange(normalized, side, kind);
    return normalized;
  });
  return {
    side, kind, target, wires,
    source: String(entry.source ?? '').trim(),
    version: String(entry.version ?? '').trim(),
  };
}

function normalizeDataset(entries) {
  if (!Array.isArray(entries)) fail('映射数据必须是条目数组。');
  const groups = new Map();
  const owners = new Map();
  for (const input of entries) {
    const entry = normalizedEntry(input);
    const groupKey = identity(entry);
    let group = groups.get(groupKey);
    if (!group) {
      group = { ...entry, wires: [] };
      groups.set(groupKey, group);
    }
    for (const wire of entry.wires) {
      const key = wireIdentity(entry.side, wire);
      const owner = owners.get(key);
      if (owner && owner !== groupKey) fail(`${entry.side} W${wire} 被分配给多个 cell / 组。`);
      if (!owner) {
        owners.set(key, groupKey);
        group.wires.push(wire);
      }
    }
  }
  return [...groups.values()].map(group => ({ ...group, wires: sortWires(group.wires) }));
}

// Delimiter detection deliberately ignores separators inside quoted fields.
function detectDelimiter(text) {
  const counts = { ',': 0, '\t': 0, ';': 0 };
  let quoted = false;
  let hasContent = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') {
      if (quoted && text[i + 1] === '"') i++;
      else quoted = !quoted;
    } else if (!quoted && (char === '\n' || char === '\r')) {
      if (hasContent) break;
    } else if (!quoted && Object.hasOwn(counts, char)) {
      counts[char]++;
    }
    if (!/\s/.test(char)) hasContent = true;
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
}

function readDelimited(text, delimiter) {
  const rows = [];
  let fields = [], field = '', quoted = false, closed = false;
  let line = 1, rowLine = 1;
  const pushField = () => { fields.push(field); field = ''; closed = false; };
  const pushRow = () => {
    pushField();
    if (fields.some(value => value.trim() !== '')) rows.push({ fields, line: rowLine });
    fields = [];
  };
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else { quoted = false; closed = true; }
      } else {
        field += char;
        if (char === '\n') line++;
      }
      continue;
    }
    if (char === delimiter) { pushField(); continue; }
    if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i++;
      pushRow(); line++; rowLine = line;
      continue;
    }
    if (closed) {
      if (!/\s/.test(char)) fail('引号字段结束后出现多余字符。', line);
      continue;
    }
    if (char === '"') {
      if (field.trim() !== '') fail('引号必须位于字段开头。', line);
      field = ''; quoted = true;
    } else field += char;
  }
  if (quoted) fail('CSV 引号未闭合。', rowLine);
  if (field !== '' || fields.length || closed) pushRow();
  return rows;
}

export function parseMapping(text, { version, source = '用户导入' } = {}) {
  version = String(version ?? '').trim();
  source = String(source ?? '').trim();
  if (!version) fail('请先填写映射版本，便于追溯异常记录。');
  if (!source) fail('请填写映射来源。');
  if (typeof text !== 'string' || !text.trim()) fail('映射文件为空。');
  const clean = text.replace(/^\uFEFF/, '');
  const table = readDelimited(clean, detectDelimiter(clean));
  if (table.length < 2) fail('请提供表头和至少一行映射数据。');
  const rawHeaders = table[0].fields.map(value => value.trim().toLowerCase().replace(/[\s-]+/g, '_'));
  const headers = rawHeaders.map(header => FIELD_ALIASES[header] ?? null);
  const knownHeaders = headers.filter(Boolean);
  if (new Set(knownHeaders).size !== knownHeaders.length) fail('存在重复或等价的列名，请只保留一个 target / cell 列。');
  if (!headers.includes('target')) fail('缺少 cell 或 target 列。');
  if (!headers.includes('wire') && !(headers.includes('wire_start') && headers.includes('wire_end'))) {
    fail('缺少 wire 列，或完整的 wire_start / wire_end 列。');
  }
  const warnings = [];
  const unknown = rawHeaders.filter((_, index) => headers[index] === null);
  if (unknown.length) warnings.push(`未使用的列：${unknown.join('、')}。`);
  const owners = new Map();
  const entries = [];
  let duplicateCount = 0;
  for (const row of table.slice(1)) {
    try {
      if (row.fields.length !== headers.length) fail(`数据有 ${row.fields.length} 列，表头有 ${headers.length} 列。`);
      const values = Object.fromEntries(headers.map((header, i) => [header, row.fields[i].trim()]).filter(([header]) => header));
      if (!values.target) fail('cell / target 不能为空。');
      const target = normalizeTarget(values.target);
      const side = normalizeSide(values.side);
      const kind = String(values.kind || inferredKind(target, side)).toLowerCase();
      validateEntryIdentity(target, side, kind);
      let wires;
      if (values.wire) {
        if (values.wire_start || values.wire_end) fail('同一行只能填写 wire，或 wire_start / wire_end 范围，不能同时填写。');
        wires = [normalizeWire(values.wire)];
      } else {
        if (!values.wire_start || !values.wire_end) fail('wire 不能为空；使用范围时需要同时填写 wire_start 和 wire_end。');
        const start = normalizeWire(values.wire_start);
        const end = normalizeWire(values.wire_end);
        const first = Number(start), last = Number(end);
        if (last < first) fail('wire 范围结束值小于起始值。');
        if (last - first > 629) fail('wire 范围过大，请核对编号。');
        validateWireRange(start, side, kind);
        validateWireRange(end, side, kind);
        const width = /^0\d/.test(start) ? start.length : 0;
        wires = Array.from({ length: last - first + 1 }, (_, i) => String(first + i).padStart(width, '0'));
      }
      const uniqueWires = [];
      for (const wire of wires) {
        validateWireRange(wire, side, kind);
        const key = wireIdentity(side, wire);
        const owner = owners.get(key);
        if (owner && owner.target !== target) {
          fail(`${side} W${wire} 已在第 ${owner.line} 行分配给 ${owner.target}，不能再次分配给 ${target}。`);
        }
        if (owner) { duplicateCount++; continue; }
        owners.set(key, { target, line: row.line });
        uniqueWires.push(wire);
      }
      if (uniqueWires.length) entries.push({ side, kind, target, wires: uniqueWires, version, source });
    } catch (error) {
      fail(error.message, row.line);
    }
  }
  if (!entries.length) fail('没有可导入的映射。');
  if (duplicateCount) warnings.push(`已合并 ${duplicateCount} 个重复的相同对应关系。`);
  const grouped = normalizeDataset(entries);
  const counts = coverage(grouped);
  return {
    entries: grouped,
    stats: {
      rows: table.length - 1,
      entries: grouped.length,
      targets: grouped.length,
      wires: owners.size,
      backWires: grouped.filter(entry => entry.side === 'back').reduce((sum, entry) => sum + entry.wires.length, 0),
      ...counts,
    },
    warnings,
  };
}

/** Reject both a reassigned known wire and additional wires on a known target. */
export function validateAgainstBuiltin(entries, builtin) {
  const base = normalizeDataset(builtin);
  const incoming = normalizeDataset(entries);
  const owners = new Map();
  const targets = new Map();
  for (const entry of base) {
    targets.set(identity(entry), new Set(entry.wires.map(wireKey)));
    for (const wire of entry.wires) owners.set(wireIdentity(entry.side, wire), entry.target);
  }
  for (const entry of incoming) {
    for (const wire of entry.wires) {
      const knownOwner = owners.get(wireIdentity(entry.side, wire));
      if (knownOwner && knownOwner !== entry.target) {
        fail(`${entry.side} W${wire} 的内置对应是 ${knownOwner}，与导入的 ${entry.target} 冲突。请核对模块或映射版本。`);
      }
      const knownWires = targets.get(identity(entry));
      if (knownWires && !knownWires.has(wireKey(wire))) {
        fail(`${entry.target} 的内置 wire 范围不含 W${wire}。请核对模块或映射版本。`);
      }
    }
  }
  return true;
}

export function getMappings(builtin, imported = []) {
  const base = normalizeDataset(builtin);
  const incoming = normalizeDataset(imported);
  validateAgainstBuiltin(incoming, base);
  const grouped = new Map(base.map(entry => [identity(entry), {
    ...entry,
    wires: [...entry.wires],
    sources: [{ source: entry.source, version: entry.version, wires: [...entry.wires] }],
  }]));
  for (const entry of incoming) {
    const key = identity(entry);
    const existing = grouped.get(key);
    if (!existing) {
      grouped.set(key, { ...entry, wires: [...entry.wires], sources: [{ source: entry.source, version: entry.version, wires: [...entry.wires] }] });
      continue;
    }
    const wires = new Map(existing.wires.map(wire => [wireKey(wire), wire]));
    for (const wire of entry.wires) wires.set(wireKey(wire), wire);
    grouped.set(key, {
      ...entry,
      wires: sortWires([...wires.values()]),
      sources: [...existing.sources, { source: entry.source, version: entry.version, wires: [...entry.wires] }],
    });
  }
  return [...grouped.values()];
}

/**
 * Reconcile previously stored mappings when the built-in reference expands.
 * The original imported dataset is never mutated or deleted. If any wire on
 * one stored target conflicts, that entire target entry remains inactive.
 * New imports must still use validateAgainstBuiltin/getMappings directly.
 */
export function resolveStoredMappings(builtin, imported = []) {
  const base = normalizeDataset(builtin);
  const incoming = normalizeDataset(imported);
  const compatible = [];
  const conflicts = [];
  for (const entry of incoming) {
    try {
      validateAgainstBuiltin([entry], base);
      compatible.push(entry);
    } catch (error) {
      conflicts.push({ entry, reason: error.message });
    }
  }
  return { entries: getMappings(base, compatible), conflicts };
}

export function lookupTarget(entries, target, side = 'front') {
  const normalized = normalizeTarget(target);
  const normalizedSide = normalizeSide(side);
  return entries.find(entry => entry.target === normalized && entry.side === normalizedSide) ?? null;
}

export function lookupWire(entries, wire, side = 'front') {
  const key = wireKey(wire);
  const normalizedSide = normalizeSide(side);
  return entries.find(entry => entry.side === normalizedSide && entry.wires.some(value => wireKey(value) === key)) ?? null;
}

export function coverage(entries) {
  const cells = new Set(), signalWires = new Set(), groups = new Set(), frontWires = new Set();
  for (const entry of entries) {
    if (entry.side !== 'front') continue;
    if (entry.kind === 'signal') cells.add(entry.target);
    else groups.add(`${entry.kind}|${entry.target}`);
    for (const wire of entry.wires) {
      const key = wireKey(wire);
      frontWires.add(key);
      if (entry.kind === 'signal') signalWires.add(key);
    }
  }
  return { signalCells: cells.size, signalWires: signalWires.size, groups: groups.size, frontWires: frontWires.size };
}

function csvField(value) {
  let text = value == null ? '' : String(value);
  // Quoting alone does not prevent a spreadsheet from evaluating a formula.
  if (typeof value === 'string' && (/^[\u0000-\u001f\u007f]/.test(text) || /^\s*[=+\-@]/.test(text))) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

/** Returns UTF-8 CSV text (no BOM), with CRLF and spreadsheet formula protection. */
export function csvEncode(headers, rows) {
  if (!Array.isArray(headers) || !Array.isArray(rows)) fail('CSV 表头和数据应为数组。');
  return [headers, ...rows.map(row => Array.isArray(row) ? row : headers.map(header => row?.[header]))]
    .map(row => row.map(csvField).join(','))
    .join('\r\n') + '\r\n';
}
