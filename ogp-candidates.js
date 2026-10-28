/**
 * OGP lookup is a candidate search, never an alternative wire ownership table.
 *
 * Geometry source: Bonding_Tutorial.pdf p.18 (cell-reference.png). The 192
 * regular-grid blue pad sectors were assigned to their diagram hex vertices;
 * all 192 have exactly one sector. The diagram contains 80 marked vertices:
 * 46 with three visible sectors, 20 with two, and 14 with one. These are diagram
 * associations, not a verified OGP naming convention or probability model.
 *
 * Six additional small-cell labels have no explicit boundaries in the diagram.
 * Their paired regular-grid position supplies a conservative search envelope
 * only. They are never presented as having a verified shared aperture.
 *
 * No reference-table XY coordinate, persistence, or machine control is used.
 */

import { CELL_POSITIONS } from './domain-data.js';
import { normalizeTarget, lookupTarget } from './mapping.js';

export const OGP_CANDIDATE_VERSION = 'LD V3 OGP 候选 · 2026-10-28-v1';
export const OGP_CANDIDATE_SOURCE = 'Bonding Tutorial · p.18 图示孔与格位；wire 取自当前已启用编号表';
export const OGP_CANDIDATE_ASSUMPTION = '假设 OGP 用拍摄交点相邻的一个 cell 编号命名该交点；列出同编号、图示孔关联和一圈邻格候选。排序为核查顺序，不代表统计概率，OGP 编号约定仍待确认。';

const SMALL_PAIRS = [[13, 14], [61, 62], [69, 70], [142, 143], [153, 154], [162, 163]];
const smallToBase = new Map(SMALL_PAIRS.map(([base, small]) => [small, base]));
const baseToSmall = new Map(SMALL_PAIRS);

