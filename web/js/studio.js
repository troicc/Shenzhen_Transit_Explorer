// 地铁示意校核工作台。零构建 vanilla JS + SVG。
// 复用共享学习前端的几何原语，保证与 Python 端同算法。
import { clamp, svgEl, distance, pointAtProgress, pathMetrics, pathD, showToast } from '/static/js/learn/core.js';
import { projectPointToPath } from '/static/js/learn/geometry.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const $ = (sel, root = document) => root.querySelector(sel);
const stage = $('#stage');
const viewport = $('#viewport');
const realLayer = $('#realLayer');
const lineLayer = $('#lineLayer');
const handleLayer = $('#handleLayer');
const stationLayer = $('#stationLayer');
const anchorLayer = $('#anchorLayer');
const labelLayer = $('#labelLayer');

// 换乘锚点站名归一化，须与 Python matcher.normalize_name 一致
function normName(value) {
  let t = String(value || '').normalize('NFKC').trim().toLowerCase();
  t = t.replace(/[\s·•・（）()【】\[\]_-]+/g, '');
  for (const tok of ['深圳市', '深圳地铁', '地铁站', '地铁', '站']) t = t.split(tok).join('');
  if (t === '深圳北站') t = '深圳北';
  if (t === '机场北站') t = '机场北';
  return t;
}

const state = {
  lines: [],            // forward routes
  anchors: {},          // key -> {name,x,y,lines}
  anchorLinks: {},      // key -> [{lineId, vIdx, stopIdx}]
  alpha: 0.55,
  view: { panX: 0, panY: 0, zoom: 1 },
  size: { w: 0, h: 0 },
  layers: { real: false, sch: true, stations: true, anchors: true, labels: false, handles: false },
  selected: null,       // {type, id, idx?}
  dragging: null,
  undo: [],
  redo: [],
  revision: null,
};
const layoutChannel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('transit.metro.layout');

const lineEls = {};     // id -> {group, casing, line, hit}
const stationEls = {};  // id -> [circle, ...]
const anchorEls = {};   // key -> {group, ring, hit}
const realEls = {};     // id -> path

const lineById = (id) => state.lines.find((l) => l.id === id);

// ---------------------------------------------------------------------------
// 视口变换：世界坐标 y 已朝南增大（与屏幕一致，因 build_network normalize 用 max_y-y），直接烘焙 (wx, wy)
// ---------------------------------------------------------------------------

function applyTransform() {
  const { panX, panY, zoom } = state.view;
  viewport.setAttribute('transform', `translate(${panX} ${panY}) scale(${zoom})`);
  $('#hud').textContent = `缩放 ${zoom.toFixed(2)}× · 拖背景平移 · 滚轮缩放`;
  updateDiag();
}

function svgPoint(evt) {
  const rect = stage.getBoundingClientRect();
  return [evt.clientX - rect.left, evt.clientY - rect.top];
}

function screenToWorld(sx, sy) {
  const { panX, panY, zoom } = state.view;
  return [(sx - panX) / zoom, (sy - panY) / zoom];
}

function zoomAt(sx, sy, factor) {
  const { panX, panY, zoom } = state.view;
  const newZoom = clamp(zoom * factor, 0.05, 40);
  if (newZoom === zoom) return;
  const [wx, wy] = [(sx - panX) / zoom, (sy - panY) / zoom];
  state.view.zoom = newZoom;
  state.view.panX = sx - wx * newZoom;
  state.view.panY = sy - wy * newZoom;
  applyTransform();
}

function fitView() {
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  for (const line of state.lines) {
    for (const p of line.schematic.path) {
      if (p[0] < minx) minx = p[0]; if (p[0] > maxx) maxx = p[0];
      if (p[1] < miny) miny = p[1]; if (p[1] > maxy) maxy = p[1];
    }
  }
  if (!isFinite(minx)) return;
  const pad = 80;
  const { w, h } = state.size;
  const zx = (w - pad * 2) / Math.max(1, maxx - minx);
  const zy = (h - pad * 2) / Math.max(1, maxy - miny);
  const zoom = clamp(Math.min(zx, zy), 0.05, 40);
  const cx = (minx + maxx) / 2;
  const cy = (miny + maxy) / 2;
  state.view.zoom = zoom;
  state.view.panX = w / 2 - cx * zoom;
  state.view.panY = h / 2 - cy * zoom;
  applyTransform();
}

// ---------------------------------------------------------------------------
// 几何辅助
// ---------------------------------------------------------------------------

