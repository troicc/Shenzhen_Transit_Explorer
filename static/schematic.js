'use strict';

const $ = selector => document.querySelector(selector);
const SVG_NS = 'http://www.w3.org/2000/svg';
const els = {
  stage: $('#mapStage'), canvas: $('#networkCanvas'), svg: $('#routeSvg'), grid: $('#gridRect'),
  routeLayer: $('#selectedRouteLayer'), stationLayer: $('#stationLayer'), labelLayer: $('#labelLayer'), train: $('#train'),
  loading: $('#loading'), hero: $('#hero'), focusCard: $('#focusCard'), stationCard: $('#stationCard'),
  practiceDock: $('#practiceDock'), searchInput: $('#searchInput'), searchResults: $('#searchResults'),
  typeInput: $('#typeInput'), reviewDrawer: $('#reviewDrawer')
};
const ctx = els.canvas.getContext('2d', {alpha: true});

const state = {
  overview: null, route: null, routeMap: new Map(), selectedId: null,
  view: {x: 0, y: 0, w: 10000, h: 6000}, homeView: null,
  schematic: true, balanced: true, allLabels: false, reverse: false,
  currentIndex: 0, mode: 'overview', correct: 0, wrong: 0, timeLeft: 30,
  timer: null, answerLocked: false, broadcasting: false, broadcastToken: 0,
  dragging: false, moved: false, lastX: 0, lastY: 0, searchTimer: null,
  geometryCache: new Map(), pendingStationName: null
};
let currentAudio = null;