// [integer vertex x, integer vertex y, cells touching the vertex, visible pad cells]
// Grid units are diagram pixels (35.55, 20.71), not calibrated machine units.
const MARKED_VERTICES = [
  [3, 1, [2, 3, 11], [2, 3, 11]],
  [5, 1, [3, 4, 12], [4, 12]],
  [9, 1, [5, 6, 15], [5, 6, 15]],
  [0, 2, [1, 9, 10], [1, 9, 10]],
  [12, 2, [7, 16, 17], [7, 16, 17]],
  [14, 2, [8, 17, 18], [8, 18]],
  [7, 5, [13, 23, 24], [13, 24]],
  [11, 5, [16, 25, 26], [25, 26]],
  [-1, 7, [19, 20, 30], [19, 20, 30]],
  [3, 7, [21, 22, 32], [21, 22, 32]],
  [15, 7, [27, 28, 38], [27, 28, 38]],
  [0, 8, [20, 30, 31], [31]],
  [6, 8, [23, 33, 34], [23, 33, 34]],
  [-2, 10, [29, 30, 41], [29, 41]],
  [10, 10, [35, 36, 47], [35, 36, 47]],
  [13, 11, [37, 48, 49], [37, 48, 49]],
  [17, 11, [39, 50, 51], [39, 50, 51]],
  [1, 13, [42, 43, 55], [42, 43, 55]],
  [5, 13, [44, 45, 57], [44, 45, 57]],
  [15, 13, [49, 50, 63], [63]],
  [-4, 14, [40, 52, 53], [40, 52, 53]],
  [8, 14, [46, 58, 59], [46, 58, 59]],
  [-2, 16, [53, 54, 68], [54]],
  [12, 16, [60, 61, 76], [60, 61]],
  [18, 16, [64, 65, 79], [64, 65, 79]],
  [-3, 17, [53, 67, 68], [67]],
  [3, 17, [56, 71, 72], [56, 71, 72]],
  [9, 17, [59, 74, 75], [74, 75]],
  [19, 17, [65, 79, 80], [80]],
  [5, 19, [72, 73, 87], [73, 87]],
  [15, 19, [77, 78, 92], [77, 78, 92]],
  [17, 19, [78, 79, 93], [93]],
  [-6, 20, [66, 81, 82], [66, 81, 82]],
  [-2, 20, [68, 83, 84], [68, 83, 84]],
  [0, 20, [69, 84, 85], [69]],
  [12, 20, [76, 90, 91], [76, 90, 91]],
  [2, 22, [85, 86, 101], [85, 86]],
  [10, 22, [89, 90, 105], [89, 105]],
  [20, 22, [94, 95, 110], [94]],
  [-7, 23, [81, 96, 97], [96]],
  [7, 23, [88, 103, 104], [88, 103, 104]],
  [21, 23, [95, 110, 111], [95, 110, 111]],
  [-1, 25, [99, 100, 115], [99]],
  [3, 25, [101, 102, 117], [101, 102, 117]],
  [13, 25, [106, 107, 122], [106, 107, 122]],
  [17, 25, [108, 109, 124], [108, 109, 124]],
  [-6, 26, [97, 112, 113], [97, 112, 113]],
  [-4, 26, [98, 113, 114], [98, 114]],
  [0, 26, [100, 115, 116], [100, 115, 116]],
  [6, 26, [103, 118, 119], [118, 119]],
  [20, 28, [125, 126, 140], [125, 126]],
  [9, 29, [120, 134, 135], [120, 134]],
  [11, 29, [121, 135, 136], [121, 135, 136]],
  [15, 29, [123, 137, 138], [123, 137, 138]],
  [-5, 31, [127, 128, 141], [127, 128, 141]],
  [3, 31, [131, 132, 146], [131, 132, 146]],
  [19, 31, [139, 140, 155], [139, 140, 155]],
  [-2, 32, [129, 142, 144], [129, 142]],
  [0, 32, [130, 144, 145], [130, 144, 145]],
  [6, 32, [133, 147, 148], [133, 147, 148]],
  [12, 34, [150, 151, 165], [150, 151, 165]],
  [16, 34, [152, 153, 167], [152, 153]],
  [-3, 35, [142, 156, 157], [156, 157]],
  [9, 35, [149, 162, 164], [149, 162]],
  [17, 35, [153, 167, 168], [168]],
  [1, 37, [158, 159, 171], [158, 159, 171]],
  [5, 37, [160, 161, 173], [160, 161, 173]],
  [10, 38, [164, 175, 176], [164, 175, 176]],
  [14, 38, [166, 177, 178], [166, 177, 178]],
  [16, 38, [167, 178, 179], [167, 179]],
  [-2, 40, [169, 170, 180], [169, 170, 180]],
  [8, 40, [174, 175, 185], [174]],
  [3, 41, [172, 182, 183], [172]],
  [15, 41, [178, 188, 189], [189]],
  [3, 43, [182, 183, 192], [182, 183, 192]],
  [5, 43, [183, 184, 193], [184, 193]],
  [11, 43, [186, 187, 196], [186, 187, 196]],
  [0, 44, [181, 190, 191], [181, 190, 191]],
  [8, 44, [185, 194, 195], [185, 194, 195]],
  [14, 44, [188, 197, 198], [188, 197, 198]],
];

const baseGrid = new Map();
const gridOwners = new Map();
for (const position of CELL_POSITIONS) {
  if (smallToBase.has(position.cell)) continue;
  const q = Math.round((position.x - 353.9) / 35.55);
  const r = Math.round((position.y - 65) / 20.71);
  baseGrid.set(position.cell, [q, r]);
  gridOwners.set(`${q},${r}`, position.cell);
}

// Edge neighbors on the pointy-top diagram grid; no pixel-distance ranking.
const NEIGHBOR_STEPS = [[-2, 0], [2, 0], [-1, -3], [1, -3], [-1, 3], [1, 3]];
const TIER_ORDER = { baseline: 1, junction: 2, neighbor: 3, special: 4 };
const cellName = cell => `C${cell}`;

function conservativeNeighborhood(base) {
  const [q, r] = baseGrid.get(base);
  const baseCells = [base];
  for (const [dq, dr] of NEIGHBOR_STEPS) {
    const neighbor = gridOwners.get(`${q + dq},${r + dr}`);
    if (neighbor) baseCells.push(neighbor);
  }
  return [...new Set(baseCells.flatMap(cell => baseToSmall.has(cell)
    ? [cell, baseToSmall.get(cell)] : [cell]))];
}