function stationPos(line, idx) {
  return pointAtProgress(line.schematic.path, line.schematic.station_progress[idx]);
}

function nearestVertex(path, pos) {
  let best = 0;
  let bd = Infinity;
  for (let i = 0; i < path.length; i++) {
    const d = (path[i][0] - pos[0]) ** 2 + (path[i][1] - pos[1]) ** 2;
    if (d < bd) { bd = d; best = i; }
  }
  return { index: best, dist: Math.sqrt(bd) };
}

function buildAnchorLinks() {
  state.anchorLinks = {};
  for (const [key, anchor] of Object.entries(state.anchors)) {
    state.anchorLinks[key] = [];
    for (const line of state.lines) {
      const stopIdx = line.stops.findIndex((s) => normName(s.name) === key);
      if (stopIdx < 0) continue;
      const pos = stationPos(line, stopIdx);
      const nv = nearestVertex(line.schematic.path, pos);
      state.anchorLinks[key].push({ lineId: line.id, vIdx: nv.index, stopIdx });
    }
  }
}

function monotonize(progress) {
  for (let i = 1; i < progress.length; i++) progress[i] = Math.max(progress[i], progress[i - 1] + 1e-9);
  progress[progress.length - 1] = 1;
  return progress;
}

// α 混合重排站距（与 Python _route_schematic 同算法）
function reflowAlpha(alpha) {
  state.alpha = alpha;
  for (const line of state.lines) {
    const path = line.schematic.path;
    const stops = line.stops;
    const n = stops.length;
    const sp = new Array(n).fill(0);
    const anchorIdx = [];
    for (let i = 0; i < n; i++) {
      const key = normName(stops[i].name);
      if (i === 0 || i === n - 1 || state.anchors[key]) anchorIdx.push(i);
    }
    const arcOf = anchorIdx.map((idx) => {
      const key = normName(stops[idx].name);
      const pos = state.anchors[key] ? [state.anchors[key].x, state.anchors[key].y]
        : idx === 0 ? path[0] : path[path.length - 1];
      return projectPointToPath(path, pos).progress;
    });
    for (let k = 0; k < anchorIdx.length - 1; k++) {
      const aIdx = anchorIdx[k];
      const bIdx = anchorIdx[k + 1];
      const rpA = stops[aIdx].progress;
      const rpB = stops[bIdx].progress;
      const arcA = arcOf[k];
      const arcB = arcOf[k + 1];
      const spanLen = bIdx - aIdx + 1;
      for (let j = 0; j < spanLen; j++) {
        const sidx = aIdx + j;
        const realRel = rpB > rpA ? clamp((stops[sidx].progress - rpA) / (rpB - rpA), 0, 1) : 0;
        const evenRel = spanLen > 1 ? j / (spanLen - 1) : 0;
        sp[sidx] = arcA + (alpha * realRel + (1 - alpha) * evenRel) * (arcB - arcA);
      }
    }
    line.schematic.station_progress = monotonize(sp);
  }
}

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------

function pathDWorld(path) {
  return pathD(path);
}

function clearLayer(layer) {
  while (layer.firstChild) layer.removeChild(layer.firstChild);
}

function renderLines() {
  clearLayer(lineLayer);
  clearLayer(realLayer);
  for (const k in lineEls) delete lineEls[k];
  for (const k in realEls) delete realEls[k];
  const muted = !!state.selected && state.selected.type !== 'anchor';
  for (const line of state.lines) {
    if (!line.visible) continue;
    const d = pathDWorld(line.schematic.path);
    if (state.layers.real) {
      const rp = svgEl('path', { class: 'real-line', d: pathDWorld(line.real_path || []) });
      realLayer.appendChild(rp);
      realEls[line.id] = rp;
    }
    const group = svgEl('g', { class: 'route-group' });
    const casing = svgEl('path', { class: 'route-casing', d });
    const isSel = state.selected && state.selected.id === line.id;
    const linePath = svgEl('path', {
      class: 'route-line' + (muted && !isSel ? ' muted' : '') + (isSel ? ' selected' : ''),
      d, stroke: line.color || '#888',
    });
    const hit = svgEl('path', { class: 'route-hit', d, 'data-line': line.id });
    group.append(casing, linePath, hit);
    lineLayer.appendChild(group);
    lineEls[line.id] = { group, casing, line: linePath, hit };
  }
  realLayer.style.display = state.layers.real ? '' : 'none';
  lineLayer.style.display = state.layers.sch ? '' : 'none';
}

