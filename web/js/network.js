const $ = selector => document.querySelector(selector);
const network = location.pathname.startsWith('/metro') ? 'metro' : 'bus';
const product = network === 'metro'
  ? {name: '深圳地铁', mark: '轨', stationZoom: 2, collector: '/metro/collector'}
  : {name: '深圳公交', mark: '巴', stationZoom: 2.6, collector: '/bus/collector'};
const apiBase = `/api/${network}`;

const elements = {
  stage: $('#mapStage'), routeCanvas: $('#routeCanvas'), labelCanvas: $('#labelCanvas'),
  topStatus: $('#topStatus'), networkMeta: $('#networkMeta'), loading: $('#loadingOverlay'),
  loadingTitle: $('#loadingTitle'), loadingText: $('#loadingText'), search: $('#searchInput'),
  searchResults: $('#searchResults'), routeCard: $('#routeCard'), stopList: $('#stopList'),
  home: $('#homeBtn'), zoomIn: $('#zoomInBtn'), zoomOut: $('#zoomOutBtn'), toast: $('#toast'),
};
const state = {
  overview: null, routeMap: new Map(), viewData: {routes: [], stations: []}, selected: null,
  view: null, homeView: null, drag: null, moved: false, pixelRatio: 1,
  fetchTimer: 0, fetchController: null, searchTimer: 0,
};

function configurePage() {
  document.title = `${product.name}线网图`;
  $('#brandMark').textContent = product.mark;
  $('#brandTitle').textContent = `${product.name}线网`;
  $('#sidebarTitle').textContent = `${product.name}线路网络`;
  $('#collectorNav').href = product.collector;
  document.querySelector(`[data-network-nav="${network}"]`)?.classList.add('active');
  $('#legend').innerHTML = network === 'metro'
    ? '总览显示全部地铁线路；点击线路后高亮并显示完整站序。<br>黄色站点表示由官方站序估算的位置。'
    : '总览只加载简化线路；放大后按视口加载详细折线和站点。<br>黄色站点表示由站序插值得到的近似站位。';
}

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add('show');
  setTimeout(() => elements.toast.classList.remove('show'), 1900);
}
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}
async function api(path, options = {}) {
  const response = await fetch(`${apiBase}${path}`, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.detail || `HTTP ${response.status}`);
  return payload;
}
function hashColor(text) {
  let hue = 0;
  for (const character of String(text)) hue = (hue * 31 + character.charCodeAt(0)) % 360;
  return `hsl(${hue} 78% 61%)`;
}
function routeColor(route) {
  return route.color || state.routeMap.get(route.id)?.color || hashColor(route.route_no);
}