/**
 * Returns every signal-cell candidate in the documented local model.
 *
 * baseline: same ID, a reference baseline (NOT a measured highest probability).
 * junction: another visible pad at a marked vertex touching the input base cell.
 * neighbor: remaining edge neighbors, retained even without a marked blue sector.
 * special: small-cell conservative extension, geometry explicitly uncertain.
 *
 * For one of the six additional small-cell IDs, all non-baseline candidates are
 * special: the parent's hole/edge relations cannot be asserted for the small cell.
 * Missing exact mapping entries remain in the result with wires: [], mapped:
 * false. Candidate discovery never invents wire numbers or mutates entries.
 */
export function lookupOgpCandidates(entries, input) {
  const normalized = normalizeTarget(input);
  if (!/^C\d+$/.test(normalized)) return null;
  const inputCell = Number(normalized.slice(1));
  const inputIsSmall = smallToBase.has(inputCell);
  const base = smallToBase.get(inputCell) ?? inputCell;
  if (!baseGrid.has(base)) throw new Error('当前 LD V3 的 OGP 候选范围是 C1–C198。');

  const touchingHoles = MARKED_VERTICES.filter(([, , touching]) => touching.includes(base));
  const holes = touchingHoles.map(([q, r, touching, pads]) => ({
    id: `V${q}_${r}`,
    x: Number((353.9 + q * 35.55).toFixed(2)),
    y: Number((65 + r * 20.71).toFixed(2)),
    touchingTargets: touching.map(cellName),
    padTargets: pads.map(cellName),
    uncertain: inputIsSmall,
    source: '教程 p.18 图示交点；非 OGP 程序确认',
  }));

  const candidates = conservativeNeighborhood(base).map(cell => {
    const target = cellName(cell);
    const relatedHoles = inputIsSmall || smallToBase.has(cell) ? []
      : holes.filter(hole => hole.padTargets.includes(target)).map(hole => hole.id);
    let tier, reason;
    if (cell === inputCell) {
      tier = 'baseline';
      reason = '同编号的直接映射，作为核查基准；并不表示它是 OGP 结果中概率最高的 cell。';
    } else if (inputIsSmall) {
      tier = 'special';
      reason = `${normalized} 是图中额外小 cell；借用 ${cellName(base)} 的邻域保守列出，具体边界与拍摄孔归属待核对。`;
    } else if (smallToBase.has(cell)) {
      tier = 'special';
      reason = `图中 ${cellName(smallToBase.get(cell))}/${target} 为相邻小 cell 标注；独立边界未绘明，保守纳入，交点归属待核对。`;
    } else if (relatedHoles.length) {
      tier = 'junction';
      reason = `${target} 的蓝色焊盘位于参考图中接触 ${normalized} 的交点；图示关联不代表 OGP 编号约定已确认。`;
    } else {
      tier = 'neighbor';
      reason = `${target} 与 ${normalized} 为相邻主格，保留为交点编号偏移的兜底候选；不能因该处未画蓝色焊盘而排除。`;
    }
    const entry = lookupTarget(entries, target, 'front');
    const mapped = entry?.kind === 'signal' && Array.isArray(entry.wires) && entry.wires.length > 0;
    return {
      target,
      wires: mapped ? [...entry.wires] : [],
      tier,
      reason: mapped ? reason : `${reason} 当前编号表未提供该 cell 的 wire。`,
      holeIds: relatedHoles,
      uncertain: inputIsSmall || smallToBase.has(cell),
      mapped: Boolean(mapped),
    };
  }).sort((a, b) => TIER_ORDER[a.tier] - TIER_ORDER[b.tier] || Number(a.target.slice(1)) - Number(b.target.slice(1)));

  const pairedSmall = baseToSmall.get(base);
  return {
    input: normalized,
    version: OGP_CANDIDATE_VERSION,
    source: OGP_CANDIDATE_SOURCE,
    assumption: OGP_CANDIDATE_ASSUMPTION,
    needsReview: true,
    geometryBase: cellName(base),
    smallCellInput: inputIsSmall,
    smallCellPair: pairedSmall ? [cellName(base), cellName(pairedSmall)] : null,
    warnings: candidates.some(candidate => candidate.uncertain)
      ? ['包含小 cell 的保守扩展。原图没有绘明这些小 cell 的独立边界，相关交点归属待现场核对。'] : [],
    candidates,
    holes,
  };
}