function renderStations() {
  clearLayer(stationLayer);
  for (const k in stationEls) delete stationEls[k];
  stationLayer.style.display = state.layers.stations ? '' : 'none';
  if (!state.layers.stations) return;
  const muted = !!state.selected && state.selected.type !== 'anchor';
  for (const line of state.lines) {
    if (!line.visible) continue;
    const isSel = state.selected && state.selected.id === line.id;
    stationEls[line.id] = [];
    for (let i = 0; i < line.stops.length; i++) {
      const key = normName(line.stops[i].name);
      const isTransfer = !!state.anchors[key];
      const [x, y] = stationPos(line, i);
      const sel = state.selected && state.selected.type === 'station' && state.selected.id === line.id && state.selected.idx === i;
      const c = svgEl('circle', {
        class: 'station' + (isTransfer ? ' transfer' : '') + (sel ? ' selected' : ''),
        cx: x, cy: y, r: isTransfer ? 5.5 : 4,
        'data-line': line.id, 'data-idx': i,
        opacity: muted && !isSel ? 0.3 : 1,
      });
      stationLayer.appendChild(c);
      stationEls[line.id].push(c);
    }
  }
}

function renderAnchors() {
  clearLayer(anchorLayer);
  for (const k in anchorEls) delete anchorEls[k];
  anchorLayer.style.display = state.layers.anchors ? '' : 'none';
  if (!state.layers.anchors) return;
  for (const [key, anchor] of Object.entries(state.anchors)) {
    const group = svgEl('g', { class: 'anchor-group', 'data-key': key });
    const ring = svgEl('circle', { class: 'anchor-ring', cx: anchor.x, cy: anchor.y, r: 9 });
    const hit = svgEl('circle', { class: 'anchor-hit', cx: anchor.x, cy: anchor.y, r: 16, 'data-key': key });
    group.append(ring, hit);
    anchorLayer.appendChild(group);
    anchorEls[key] = { group, ring, hit };
  }
}

function renderLabels() {
  clearLayer(labelLayer);
  labelLayer.style.display = state.layers.labels ? '' : 'none';
  if (!state.layers.labels) return;
  for (const line of state.lines) {
    if (!line.visible) continue;
    for (let i = 0; i < line.stops.length; i++) {
      const [wx, wy] = stationPos(line, i);
      const t = svgEl('text', { class: 'station-label', x: wx + 7, y: wy - 6 });
      t.textContent = line.stops[i].name;
      labelLayer.appendChild(t);
    }
  }
}

function renderHandles() {
  clearLayer(handleLayer);
  handleLayer.style.display = state.layers.handles ? '' : 'none';
  if (!state.layers.handles) return;
  const line = state.selected && state.selected.type === 'line' ? lineById(state.selected.id) : null;
  if (!line) return;
  line.schematic.path.forEach((p, i) => {
    const r = svgEl('rect', {
      class: 'handle', x: p[0] - 4, y: p[1] - 4, width: 8, height: 8, rx: 2,
      'data-line': line.id, 'data-v': i,
    });
    handleLayer.appendChild(r);
  });
}

function render() {
  renderLines();
  renderStations();
  renderAnchors();
  renderLabels();
  renderHandles();
  renderLineList();
  renderInspector();
  updateDiag();
}

// 增量更新（拖拽热路径，避免整层重建）
function updateLineGeometry(line) {
  const els = lineEls[line.id];
  if (els) {
    const d = pathDWorld(line.schematic.path);
    els.casing.setAttribute('d', d);
    els.line.setAttribute('d', d);
    els.hit.setAttribute('d', d);
  }
  const arr = stationEls[line.id];
  if (arr) {
    for (let i = 0; i < arr.length; i++) {
      const [wx, wy] = stationPos(line, i);
      arr[i].setAttribute('cx', wx);
      arr[i].setAttribute('cy', wy);
    }
  }
}

function updateAnchorNode(key) {
  const a = state.anchors[key];
  const el = anchorEls[key];
  if (!el) return;
  el.ring.setAttribute('cx', a.x);
  el.ring.setAttribute('cy', a.y);
  el.hit.setAttribute('cx', a.x);
  el.hit.setAttribute('cy', a.y);
}

// ---------------------------------------------------------------------------
// 选择 / 检查器 / 线路列表 / 诊断
// ---------------------------------------------------------------------------

function select(payload) {
  state.selected = payload;
  render();
}