function resize() {
  const rect = elements.stage.getBoundingClientRect();
  state.pixelRatio = Math.min(2, window.devicePixelRatio || 1);
  for (const canvas of [elements.routeCanvas, elements.labelCanvas]) {
    canvas.width = Math.round(rect.width * state.pixelRatio);
    canvas.height = Math.round(rect.height * state.pixelRatio);
    canvas.style.width = `${rect.width}px`;
    canvas.style.height = `${rect.height}px`;
  }
  if (state.overview && !state.view) fitHome();
  else render();
}
function fitRect(rect, padding = .08) {
  const stage = elements.stage.getBoundingClientRect();
  const aspect = stage.width / Math.max(1, stage.height);
  let [x, y] = rect;
  let width = Math.max(1, rect[2] - rect[0]);
  let height = Math.max(1, rect[3] - rect[1]);
  x -= width * padding; y -= height * padding;
  width *= 1 + padding * 2; height *= 1 + padding * 2;
  if (width / height > aspect) {
    const target = width / aspect; y -= (target - height) / 2; height = target;
  } else {
    const target = height * aspect; x -= (target - width) / 2; width = target;
  }
  state.view = {x, y, w: width, h: height};
  scheduleViewFetch();
  render();
}
function fitHome() {
  const world = state.overview.world;
  fitRect([0, 0, world.width, world.height], .04);
  state.homeView = {...state.view};
}
function currentZoom() { return state.homeView ? state.homeView.w / state.view.w : 1; }
function transform() {
  const rect = elements.stage.getBoundingClientRect();
  const scale = Math.min(rect.width / state.view.w, rect.height / state.view.h);
  return {
    scale,
    ox: (rect.width - state.view.w * scale) / 2 - state.view.x * scale,
    oy: (rect.height - state.view.h * scale) / 2 - state.view.y * scale,
    width: rect.width,
    height: rect.height,
  };
}
function worldToScreen(x, y, matrix = transform()) { return [x * matrix.scale + matrix.ox, y * matrix.scale + matrix.oy]; }
function screenToWorld(x, y, matrix = transform()) { return [(x - matrix.ox) / matrix.scale, (y - matrix.oy) / matrix.scale]; }
function context(canvas) {
  const ctx = canvas.getContext('2d');
  ctx.setTransform(state.pixelRatio, 0, 0, state.pixelRatio, 0, 0);
  ctx.clearRect(0, 0, canvas.width / state.pixelRatio, canvas.height / state.pixelRatio);
  return ctx;
}
function drawPath(ctx, path, matrix) {
  if (!path?.length) return;
  ctx.beginPath();
  let point = worldToScreen(path[0][0], path[0][1], matrix);
  ctx.moveTo(point[0], point[1]);
  for (let index = 1; index < path.length; index += 1) {
    point = worldToScreen(path[index][0], path[index][1], matrix);
    ctx.lineTo(point[0], point[1]);
  }
  ctx.stroke();
}
function drawLabel(ctx, text, x, y, size = 10, color = '#cbd8e8') {
  ctx.font = `600 ${size}px -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif`;
  ctx.textBaseline = 'middle'; ctx.lineJoin = 'round';
  ctx.strokeStyle = '#07101d'; ctx.lineWidth = 4; ctx.strokeText(text, x, y);
  ctx.fillStyle = color; ctx.fillText(text, x, y);
}
function routeSource() { return state.viewData.routes?.length ? state.viewData.routes : state.overview.routes; }
function render() {
  if (!state.overview || !state.view) return;
  const matrix = transform();
  const zoom = currentZoom();
  const routes = routeSource();
  const routeCtx = context(elements.routeCanvas);
  const labelCtx = context(elements.labelCanvas);
  routeCtx.lineCap = 'round'; routeCtx.lineJoin = 'round';
  for (const route of routes) {
    if (route.id === state.selected?.id) continue;
    const meta = state.routeMap.get(route.id) || route;
    routeCtx.strokeStyle = network === 'metro'
      ? `${routeColor(meta)}66`
      : meta.match_state === 'review' ? 'rgba(255,208,111,.16)' : 'rgba(122,165,218,.16)';
    routeCtx.lineWidth = network === 'metro' ? (zoom < 2 ? 1.7 : 2.4) : (zoom < 2 ? .75 : 1.05);
    drawPath(routeCtx, route.path, matrix);
  }
  if (state.selected) {
    const path = state.selected.paths?.detail || state.selected.path;
    routeCtx.strokeStyle = 'rgba(3,8,16,.92)'; routeCtx.lineWidth = 9; drawPath(routeCtx, path, matrix);
    routeCtx.strokeStyle = routeColor(state.selected); routeCtx.lineWidth = 5.2; drawPath(routeCtx, path, matrix);
  }
  if (zoom >= product.stationZoom) {
    for (const station of state.viewData.stations || []) {
      const [x, y] = worldToScreen(station.x, station.y, matrix);
      if (x < -10 || y < -10 || x > matrix.width + 10 || y > matrix.height + 10) continue;
      labelCtx.beginPath();
      labelCtx.arc(x, y, station.route_count >= 4 ? 3.1 : 2, 0, Math.PI * 2);
      labelCtx.fillStyle = station.estimated ? 'rgba(255,208,111,.72)' : 'rgba(238,246,255,.72)';
      labelCtx.fill();
      if (zoom >= 8 && station.route_count >= 2) drawLabel(labelCtx, station.name, x + 5, y - 4, 10);
    }
  }
  if (state.selected) {
    const stops = state.selected.stops || [];
    stops.forEach((station, index) => {
      const [x, y] = worldToScreen(station.x, station.y, matrix);
      labelCtx.beginPath();
      labelCtx.arc(x, y, index === 0 || index === stops.length - 1 ? 4.5 : 3.2, 0, Math.PI * 2);
      labelCtx.fillStyle = station.estimated ? '#ffd06f' : '#fff'; labelCtx.fill();
      labelCtx.strokeStyle = '#07101d'; labelCtx.lineWidth = 1.7; labelCtx.stroke();
      if (zoom >= 3.4 || index === 0 || index === stops.length - 1) {
        drawLabel(labelCtx, station.name, x + 6, y - 5, 11, station.estimated ? '#ffd98b' : '#eaf2fc');
      }
    });
  }
}

