/**
 * Backside cell positions from the user's annotated image.png.
 * x/y describe the reference image only; they are not machine coordinates.
 * The image places I/L one row below the widest row of the module.
 * Machine view reverses both axes (180 degrees); labels stay upright.
 */
export const BACKSIDE_POSITIONS = Object.freeze([
  { target: 'H', x: 242, y: 80, row: 0, column: 0, order: 1, referenceLocation: '左上', machineLocation: '右下' },
  { target: 'G', x: 620, y: 80, row: 0, column: 7, order: 2, referenceLocation: '右上', machineLocation: '左下' },
  { target: 'L', x: 809, y: 503.9, row: 9, column: 14, order: 3, referenceLocation: '右侧', machineLocation: '左侧' },
  { target: 'K', x: 647, y: 786.5, row: 15, column: 8, order: 4, referenceLocation: '右下', machineLocation: '左上' },
  { target: 'J', x: 215, y: 786.5, row: 15, column: 0, order: 5, referenceLocation: '左下', machineLocation: '右上' },
  { target: 'I', x: 53, y: 503.9, row: 9, column: 0, order: 6, referenceLocation: '左侧', machineLocation: '右侧' }
].map(Object.freeze));

const SOURCE_WIDTH = 865;
const SOURCE_HEIGHT = 834;
const PADDING = 60;
const WIDTH = SOURCE_WIDTH + PADDING * 2;
const HEIGHT = SOURCE_HEIGHT + PADDING * 2;
const sourcePosition = new Map(BACKSIDE_POSITIONS.map(p => [p.row + ':' + p.column, p]));

function hexagon(x, y) {
  return [[x,y-29],[x+25,y-14.5],[x+25,y+14.5],[x,y+29],[x-25,y+14.5],[x-25,y-14.5]]
    .map(pair => pair.map(n => Number(n.toFixed(2))).join(',')).join(' ');
}

function honeycomb(target, flagged) {
  const polygons = [];
  // Reproduce the supplied silhouette: 8..16..9 full-size hexagons per row.
  // These background shapes have no numeric cell associations or hit targets.
  for (let row = 0; row < 16; row++) {
    const count = row <= 8 ? 8 + row : 24 - row;
    const startX = row <= 8 ? 242 - row * 27 : 26 + (row - 8) * 27;
    for (let column = 0; column < count; column++) {
      const point = sourcePosition.get(row + ':' + column);
      const classes = ['backside-cell'];
      if (point) classes.push('backside-cell-position');
      if (point && flagged.has(point.target)) classes.push('flagged');
      if (point?.target === target) classes.push('selected');
      polygons.push('<polygon class="' + classes.join(' ') + '" points="' + hexagon(startX + column * 54 + PADDING, 80 + row * 47.1 + PADDING) + '"/>');
    }
  }
  return polygons.join('');
}

export function renderBacksideMap({ target = 'H', machineView = false, flagged = [] } = {}) {
  const flaggedTargets = new Set(flagged);
  const orientation = machineView ? '机台打线朝向' : '参考图朝向';
  const buttons = BACKSIDE_POSITIONS.map(point => {
    const originalX = point.x + PADDING;
    const originalY = point.y + PADDING;
    const x = machineView ? WIDTH - originalX : originalX;
    const y = machineView ? HEIGHT - originalY : originalY;
    const location = machineView ? point.machineLocation : point.referenceLocation;
    const selected = point.target === target;
    const marked = flaggedTargets.has(point.target);
    return '<button type="button" class="backside-position' + (selected ? ' active' : '') + (marked ? ' flagged' : '') + '" style="left:' + (100 * x / WIDTH).toFixed(4) + '%;top:' + (100 * y / HEIGHT).toFixed(4) + '%" data-act="target" data-target="' + point.target + '" aria-label="选择背面 Cell ' + point.target + '，' + orientation + location + (marked ? '，有异常记录' : '') + '" aria-pressed="' + selected + '"><span>' + point.target + '</span>' + (marked ? '<i class="backside-flag" aria-hidden="true"></i>' : '') + '</button>';
  }).join('');

  return '<div class="backside-diagram">' +
    '<div class="backside-orientation" role="group" aria-label="背面图朝向">' +
      '<button type="button" class="' + (!machineView ? 'active' : '') + '" data-act="back-orientation" data-view="reference" aria-pressed="' + !machineView + '">参考图朝向</button>' +
      '<button type="button" class="' + (machineView ? 'active' : '') + '" data-act="back-orientation" data-view="machine" aria-pressed="' + !!machineView + '">机台打线朝向</button>' +
    '</div>' +
    '<p class="backside-orientation-note">' + (machineView ? '已将参考图上下、左右反转：H 在右下。' : '与提供的图片一致：H 在左上，G 在右上。') + '</p>' +
    '<div class="backside-canvas" role="group" aria-label="六个背面 Cell 的空间位置，' + orientation + '">' +
      '<svg class="backside-grid" viewBox="0 0 ' + WIDTH + ' ' + HEIGHT + '" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false"><g' + (machineView ? ' transform="rotate(180 ' + WIDTH / 2 + ' ' + HEIGHT / 2 + ')"' : '') + '>' + honeycomb(target, flaggedTargets) + '</g></svg>' +
      '<div class="backside-center-label" aria-hidden="true"><span>BACKSIDE</span><strong>点击字母选择位置</strong><small>每个位置 5 根线</small></div>' + buttons +
    '</div>' +
    '<div class="backside-map-key"><span><i class="backside-key-selected"></i>当前选择</span><span><i class="backside-key-flagged"></i>有异常记录</span></div>' +
    '<div class="backside-sequence"><span>实际打线顺序</span><strong class="mono">H <i>→</i> G <i>→</i> L <i>→</i> K <i>→</i> J <i>→</i> I</strong></div>' +
    '<div class="backside-source"><span>位置按所提供的背面图标注</span><a href="assets/backside-reference.png" target="_blank" rel="noopener">查看原图 ↗</a></div>' +
  '</div>';
}