function renderLineList() {
  const ul = $('#lineList');
  ul.innerHTML = '';
  for (const line of state.lines) {
    const li = document.createElement('li');
    li.dataset.id = line.id;
    if (state.selected && state.selected.id === line.id) li.classList.add('selected');
    if (!line.visible) li.classList.add('dim');
    li.innerHTML = `<span class="swatch" style="background:${line.color || '#888'}"></span><span class="name">${line.route_no}</span>`;
    li.addEventListener('click', () => {
      if (state.selected && state.selected.id === line.id) select(null);
      else select({ type: 'line', id: line.id });
    });
    ul.appendChild(li);
  }
  const fwd = state.lines;
  const hubCount = Object.keys(state.anchors).length;
  $('#stats').textContent = `${fwd.length} 条线路 · ${hubCount} 个换乘锚点 · α ${state.alpha.toFixed(2)}`;
}

function renderInspector() {
  const body = $('#inspectBody');
  const s = state.selected;
  if (!s) { body.innerHTML = '点选元素查看详情'; return; }
  if (s.type === 'anchor') {
    const a = state.anchors[s.id];
    body.innerHTML = `<div style="font-weight:600;font-size:14px">${a.name}</div>
      <dl><dt>类型</dt><dd>换乘锚点</dd>
      <dt>经过线路</dt><dd>${a.lines.join(' · ')}</dd>
      <dt>坐标</dt><dd>${a.x.toFixed(1)}, ${a.y.toFixed(1)}</dd></dl>`;
  } else if (s.type === 'line') {
    const line = lineById(s.id);
    body.innerHTML = `<div style="font-weight:600;font-size:14px;color:${line.color}">${line.route_no}</div>
      <dl><dt>区间</dt><dd>${line.start_stop} → ${line.end_stop}</dd>
      <dt>站点</dt><dd>${line.stops.length}</dd>
      <dt>骨架折点</dt><dd>${line.schematic.path.length}</dd></dl>`;
  } else if (s.type === 'station') {
    const line = lineById(s.id);
    const st = line.stops[s.idx];
    const key = normName(st.name);
    body.innerHTML = `<div style="font-weight:600;font-size:14px">${st.name}</div>
      <dl><dt>线路</dt><dd>${line.route_no}</dd>
      <dt>换乘</dt><dd>${state.anchors[key] ? '是' : '否'}</dd>
      <dt>progress</dt><dd>${line.schematic.station_progress[s.idx].toFixed(4)}</dd></dl>`;
  }
}

function updateDiag() {
  const el = $('#diag');
  if (!state.layers.stations) { el.textContent = '（站点层已关）'; return; }
  let tight = 0;
  const thr = 16 / state.view.zoom;
  for (const line of state.lines) {
    if (!line.visible) continue;
    const stops = line.stops;
    for (let i = 1; i < stops.length; i++) {
      const a = stationPos(line, i - 1);
      const b = stationPos(line, i);
      if (distance(a, b) < thr) tight++;
    }
  }
  el.innerHTML = tight ? `过近站距：<span class="bad">${tight}</span> 处` : '过近站距：无';
}

// ---------------------------------------------------------------------------
// 撤销 / 重做
// ---------------------------------------------------------------------------

function snapshot() {
  return {
    alpha: state.alpha,
    anchors: JSON.parse(JSON.stringify(state.anchors)),
    lines: state.lines.map((l) => ({
      id: l.id,
      path: l.schematic.path.map((p) => [p[0], p[1]]),
      station_progress: [...l.schematic.station_progress],
    })),
  };
}

function restore(snap) {
  state.alpha = snap.alpha;
  state.anchors = JSON.parse(JSON.stringify(snap.anchors));
  for (const line of state.lines) {
    const s = snap.lines.find((x) => x.id === line.id);
    if (!s) continue;
    line.schematic.path = s.path.map((p) => [p[0], p[1]]);
    line.schematic.station_progress = [...s.station_progress];
  }
  buildAnchorLinks();
  $('#alphaSlider').value = state.alpha;
  $('#alphaVal').textContent = state.alpha.toFixed(2);
  render();
}

function pushUndo() {
  state.undo.push(snapshot());
  if (state.undo.length > 80) state.undo.shift();
  state.redo = [];
  refreshUndoButtons();
}

function undo() {
  if (!state.undo.length) return;
  state.redo.push(snapshot());
  restore(state.undo.pop());
  refreshUndoButtons();
}