function scheduleViewFetch() { clearTimeout(state.fetchTimer); state.fetchTimer = setTimeout(fetchView, 100); }
async function fetchView() {
  if (!state.overview || !state.view) return;
  state.fetchController?.abort();
  state.fetchController = new AbortController();
  const view = state.view;
  const query = `minx=${view.x}&miny=${view.y}&maxx=${view.x + view.w}&maxy=${view.y + view.h}&zoom=${currentZoom()}`;
  try {
    const response = await fetch(`${apiBase}/network/view?${query}`, {signal: state.fetchController.signal});
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    state.viewData = await response.json();
    render();
  } catch (error) {
    if (error.name !== 'AbortError') console.warn('viewport fetch failed', error);
  }
}
function zoomAt(screenX, screenY, factor) {
  const matrix = transform();
  const [worldX, worldY] = screenToWorld(screenX, screenY, matrix);
  const nextWidth = Math.max(state.homeView.w / 35, Math.min(state.homeView.w * 1.15, state.view.w / factor));
  const ratio = nextWidth / state.view.w;
  const nextHeight = state.view.h * ratio;
  const relativeX = (worldX - state.view.x) / state.view.w;
  const relativeY = (worldY - state.view.y) / state.view.h;
  state.view = {x: worldX - relativeX * nextWidth, y: worldY - relativeY * nextHeight, w: nextWidth, h: nextHeight};
  scheduleViewFetch(); render();
}
function distanceToSegment(px, py, ax, ay, bx, by) {
  const vx = bx - ax; const vy = by - ay; const denominator = vx * vx + vy * vy;
  if (!denominator) return Math.hypot(px - ax, py - ay);
  const ratio = Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / denominator));
  return Math.hypot(px - (ax + ratio * vx), py - (ay + ratio * vy));
}
function hitRoute(screenX, screenY) {
  const matrix = transform(); let best = null; let bestDistance = 10;
  for (const route of routeSource()) {
    const path = route.path;
    if (!path || path.length < 2) continue;
    for (let index = 0; index < path.length - 1; index += 1) {
      const start = worldToScreen(path[index][0], path[index][1], matrix);
      const end = worldToScreen(path[index + 1][0], path[index + 1][1], matrix);
      const distance = distanceToSegment(screenX, screenY, start[0], start[1], end[0], end[1]);
      if (distance < bestDistance) { bestDistance = distance; best = route.id; }
    }
  }
  return best;
}
async function selectRoute(id, fit = true) {
  try {
    const route = await api(`/network/routes/${encodeURIComponent(id)}`);
    state.selected = route;
    renderRoutePanel(route);
    if (fit) fitRect(route.bbox, .18); else render();
    showToast(`${route.route_no} · ${route.direction_label}`);
  } catch (error) { showToast(error.message); }
}
function renderRoutePanel(route) {
  const score = Number(route.score || 0);
  const dot = network === 'metro' ? `<i class="route-color-dot" style="--route-color:${escapeHtml(routeColor(route))}"></i>` : '';
  elements.routeCard.innerHTML = `<h3>${dot}${escapeHtml(route.route_no)} · ${escapeHtml(route.direction_label)}</h3>
    <p>${escapeHtml(route.start_stop)} → ${escapeHtml(route.end_stop)}</p><p>${escapeHtml(route.operator || product.name)}</p>
    <div><span class="badge ${escapeHtml(route.match_state || 'matched')}">${escapeHtml(route.match_state || 'matched')}</span>
    <span class="badge">匹配 ${Math.round(score * 100)}%</span><span class="badge">${route.stops.length} 站</span></div>
    <p class="route-learn-link"><a class="button primary" href="/${network}/learn?route=${encodeURIComponent(route.id)}">进入站名学习</a></p>`;
  elements.stopList.innerHTML = route.stops.map((station, index) => `<div class="stop-row" data-index="${index}">
    <span>${index + 1}</span><strong>${escapeHtml(station.name)}</strong>${station.estimated ? '<span class="estimated">近似</span>' : '<span></span>'}</div>`).join('');
  elements.stopList.querySelectorAll('[data-index]').forEach(node => node.addEventListener('click', () => {
    const station = route.stops[Number(node.dataset.index)];
    const width = state.homeView.w / 12;
    fitRect([station.x - width / 2, station.y - width / 2, station.x + width / 2, station.y + width / 2], 0);
  }));
}
function renderSearch(results) {
  elements.searchResults.innerHTML = results.length
    ? results.map((result, index) => `<div class="list-item" data-result="${index}"><strong>${escapeHtml(result.title)}</strong><p>${escapeHtml(result.subtitle)}</p></div>`).join('')
    : elements.search.value ? '<div class="empty">没有结果</div>' : '';
  elements.searchResults.querySelectorAll('[data-result]').forEach(node => node.addEventListener('click', () => {
    const result = results[Number(node.dataset.result)];
    elements.searchResults.innerHTML = '';
    if (result.type === 'route') selectRoute(result.id, true);
    else if (result.route_ids?.length) selectRoute(result.route_ids[0], true);
  }));
}