function api(url, options) {
  return fetch(url, options).then(async response => {
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.detail || `请求失败 ${response.status}`);
    return body;
  });
}
function svgEl(tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  Object.entries(attrs).forEach(([key, value]) => el.setAttribute(key, String(value)));
  return el;
}
function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
function escapeHtml(text) { return String(text ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
function showToast(text) {
  const toast = $('#toast'); toast.textContent = text; toast.classList.add('show');
  clearTimeout(showToast.timer); showToast.timer = setTimeout(() => toast.classList.remove('show'), 1800);
}
function routeColor(routeNo) {
  let hash = 0; for (const ch of String(routeNo)) hash = ((hash << 5) - hash + ch.charCodeAt(0)) | 0;
  const hue = Math.abs(hash) % 360; return `hsl(${hue} 78% 58%)`;
}
function normalizePinyin(value) { return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }
function distance(a, b) { return Math.hypot(b[0] - a[0], b[1] - a[1]); }
function pathMetrics(points) {
  const cumulative = [0]; let total = 0;
  for (let i = 1; i < points.length; i++) { total += distance(points[i - 1], points[i]); cumulative.push(total); }
  return {cumulative, total};
}
function pointAtProgress(points, progress) {
  if (!points.length) return [0, 0]; if (points.length === 1) return points[0];
  const {cumulative, total} = pathMetrics(points); const target = clamp(progress, 0, 1) * total;
  for (let i = 1; i < points.length; i++) {
    if (cumulative[i] >= target) {
      const span = cumulative[i] - cumulative[i - 1] || 1;
      const t = (target - cumulative[i - 1]) / span;
      return [points[i - 1][0] + (points[i][0] - points[i - 1][0]) * t,
              points[i - 1][1] + (points[i][1] - points[i - 1][1]) * t];
    }
  }
  return points[points.length - 1];
}
function bboxOf(points) {
  if (!points.length) return [0, 0, 100, 100];
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  points.forEach(([x, y]) => { minx = Math.min(minx, x); miny = Math.min(miny, y); maxx = Math.max(maxx, x); maxy = Math.max(maxy, y); });
  return [minx, miny, maxx, maxy];
}
function pointSegmentDistance(p, a, b) {
  const vx = b[0] - a[0], vy = b[1] - a[1], denom = vx * vx + vy * vy;
  const t = denom ? clamp(((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / denom, 0, 1) : 0;
  return Math.hypot(p[0] - (a[0] + t * vx), p[1] - (a[1] + t * vy));
}
function rdp(points, tolerance) {
  if (points.length <= 2) return points.slice();
  let max = 0, index = -1;
  for (let i = 1; i < points.length - 1; i++) {
    const d = pointSegmentDistance(points[i], points[0], points[points.length - 1]);
    if (d > max) { max = d; index = i; }
  }
  if (max <= tolerance || index < 0) return [points[0], points[points.length - 1]];
  const left = rdp(points.slice(0, index + 1), tolerance);
  const right = rdp(points.slice(index), tolerance);
  return left.slice(0, -1).concat(right);
}
function capPoints(points, maxPoints) {
  if (points.length <= maxPoints) return points;
  const out = []; for (let i = 0; i < maxPoints; i++) out.push(points[Math.round(i * (points.length - 1) / (maxPoints - 1))]);
  return out;
}
function buildOctilinear(points) {
  if (points.length < 2) return points.slice();
  const box = bboxOf(points), diag = Math.hypot(box[2] - box[0], box[3] - box[1]);
  const simplified = capPoints(rdp(points, Math.max(10, diag * 0.018)), 24);
  const out = [[0, 0]];
  for (let i = 1; i < simplified.length; i++) {
    const dx = simplified[i][0] - simplified[i - 1][0], dy = simplified[i][1] - simplified[i - 1][1];
    const length = Math.max(distance(simplified[i - 1], simplified[i]), diag * 0.015);
    const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
    const prev = out[out.length - 1]; out.push([prev[0] + Math.cos(angle) * length, prev[1] + Math.sin(angle) * length]);
  }
  return out;
}
function routeGeometry() {
  if (!state.route) return null;
  const key = `${state.route.id}:${state.schematic ? 'schematic' : 'geo'}`;
  let path = state.geometryCache.get(key);
  if (!path) {
    path = state.schematic ? buildOctilinear(state.route.path || []) : (state.route.path || []).map(p => [p[0], p[1]]);
    state.geometryCache.set(key, path);
  }
  const stopPoints = state.route.stops.map((stop, index) => {
    const progress = state.balanced && state.schematic ? index / Math.max(1, state.route.stops.length - 1) : Number(stop.progress || 0);
    return pointAtProgress(path, progress);
  });
  return {path, stopPoints, bbox: bboxOf(path)};
}
function displayStops() { return !state.route ? [] : (state.reverse ? [...state.route.stops].reverse() : state.route.stops); }
function originalIndex(displayIndex = state.currentIndex) { return state.reverse ? state.route.stops.length - 1 - displayIndex : displayIndex; }
function currentStation() { const stops = displayStops(); return stops[state.currentIndex] || null; }
function currentPoint() { const geometry = routeGeometry(); return geometry ? geometry.stopPoints[originalIndex()] : [0, 0]; }
function currentVisualProgress() {
  if (!state.route) return 0; const index = originalIndex();
  return state.balanced && state.schematic ? index / Math.max(1, state.route.stops.length - 1) : Number(state.route.stops[index].progress || 0);
}

function resize() {
  const rect = els.stage.getBoundingClientRect(), dpr = Math.min(window.devicePixelRatio || 1, 2);
  els.canvas.width = Math.round(rect.width * dpr); els.canvas.height = Math.round(rect.height * dpr);
  els.canvas.style.width = `${rect.width}px`; els.canvas.style.height = `${rect.height}px`;
  drawNetwork(); applyView();
}
function applyView() {
  const v = state.view; els.svg.setAttribute('viewBox', `${v.x} ${v.y} ${v.w} ${v.h}`);
  els.grid.setAttribute('x', v.x); els.grid.setAttribute('y', v.y); els.grid.setAttribute('width', v.w); els.grid.setAttribute('height', v.h);
}
function fitBox(box, padding = .12) {
  const rect = els.stage.getBoundingClientRect(); let [minx, miny, maxx, maxy] = box;
  let w = Math.max(50, maxx - minx), h = Math.max(50, maxy - miny); w *= 1 + padding * 2; h *= 1 + padding * 2;
  const aspect = Math.max(.1, rect.width / Math.max(1, rect.height));
  if (w / h < aspect) w = h * aspect; else h = w / aspect;
  state.view = {x: (minx + maxx - w) / 2, y: (miny + maxy - h) / 2, w, h}; applyView(); drawNetwork();
}
function fitHome() {
  const world = state.overview.world, box = [0, 0, world.width, world.height]; state.homeView = {...state.view}; fitBox(box, .035); state.homeView = {...state.view};
}
function worldFromClient(clientX, clientY) {
  const rect = els.stage.getBoundingClientRect(); return [state.view.x + (clientX - rect.left) / rect.width * state.view.w, state.view.y + (clientY - rect.top) / rect.height * state.view.h];
}
function drawNetwork() {
  const rect = els.stage.getBoundingClientRect(), dpr = Math.min(window.devicePixelRatio || 1, 2);
  ctx.setTransform(1,0,0,1,0,0); ctx.clearRect(0,0,els.canvas.width,els.canvas.height);
  if (!state.overview || (state.route && state.schematic)) { els.canvas.style.opacity = state.route ? '.04' : '1'; return; }
  els.canvas.style.opacity = state.route ? '.25' : '1';
  ctx.setTransform(dpr * rect.width / state.view.w, 0, 0, dpr * rect.height / state.view.h, -state.view.x * dpr * rect.width / state.view.w, -state.view.y * dpr * rect.height / state.view.h);
  const px = state.view.w / Math.max(1, rect.width); ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.strokeStyle = state.route ? 'rgba(122,151,184,.12)' : 'rgba(126,157,190,.22)'; ctx.lineWidth = px * (state.route ? 1 : 1.25);
  ctx.beginPath();
  for (const route of state.overview.routes) {
    const path = route.path || []; if (path.length < 2) continue;
    ctx.moveTo(path[0][0], path[0][1]); for (let i = 1; i < path.length; i++) ctx.lineTo(path[i][0], path[i][1]);
  }
  ctx.stroke();
}
function pathD(points) { return points.map((p, i) => `${i ? 'L' : 'M'} ${p[0].toFixed(2)} ${p[1].toFixed(2)}`).join(' '); }
function renderRoute() {
  els.routeLayer.innerHTML = ''; els.stationLayer.innerHTML = ''; els.labelLayer.innerHTML = '';
  if (!state.route) { els.train.setAttribute('opacity', '0'); return; }
  const geometry = routeGeometry(), d = pathD(geometry.path), color = routeColor(state.route.route_no);
  const casing = svgEl('path', {d, class: 'route-casing'}), line = svgEl('path', {d, class: 'route-color', stroke: color});
  const progress = svgEl('path', {d, class: 'route-progress', pathLength: 1, 'stroke-dasharray': `${currentVisualProgress()} 1`});
  const hit = svgEl('path', {d, class: 'route-hit'}); els.routeLayer.append(casing, line, progress, hit);
  state.route.stops.forEach((stop, index) => {
    const [x, y] = geometry.stopPoints[index], g = svgEl('g', {class: `station${stop.transfer ? ' transfer' : ''}${index === originalIndex() ? ' is-current' : ''}`});
    const circle = svgEl('circle', {class: 'station-core', cx: x, cy: y, r: stop.transfer ? 5.1 : 3.4});
    g.append(circle); g.addEventListener('click', event => { event.stopPropagation(); state.currentIndex = state.reverse ? state.route.stops.length - 1 - index : index; renderDynamic(); });
    els.stationLayer.append(g);
    const showLabel = state.allLabels || state.route.stops.length <= 35 || stop.transfer || index === 0 || index === state.route.stops.length - 1 || index === originalIndex() || index % Math.ceil(state.route.stops.length / 18) === 0;
    if (showLabel) {
      const text = svgEl('text', {class: `station-label${index === originalIndex() ? '' : ' secondary'}`, x: x + 8, y: y - 8}); text.textContent = stop.name; els.labelLayer.append(text);
    }
  });
  positionTrain();
}
function positionTrain() {
  if (!state.route) { els.train.setAttribute('opacity', '0'); return; }
  const [x, y] = currentPoint(); els.train.setAttribute('transform', `translate(${x} ${y})`); els.train.setAttribute('opacity', '1');
}
function renderFocusCard() {
  const visible = !!state.route; els.focusCard.classList.toggle('visible', visible); els.hero.classList.toggle('hidden', visible);
  if (!visible) return;
  const color = routeColor(state.route.route_no); $('#lineBadge').textContent = state.route.route_no; $('#lineBadge').style.background = color;
  $('#focusLineName').textContent = state.route.name; $('#focusTerminals').textContent = `${state.route.start_stop} → ${state.route.end_stop}`;
  $('#lineMeta').textContent = `${state.route.stops.length} 站 · ${state.route.operator || '运营企业未注明'} · 匹配 ${(Number(state.route.score || 0) * 100).toFixed(0)}%`;
  $('#forwardBtn').classList.toggle('active', !state.reverse); $('#reverseBtn').classList.toggle('active', state.reverse);
  $('#broadcastBtn').textContent = state.broadcasting ? '■ 停止播报' : '▶ 全线播报';
  $('#schematicToggle').checked = state.schematic; $('#balancedToggle').checked = state.balanced; $('#allLabelsToggle').checked = state.allLabels;
}
function renderStationCard() {
  const station = currentStation(); els.stationCard.classList.toggle('visible', !!station); if (!station) return;
  $('#stationName').textContent = station.name; $('#stationSubtitle').textContent = `${state.route.route_no} · ${state.route.direction_label} · 第 ${state.currentIndex + 1} 站`;
  $('#stationPinyin').textContent = `拼音：${station.pinyin || '待校核'}`;
  $('#stationAudioState').textContent = `粤语：${station.audioUrl ? '自定义音频 URL' : '系统 zh-HK 语音'}`;
  const lines = $('#stationLines'); lines.innerHTML = ''; (station.route_nos || [state.route.route_no]).slice(0, 12).forEach(no => { const chip = document.createElement('span'); chip.className = 'mini-line'; chip.textContent = no; lines.append(chip); });
  renderReviewPanel();
}
function renderPracticePinyin() {
  const station = currentStation(), box = $('#practicePinyin'); box.innerHTML = ''; if (!station) return;
  const typed = normalizePinyin(els.typeInput.value); let consumed = 0;
  String(station.pinyin || '待校核').split(/\s+/).filter(Boolean).forEach(token => {
    const span = document.createElement('span'), normalized = normalizePinyin(token); span.textContent = token;
    if (typed.length >= consumed + normalized.length) span.classList.add('matched'); else if (typed.length > consumed) span.classList.add('active');
    consumed += normalized.length; box.append(span);
  });
}
function renderPractice() {
  const active = state.mode !== 'overview' && !!state.route; els.practiceDock.classList.toggle('visible', active); document.body.classList.toggle('practice-on', active);
  if (!active) return;
  const station = currentStation(); $('#practiceStation').textContent = station ? station.name : '—'; $('#timeStat').textContent = state.mode === 'timed' ? state.timeLeft : '∞';
  $('#correctStat').textContent = state.correct; const attempts = state.correct + state.wrong; $('#accuracyStat').textContent = attempts ? `${Math.round(state.correct / attempts * 100)}%` : '—';
  $('#progressBar').style.width = `${state.route ? (state.currentIndex + 1) / state.route.stops.length * 100 : 0}%`; renderPracticePinyin();
}
function renderModes() { document.querySelectorAll('.mode-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.mode === state.mode)); }
function renderDynamic() { renderRoute(); renderFocusCard(); renderStationCard(); renderPractice(); renderModes(); }
function renderAll() { drawNetwork(); renderDynamic(); applyView(); }

async function selectRoute(routeId, stationName = null) {
  stopBroadcast(true); try {
    const route = await api(`/api/schematic/route/${encodeURIComponent(routeId)}`); state.route = route; state.selectedId = routeId; state.reverse = false; state.currentIndex = 0; state.mode = 'overview'; state.correct = 0; state.wrong = 0; state.geometryCache.clear();
    if (stationName) { const index = route.stops.findIndex(stop => stop.name === stationName); if (index >= 0) state.currentIndex = index; }
    fitBox(routeGeometry().bbox, .17); renderAll();
  } catch (error) { showToast(error.message); }
}
function clearSelection() {
  stopBroadcast(true); clearInterval(state.timer); state.timer = null; state.route = null; state.selectedId = null; state.mode = 'overview'; state.currentIndex = 0; state.geometryCache.clear();
  if (state.homeView) state.view = {...state.homeView}; renderAll();
}
function setMode(mode) {
  if (mode !== 'overview' && !state.route) { showToast('请先选择一条线路'); return; }
  clearInterval(state.timer); state.timer = null; state.mode = mode; state.correct = 0; state.wrong = 0; state.currentIndex = 0; state.answerLocked = false; els.typeInput.value = '';
  if (mode === 'timed') {
    state.timeLeft = 30; state.timer = setInterval(() => { state.timeLeft -= 1; renderPractice(); if (state.timeLeft <= 0) { clearInterval(state.timer); state.timer = null; state.answerLocked = true; $('#feedback').className = 'feedback'; $('#feedback').textContent = `时间到：答对 ${state.correct} 站`; } }, 1000);
  }
  renderDynamic(); if (mode !== 'overview') setTimeout(() => els.typeInput.focus(), 80);
}
function advancePractice() {
  if (!state.route) return; if (state.currentIndex >= state.route.stops.length - 1) { state.currentIndex = 0; if (state.mode === 'full') showToast('全线完成，重新从起点开始'); } else state.currentIndex += 1;
  els.typeInput.value = ''; state.answerLocked = false; renderDynamic(); els.typeInput.focus();
}
function completeTyping() {
  if (state.answerLocked) return; state.answerLocked = true; state.correct += 1; els.typeInput.classList.add('correct'); $('#feedback').className = 'feedback ok'; $('#feedback').textContent = `正确：${currentStation().name} · ${currentStation().pinyin}`;
  playStationAudio(currentStation()).catch(() => {}); setTimeout(() => { els.typeInput.classList.remove('correct'); advancePractice(); }, 520);
}
function handleTyping() {
  renderPracticePinyin(); if (state.answerLocked || !currentStation()) return;
  const expected = normalizePinyin(currentStation().pinyin), typed = normalizePinyin(els.typeInput.value);
  if (expected && typed === expected) completeTyping();
}
function markWrong() { state.wrong += 1; els.typeInput.classList.add('wrong'); $('#feedback').className = 'feedback bad'; $('#feedback').textContent = '拼音未完整匹配'; setTimeout(() => els.typeInput.classList.remove('wrong'), 360); renderPractice(); }

function openAudioDb() {
  return new Promise((resolve, reject) => { const req = indexedDB.open('zhanyue-bus-audio', 1); req.onupgradeneeded = () => req.result.createObjectStore('stations'); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
}
async function getLocalAudio(name) { const db = await openAudioDb(); return new Promise((resolve, reject) => { const req = db.transaction('stations').objectStore('stations').get(name); req.onsuccess = () => resolve(req.result || null); req.onerror = () => reject(req.error); }); }
async function putLocalAudio(name, blob) { const db = await openAudioDb(); return new Promise((resolve, reject) => { const tx = db.transaction('stations', 'readwrite'); tx.objectStore('stations').put(blob, name); tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); }); }
async function deleteLocalAudio(name) { const db = await openAudioDb(); return new Promise((resolve, reject) => { const tx = db.transaction('stations', 'readwrite'); tx.objectStore('stations').delete(name); tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); }); }
function stopCurrentPlayback() { if (currentAudio) { currentAudio.pause(); currentAudio.src = ''; currentAudio = null; } if ('speechSynthesis' in window) speechSynthesis.cancel(); }
function playBlob(blob) { return new Promise((resolve, reject) => { const url = URL.createObjectURL(blob); currentAudio = new Audio(url); currentAudio.onended = () => { URL.revokeObjectURL(url); currentAudio = null; resolve(); }; currentAudio.onerror = () => { URL.revokeObjectURL(url); currentAudio = null; reject(new Error('音频播放失败')); }; currentAudio.play().catch(reject); }); }
function playUrl(url) { return new Promise((resolve, reject) => { currentAudio = new Audio(url); currentAudio.onended = () => { currentAudio = null; resolve(); }; currentAudio.onerror = () => { currentAudio = null; reject(new Error('音频 URL 无法播放')); }; currentAudio.play().catch(reject); }); }
function speakSystem(name) {
  return new Promise((resolve, reject) => {
    if (!('speechSynthesis' in window)) { reject(new Error('浏览器不支持系统语音')); return; }
    speechSynthesis.cancel(); const utter = new SpeechSynthesisUtterance(name); const voices = speechSynthesis.getVoices();
    utter.voice = voices.find(v => /^zh-HK$/i.test(v.lang)) || voices.find(v => /^(yue|zh-HK)/i.test(v.lang)) || voices.find(v => /^zh/i.test(v.lang)) || null;
    utter.lang = utter.voice?.lang || 'zh-HK'; utter.rate = .82; utter.onend = resolve; utter.onerror = () => reject(new Error('系统语音播放失败')); speechSynthesis.speak(utter);
  });
}
async function playStationAudio(station) {
  if (!station) return; stopCurrentPlayback();
  const local = await getLocalAudio(station.name).catch(() => null); if (local) return playBlob(local);
  if (station.audioUrl) { try { return await playUrl(station.audioUrl); } catch (_) {} }
  return speakSystem(station.name);
}
async function startBroadcast() {
  if (!state.route || state.broadcasting) return; state.broadcasting = true; const token = ++state.broadcastToken; renderFocusCard();
  const stops = displayStops();
  for (let i = 0; i < stops.length && state.broadcasting && token === state.broadcastToken; i++) {
    state.currentIndex = i; renderDynamic(); try { await playStationAudio(stops[i]); } catch (_) {} await new Promise(resolve => setTimeout(resolve, 260));
  }
  if (token === state.broadcastToken) { state.broadcasting = false; renderFocusCard(); showToast('全线播报完成'); }
}
function stopBroadcast(silent = false) { if (!state.broadcasting && !currentAudio) return; state.broadcasting = false; state.broadcastToken += 1; stopCurrentPlayback(); renderFocusCard(); if (!silent) showToast('已停止播报'); }

async function performSearch(query) {
  if (!query.trim()) { els.searchResults.classList.remove('visible'); return; }
  try {
    const data = await api(`/api/search?q=${encodeURIComponent(query.trim())}&limit=30`); els.searchResults.innerHTML = '';
    data.results.forEach(item => { const button = document.createElement('button'); button.className = 'search-result'; button.innerHTML = `<strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(item.subtitle)}</span>`; button.addEventListener('click', () => { els.searchResults.classList.remove('visible'); els.searchInput.value = item.title; if (item.type === 'route') selectRoute(item.id); else if (item.route_ids?.length) selectRoute(item.route_ids[0], item.title); }); els.searchResults.append(button); });
    if (!data.results.length) els.searchResults.innerHTML = '<button class="search-result"><span>没有找到结果</span></button>'; els.searchResults.classList.add('visible');
  } catch (error) { showToast(error.message); }
}
function nearestOverviewRoute(point) {
  if (!state.overview || state.route && state.schematic) return null; const rect = els.stage.getBoundingClientRect(), threshold = state.view.w / rect.width * 10; let best = null, bestDistance = threshold;
  for (const route of state.overview.routes) {
    const path = route.path || []; for (let i = 1; i < path.length; i++) { const d = pointSegmentDistance(point, path[i - 1], path[i]); if (d < bestDistance) { bestDistance = d; best = route; } }
  }
  return best;
}

function renderReviewPanel() {
  const station = currentStation(); if (!station) return;
  $('#reviewStationName').textContent = station.name; if (document.activeElement !== $('#reviewPinyin')) $('#reviewPinyin').value = station.pinyin || '';
  if (document.activeElement !== $('#reviewAudioUrl')) $('#reviewAudioUrl').value = station.audioUrl || ''; if (document.activeElement !== $('#reviewNote')) $('#reviewNote').value = station.reviewNote || '';
  getLocalAudio(station.name).then(blob => { $('#localAudioState').textContent = blob ? `已设置本机音频 · ${Math.round(blob.size / 1024)} KB` : '未设置本机音频'; }).catch(() => {});
}
async function saveLanguage() {
  const station = currentStation(); if (!station) return;
  try {
    const data = await api('/api/schematic/language', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({name: station.name, pinyin: $('#reviewPinyin').value, audio_url: $('#reviewAudioUrl').value, note: $('#reviewNote').value})});
    state.route.stops.filter(stop => stop.name === station.name).forEach(stop => { stop.pinyin = data.item.pinyin; stop.pinyin_source = data.item.pinyin_source; stop.audioUrl = data.item.audio_url; stop.reviewNote = data.item.note; });
    renderDynamic(); showToast('站点语言设置已保存');
  } catch (error) { showToast(error.message); }
}

// UI controls
document.querySelectorAll('.mode-btn').forEach(button => button.addEventListener('click', () => setMode(button.dataset.mode)));
$('#homeBtn').addEventListener('click', clearSelection); $('#startBtn').addEventListener('click', () => setMode('full'));
$('#forwardBtn').addEventListener('click', () => { if (!state.reverse) return; const name = currentStation()?.name; state.reverse = false; state.currentIndex = Math.max(0, state.route.stops.findIndex(stop => stop.name === name)); renderDynamic(); });
$('#reverseBtn').addEventListener('click', () => { if (state.reverse) return; const name = currentStation()?.name; state.reverse = true; const original = state.route.stops.findIndex(stop => stop.name === name); state.currentIndex = state.route.stops.length - 1 - Math.max(0, original); renderDynamic(); });
$('#broadcastBtn').addEventListener('click', () => state.broadcasting ? stopBroadcast() : startBroadcast());
$('#speakBtn').addEventListener('click', () => playStationAudio(currentStation()).catch(error => showToast(error.message)));
$('#locateBtn').addEventListener('click', () => { if (!state.route) return; const [x, y] = currentPoint(); state.view.x = x - state.view.w / 2; state.view.y = y - state.view.h / 2; applyView(); drawNetwork(); });
$('#schematicToggle').addEventListener('change', event => { state.schematic = event.target.checked; state.geometryCache.clear(); if (state.route) fitBox(routeGeometry().bbox, .17); renderAll(); });
$('#balancedToggle').addEventListener('change', event => { state.balanced = event.target.checked; renderDynamic(); });
$('#allLabelsToggle').addEventListener('change', event => { state.allLabels = event.target.checked; renderRoute(); });
els.typeInput.addEventListener('input', handleTyping); els.typeInput.addEventListener('keydown', event => { if (event.key === 'Enter' && normalizePinyin(els.typeInput.value) !== normalizePinyin(currentStation()?.pinyin)) markWrong(); });
els.searchInput.addEventListener('input', event => { clearTimeout(state.searchTimer); state.searchTimer = setTimeout(() => performSearch(event.target.value), 180); });
els.searchInput.addEventListener('keydown', event => { if (event.key === 'Enter') performSearch(event.target.value); });
document.addEventListener('click', event => { if (!event.target.closest('.search-wrap')) els.searchResults.classList.remove('visible'); });
$('#reviewBtn').addEventListener('click', () => { if (!currentStation()) { showToast('请先选择线路和站点'); return; } els.reviewDrawer.classList.toggle('visible'); renderReviewPanel(); });
$('#reviewClose').addEventListener('click', () => els.reviewDrawer.classList.remove('visible')); $('#saveLanguage').addEventListener('click', saveLanguage);
$('#playReviewAudio').addEventListener('click', () => playStationAudio(currentStation()).catch(error => showToast(error.message)));
$('#chooseLocalAudio').addEventListener('click', () => $('#localAudioFile').click());
$('#localAudioFile').addEventListener('change', async event => { const file = event.target.files?.[0], station = currentStation(); if (!file || !station) return; await putLocalAudio(station.name, file); renderReviewPanel(); showToast('本机音频已保存'); event.target.value = ''; });
$('#clearLocalAudio').addEventListener('click', async () => { const station = currentStation(); if (!station) return; await deleteLocalAudio(station.name); renderReviewPanel(); showToast('本机音频已移除'); });

els.stage.addEventListener('pointerdown', event => { state.dragging = true; state.moved = false; state.lastX = event.clientX; state.lastY = event.clientY; els.stage.setPointerCapture?.(event.pointerId); });
els.stage.addEventListener('pointermove', event => { if (!state.dragging) return; const dx = event.clientX - state.lastX, dy = event.clientY - state.lastY; if (Math.abs(dx) + Math.abs(dy) > 2) state.moved = true; const rect = els.stage.getBoundingClientRect(); state.view.x -= dx / rect.width * state.view.w; state.view.y -= dy / rect.height * state.view.h; state.lastX = event.clientX; state.lastY = event.clientY; applyView(); drawNetwork(); });
els.stage.addEventListener('pointerup', event => { if (!state.dragging) return; state.dragging = false; if (!state.moved) { const route = nearestOverviewRoute(worldFromClient(event.clientX, event.clientY)); if (route) selectRoute(route.id); } });
els.stage.addEventListener('pointercancel', () => { state.dragging = false; });
els.stage.addEventListener('wheel', event => { event.preventDefault(); const before = worldFromClient(event.clientX, event.clientY), factor = Math.exp(event.deltaY * .0012), rect = els.stage.getBoundingClientRect(); const newW = clamp(state.view.w * factor, 80, (state.overview?.world.width || 10000) * 3), newH = newW * rect.height / rect.width; const rx = (event.clientX - rect.left) / rect.width, ry = (event.clientY - rect.top) / rect.height; state.view = {x: before[0] - rx * newW, y: before[1] - ry * newH, w: newW, h: newH}; applyView(); drawNetwork(); }, {passive: false});
window.addEventListener('resize', resize);
document.addEventListener('keydown', event => { if (event.key === 'Escape') { if (state.broadcasting) stopBroadcast(); else if (els.reviewDrawer.classList.contains('visible')) els.reviewDrawer.classList.remove('visible'); else clearSelection(); } if (event.code === 'Space' && !['INPUT','TEXTAREA'].includes(document.activeElement.tagName) && currentStation()) { event.preventDefault(); playStationAudio(currentStation()).catch(() => {}); } });

(async function init() {
  try {
    const overview = await api('/api/network/overview'); state.overview = overview; state.routeMap = new Map(overview.routes.map(route => [route.id, route]));
    $('#networkMeta').textContent = `${overview.stats.directions} 个方向 · ${overview.stats.station_clusters} 个站点簇 · Canvas 总览 / SVG 单线`;
    resize(); fitHome(); drawNetwork(); els.loading.classList.add('hidden'); renderAll();
  } catch (error) {
    els.loading.innerHTML = `<strong>尚未生成全网数据</strong><span>${escapeHtml(error.message)}<br><br><a href="/collector" style="color:#fff">进入采集页面</a></span>`;
  }
})();