function redo() {
  if (!state.redo.length) return;
  state.undo.push(snapshot());
  restore(state.redo.pop());
  refreshUndoButtons();
}

function refreshUndoButtons() {
  $('#undoBtn').disabled = !state.undo.length;
  $('#redoBtn').disabled = !state.redo.length;
}

// ---------------------------------------------------------------------------
// 指针交互
// ---------------------------------------------------------------------------

stage.addEventListener('pointerdown', (evt) => {
  const tgt = evt.target;
  const key = tgt.getAttribute('data-key');
  const lineId = tgt.getAttribute('data-line');
  const vIdx = tgt.getAttribute('data-v');
  const sIdx = tgt.getAttribute('data-idx');
  stage.setPointerCapture(evt.pointerId);

  if (key) {
    pushUndo();
    select({ type: 'anchor', id: key });
    const [wx, wy] = screenToWorld(...svgPoint(evt));
    state.dragging = { type: 'anchor', key, moved: false, startWorld: [wx, wy] };
    anchorEls[key]?.group.classList.add('dragging');
  } else if (vIdx != null && lineId) {
    pushUndo();
    state.dragging = { type: 'vertex', lineId, vIdx: +vIdx, moved: false };
  } else if (sIdx != null && lineId) {
    state.dragging = { type: 'station', lineId, idx: +sIdx, moved: false, didSelect: false };
  } else if (lineId) {
    select({ type: 'line', id: lineId });
    state.dragging = { type: 'pan', start: svgPoint(evt), pan: { ...state.view }, moved: false };
  } else {
    state.dragging = { type: 'pan', start: svgPoint(evt), pan: { ...state.view }, moved: false };
  }
});

stage.addEventListener('pointermove', (evt) => {
  const d = state.dragging;
  if (!d) return;
  const [sx, sy] = svgPoint(evt);
  if (d.type === 'pan') {
    const dx = sx - d.start[0];
    const dy = sy - d.start[1];
    if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
    state.view.panX = d.pan.panX + dx;
    state.view.panY = d.pan.panY + dy;
    applyTransform();
    return;
  }
  const [wx, wy] = screenToWorld(sx, sy);
  if (d.type === 'anchor') {
    d.moved = true;
    state.anchors[d.key].x = wx;
    state.anchors[d.key].y = wy;
    for (const link of state.anchorLinks[d.key] || []) {
      const line = lineById(link.lineId);
      if (!line) continue;
      line.schematic.path[link.vIdx] = [wx, wy];
      line.schematic.station_progress[link.stopIdx] = projectPointToPath(line.schematic.path, [wx, wy]).progress;
      monotonize(line.schematic.station_progress);
      updateLineGeometry(line);
    }
    updateAnchorNode(d.key);
    updateDiag();
  } else if (d.type === 'vertex') {
    d.moved = true;
    const line = lineById(d.lineId);
    line.schematic.path[d.vIdx] = [wx, wy];
    updateLineGeometry(line);
    renderHandles();
    updateDiag();
  } else if (d.type === 'station') {
    if (!d.didSelect) { d.didSelect = true; pushUndo(); select({ type: 'station', id: d.lineId, idx: d.idx }); }
    const line = lineById(d.lineId);
    const proj = projectPointToPath(line.schematic.path, [wx, wy]);
    line.schematic.station_progress[d.idx] = proj.progress;
    monotonize(line.schematic.station_progress);
    updateLineGeometry(line);
    renderInspector();
    updateDiag();
  }
});

window.addEventListener('pointerup', () => {
  const d = state.dragging;
  if (!d) return;
  if (d.type === 'anchor') anchorEls[d.key]?.group.classList.remove('dragging');
  if (!d.moved && d.type !== 'station') {
    // 纯点击已被 select 处理；若产生空 undo 则丢弃
    state.undo.pop();
    refreshUndoButtons();
  }
  state.dragging = null;
  if (d.type === 'anchor' || d.type === 'vertex') buildAnchorLinks();
});

stage.addEventListener('wheel', (evt) => {
  evt.preventDefault();
  const factor = evt.deltaY < 0 ? 1.15 : 1 / 1.15;
  zoomAt(...svgPoint(evt), factor);
}, { passive: false });

// 双击重置适应
stage.addEventListener('dblclick', () => fitView());

// ---------------------------------------------------------------------------
// UI 控件
// ---------------------------------------------------------------------------

$('#fitBtn').addEventListener('click', () => fitView());
$('#undoBtn').addEventListener('click', undo);
$('#redoBtn').addEventListener('click', redo);