elements.search.addEventListener('input', () => {
  clearTimeout(state.searchTimer);
  const query = elements.search.value.trim();
  if (!query) { elements.searchResults.innerHTML = ''; return; }
  state.searchTimer = setTimeout(async () => {
    try { renderSearch((await api(`/search?q=${encodeURIComponent(query)}&limit=40`)).results || []); } catch {}
  }, 180);
});
elements.stage.addEventListener('pointerdown', event => {
  elements.stage.setPointerCapture(event.pointerId);
  state.drag = {x: event.clientX, y: event.clientY, view: {...state.view}}; state.moved = false;
});
elements.stage.addEventListener('pointermove', event => {
  if (!state.drag) return;
  const dx = event.clientX - state.drag.x; const dy = event.clientY - state.drag.y;
  if (Math.abs(dx) + Math.abs(dy) > 3) state.moved = true;
  const matrix = transform();
  state.view = {...state.drag.view, x: state.drag.view.x - dx / matrix.scale, y: state.drag.view.y - dy / matrix.scale};
  render();
});
elements.stage.addEventListener('pointerup', event => {
  if (!state.drag) return;
  const moved = state.moved; state.drag = null;
  if (moved) scheduleViewFetch();
  else {
    const rect = elements.stage.getBoundingClientRect();
    const id = hitRoute(event.clientX - rect.left, event.clientY - rect.top);
    if (id) selectRoute(id, false);
  }
});
elements.stage.addEventListener('pointercancel', () => { state.drag = null; });
elements.stage.addEventListener('wheel', event => {
  event.preventDefault();
  const rect = elements.stage.getBoundingClientRect();
  zoomAt(event.clientX - rect.left, event.clientY - rect.top, event.deltaY < 0 ? 1.22 : 1 / 1.22);
}, {passive: false});
elements.home.addEventListener('click', () => {
  state.selected = null; elements.routeCard.innerHTML = '<div class="empty">点击线路，或在上方搜索。</div>';
  elements.stopList.innerHTML = ''; state.view = {...state.homeView}; scheduleViewFetch(); render();
});
elements.zoomIn.addEventListener('click', () => { const rect = elements.stage.getBoundingClientRect(); zoomAt(rect.width / 2, rect.height / 2, 1.35); });
elements.zoomOut.addEventListener('click', () => { const rect = elements.stage.getBoundingClientRect(); zoomAt(rect.width / 2, rect.height / 2, 1 / 1.35); });
window.addEventListener('resize', resize);

async function init() {
  configurePage();
  try {
    const overview = await api('/network/overview');
    state.overview = overview;
    state.routeMap = new Map(overview.routes.map(route => [route.id, route]));
    const stats = overview.stats || {};
    const lineText = stats.lines ? `${stats.lines} 条线路 · ` : '';
    elements.networkMeta.textContent = `${lineText}${stats.directions || overview.routes.length} 个方向 · ${stats.station_clusters || 0} 个站点簇 · 构建于 ${new Date(overview.built_at).toLocaleString()}`;
    elements.topStatus.innerHTML = `${lineText}方向 <b>${stats.directions || overview.routes.length}</b> · 站点簇 <b>${stats.station_clusters || 0}</b>`;
    resize(); state.viewData = {routes: overview.routes, stations: []}; fitHome();
    elements.loading.classList.add('hidden'); scheduleViewFetch();
  } catch (error) {
    elements.loadingTitle.textContent = `尚未生成${product.name}线网`;
    elements.loadingText.innerHTML = `${escapeHtml(error.message)}<br><br><a class="button primary" href="${product.collector}">进入采集与构建</a>`;
    elements.networkMeta.textContent = '需要先采集并构建。';
  }
}

init();