$('#alphaSlider').addEventListener('input', (e) => {
  state.alpha = +e.target.value;
  $('#alphaVal').textContent = state.alpha.toFixed(2);
});
$('#alphaSlider').addEventListener('change', (e) => {
  pushUndo();
  reflowAlpha(+e.target.value);
  render();
});

const layerMap = { real: 'layerReal', sch: 'layerSch', stations: 'layerStations', anchors: 'layerAnchors', labels: 'layerLabels', handles: 'layerHandles' };
for (const [key, elId] of Object.entries(layerMap)) {
  $('#' + elId).addEventListener('change', (e) => {
    state.layers[key] = e.target.checked;
    render();
  });
}

function studioPayload() {
  const payload = {
    alpha: state.alpha,
    lines: {},
    anchors: {},
  };
  for (const line of state.lines) {
    payload.lines[line.layout_key || line.id] = {
      path: line.schematic.path,
      station_progress: line.schematic.station_progress,
    };
  }
  for (const [key, a] of Object.entries(state.anchors)) payload.anchors[key] = { x: a.x, y: a.y };
  return payload;
}

async function saveStudio({preview = false, previewWindow = null} = {}) {
  const buttons = [$('#saveBtn'), $('#previewBtn')];
  buttons.forEach(button => { button.disabled = true; });
  try {
    const res = await fetch('/api/metro/studio', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(studioPayload()),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.detail || '保存失败');
    state.revision = data.revision;
    layoutChannel?.postMessage({type: 'metro-layout-saved', revision: data.revision});
    showToast(`${data.message} · ${data.lines} 线 / ${data.anchors} 锚点`);
    if (preview) {
      const route = state.selected?.id || state.lines[0]?.id;
      const separator = data.learnUrl.includes('?') ? '&' : '?';
      const target = `${data.learnUrl}${route ? `${separator}route=${encodeURIComponent(route)}` : ''}`;
      if (previewWindow) previewWindow.location.replace(target);
      else window.location.assign(target);
    }
    return data;
  } catch (err) {
    previewWindow?.close();
    showToast('保存失败：' + err.message);
    throw err;
  } finally {
    buttons.forEach(button => { button.disabled = false; });
  }
}

$('#saveBtn').addEventListener('click', () => {
  saveStudio().catch(() => {});
});

$('#previewBtn').addEventListener('click', () => {
  const previewWindow = window.open('about:blank', '_blank');
  if (previewWindow) previewWindow.opener = null;
  saveStudio({preview: true, previewWindow}).catch(() => {});
});

$('#exportBtn').addEventListener('click', () => {
  const payload = {
    alpha: state.alpha,
    saved_at: new Date().toISOString(),
    transfer_anchors: state.anchors,
    lines: state.lines.map((l) => ({
      id: l.id, route_no: l.route_no, color: l.color,
      path: l.schematic.path, station_progress: l.schematic.station_progress,
      stops: l.stops,
    })),
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'metro_schematic_layout.json';
  a.click();
  URL.revokeObjectURL(url);
  showToast('已导出 metro_schematic_layout.json');
});

window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    if (e.shiftKey) redo(); else undo();
  } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
    e.preventDefault();
    redo();
  }
});

function resize() {
  const rect = $('#canvasWrap').getBoundingClientRect();
  state.size.w = rect.width;
  state.size.h = rect.height;
  stage.setAttribute('viewBox', `0 0 ${rect.width} ${rect.height}`);
  $('#stageBg').setAttribute('width', rect.width);
  $('#stageBg').setAttribute('height', rect.height);
  applyTransform();
}
window.addEventListener('resize', resize);

// ---------------------------------------------------------------------------
// 载入
// ---------------------------------------------------------------------------

async function load() {
  try {
    const res = await fetch('/api/metro/studio');
    const data = await res.json();
    state.lines = data.routes.map((r) => ({ ...r, visible: true }));
    state.anchors = data.transfer_anchors || {};
    state.alpha = data.alpha ?? 0.55;
    state.revision = data.revision || null;
    $('#alphaSlider').value = state.alpha;
    $('#alphaVal').textContent = state.alpha.toFixed(2);
    buildAnchorLinks();
    resize();
    fitView();
    render();
    if (data.has_layout) showToast('已载入上次保存的校核结果');
  } catch (err) {
    showToast('载入失败：' + err.message);
  }
}

window.addEventListener('pagehide', () => layoutChannel?.close(), {once: true});
load();
