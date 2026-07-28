const $ = selector => document.querySelector(selector);
const network = location.pathname.startsWith('/metro') ? 'metro' : 'bus';
const apiBase = `/api/${network}`;
const product = network === 'metro'
  ? {name: '深圳地铁', mark: '轨', batch: 16, maxBatch: 100, map: '/metro', learn: '/metro/learn'}
  : {name: '深圳公交', mark: '巴', batch: 100, maxBatch: 1000, map: '/bus', learn: '/bus/learn'};

const state = {
  running: false, processed: 0, target: 0, AMap: null, lineSearch: null,
  config: null, selectedReviewId: null,
};
const elements = {
  metricGrid: $('#metricGrid'), topStatus: $('#topStatus'), syncBtn: $('#syncBtn'),
  startBtn: $('#startBtn'), pauseBtn: $('#pauseBtn'), retryBtn: $('#retryBtn'), buildBtn: $('#buildBtn'),
  batchSize: $('#batchSize'), delayMs: $('#delayMs'), routeToken: $('#routeToken'),
  currentTitle: $('#currentTitle'), currentSubtitle: $('#currentSubtitle'), currentBadge: $('#currentBadge'),
  progressBar: $('#progressBar'), progressText: $('#progressText'), logBox: $('#logBox'),
  clearLogBtn: $('#clearLogBtn'), reviewList: $('#reviewList'), reviewDetail: $('#reviewDetail'),
  refreshReviewBtn: $('#refreshReviewBtn'), toast: $('#toast'),
};

function configurePage() {
  document.title = `${product.name}线路批量采集`;
  $('#brandMark').textContent = product.mark;
  $('#brandTitle').textContent = `${product.name}采集`;
  $('#brandSubtitle').textContent = network === 'metro' ? '官方站序 × 高德几何采集器' : '官方目录 × 高德线路采集器';
  $('#learnNav').href = product.learn;
  $('#collectorNav').href = `/${network}/collector`;
  elements.batchSize.value = product.batch;
  elements.batchSize.max = product.maxBatch;
  elements.syncBtn.hidden = network !== 'metro';
}
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}
function badge(status) { return `<span class="badge ${escapeHtml(status)}">${escapeHtml(status)}</span>`; }
function showToast(message) {
  elements.toast.textContent = message; elements.toast.classList.add('show');
  setTimeout(() => elements.toast.classList.remove('show'), 2200);
}
function log(message, kind = 'info') {
  const prefix = kind === 'error' ? '✕' : kind === 'ok' ? '✓' : kind === 'warn' ? '!' : '·';
  elements.logBox.textContent += `[${new Date().toLocaleTimeString()}] ${prefix} ${message}\n`;
  elements.logBox.scrollTop = elements.logBox.scrollHeight;
}
function sleep(milliseconds) { return new Promise(resolve => setTimeout(resolve, milliseconds)); }
async function api(path, options = {}) {
  const response = await fetch(`${apiBase}${path}`, {
    ...options,
    headers: {'Content-Type': 'application/json', ...(options.headers || {})},
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.detail || `HTTP ${response.status}`);
  return payload;
}

function sourceDate(stats) { return stats.catalog?.source_date || stats.source_date || '—'; }
function renderStats(stats) {
  const status = stats.route_status || {};
  const done = (status.matched || 0) + (status.review || 0) + (status.failed || 0) + (status.no_data || 0) + (status.error || 0);
  const metrics = [
    ['官方线路', stats.total_routes || 0, ''], ['已完成查询', done, 'ok'],
    ['自动匹配', status.matched || 0, 'ok'], ['待人工复核', status.review || 0, 'warn'],
    ['失败/无结果', (status.failed || 0) + (status.no_data || 0) + (status.error || 0), 'bad'],
  ];
  elements.metricGrid.innerHTML = metrics.map(([label, value, css]) => `<div class="metric ${css}"><strong>${value}</strong><span>${label}</span></div>`).join('');
  elements.topStatus.innerHTML = `数据：<b>${escapeHtml(sourceDate(stats))}</b> · 已查询 <b>${done}/${stats.total_routes || 0}</b>${stats.network_exists ? ' · 线网已构建' : ''}`;
}
async function refreshStats() { const stats = await api('/status'); renderStats(stats); return stats; }

async function loadAmap() {
  if (state.AMap) return state.AMap;
  state.config = await api('/config');
  elements.delayMs.value = state.config.default_delay_ms || 1200;
  if (!state.config.ready) throw new Error('尚未配置 AMAP_JS_KEY 和 AMAP_SECURITY_CODE，请编辑 .env 后重启。');
  window._AMapSecurityConfig = {securityJsCode: state.config.amap_security_code};
  state.AMap = await new Promise((resolve, reject) => {
    const script = document.createElement('script');
    const timer = setTimeout(() => reject(new Error('高德 JS API 加载超时')), 20000);
    script.src = `https://webapi.amap.com/maps?v=2.0&key=${encodeURIComponent(state.config.amap_js_key)}&plugin=AMap.LineSearch`;
    script.onload = () => { clearTimeout(timer); window.AMap ? resolve(window.AMap) : reject(new Error('高德 API 未初始化')); };
    script.onerror = () => { clearTimeout(timer); reject(new Error('高德 API 加载失败，请检查 Key、域名白名单和网络')); };
    document.head.appendChild(script);
  });
  state.lineSearch = new state.AMap.LineSearch({city: state.config.city || '深圳', pageIndex: 1, pageSize: 50, extensions: 'all'});
  log('高德 LineSearch 已加载。', 'ok');
  return state.AMap;
}
function lngLat(point) {
  if (!point) return null;
  if (Array.isArray(point)) return [Number(point[0]), Number(point[1])];
  const longitude = typeof point.getLng === 'function' ? point.getLng() : (point.lng ?? point.longitude);
  const latitude = typeof point.getLat === 'function' ? point.getLat() : (point.lat ?? point.latitude);
  return Number.isFinite(Number(longitude)) && Number.isFinite(Number(latitude))
    ? [Number(longitude), Number(latitude)] : null;
}
function normalizeCandidate(line, queryAlias = '') {
  const path = (line.path || []).map(lngLat).filter(Boolean);
  const rawStops = line.via_stops || line.viaStops || line.stops || [];
  const viaStops = rawStops.map(stop => ({
    id: String(stop.id || ''), name: String(stop.name || ''), location: lngLat(stop.location || stop.position),
  })).filter(stop => stop.location);
  const first = viaStops[0]?.name || '';
  const last = viaStops.at(-1)?.name || '';
  return {
    id: String(line.id || ''), query_alias: queryAlias, name: String(line.name || ''),
    start_stop: String(line.start_stop?.name || line.start_stop || line.startStop?.name || line.startStop || first),
    end_stop: String(line.end_stop?.name || line.end_stop || line.endStop?.name || line.endStop || last),
    company: String(line.company || ''), type: String(line.type || ''), distance: line.distance ?? null,
    path, via_stops: viaStops,
  };
}
function searchOnce(keyword) {
  return new Promise(resolve => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) { settled = true; resolve({status: 'error', result: {info: '查询超时'}}); }
    }, 25000);
    state.lineSearch.search(keyword, (status, result) => {
      if (settled) return;
      settled = true; clearTimeout(timer); resolve({status, result: result || {}});
    });
  });
}
function busKeywords(item) {
  const routeNo = String(item.route_no || '').trim();
  return [...new Set([routeNo, /^\d+$/.test(routeNo) ? `${routeNo}路` : ''].filter(Boolean))];
}
function metroKeywords(item) { return item.aliases?.length ? item.aliases : [item.name]; }
function candidateKey(candidate) {
  return [candidate.id, candidate.name, candidate.start_stop, candidate.end_stop, candidate.via_stops.length, candidate.path.length].join('|');
}
function describeQueueItem(item) {
  if (network === 'metro') {
    return {
      token: item.short_name || item.name,
      title: `${item.name} · ${item.origin} → ${item.destination}`,
      subtitle: `第 ${item.query_attempts + 1} 次尝试 · ${item.stations.length} 个官方站点`,
    };
  }
  return {
    token: item.route_no,
    title: `${item.route_no} · ${item.start_stop} → ${item.end_stop}`,
    subtitle: `${item.operator} · 第 ${item.query_attempts + 1} 次尝试`,
  };
}
async function collectItem(item) {
  const copy = describeQueueItem(item);
  elements.routeToken.textContent = copy.token; elements.currentTitle.textContent = copy.title;
  elements.currentSubtitle.textContent = copy.subtitle; elements.currentBadge.className = 'badge';
  elements.currentBadge.textContent = '查询中';
  const candidates = []; const seen = new Set();
  let finalStatus = 'no_data'; let finalInfo = 'NO_DATA';
  const keywords = network === 'metro' ? metroKeywords(item) : busKeywords(item);
  for (let index = 0; index < keywords.length; index += 1) {
    if (!state.running) break;
    const keyword = keywords[index];
    log(`查询 ${copy.token}，关键词“${keyword}”`);
    const result = await searchOnce(keyword);
    finalStatus = result.status; finalInfo = String(result.result?.info || result.status);
    const raw = result.result?.lineInfo || result.result?.lineinfo || [];
    if (result.status === 'complete' && Array.isArray(raw)) {
      raw.map(line => normalizeCandidate(line, keyword)).filter(candidate => candidate.path.length >= 2).forEach(candidate => {
        const key = candidateKey(candidate);
        if (!seen.has(key)) { seen.add(key); candidates.push(candidate); }
      });
      if (network === 'bus' && candidates.length) break;
    }
    if (index < keywords.length - 1) await sleep(Math.max(500, Number(elements.delayMs.value) || 1200));
  }
  const status = candidates.length ? 'complete' : finalStatus === 'error' ? 'error' : 'no_data';
  const saved = await api('/collector/results', {
    method: 'POST',
    body: JSON.stringify({
      route_id: item.id, status, info: finalInfo, candidates,
      error: status === 'error' ? finalInfo : null,
    }),
  });
  elements.currentBadge.className = `badge ${saved.result.query_status}`;
  elements.currentBadge.textContent = saved.result.query_status;
  const best = saved.result.best_score ?? Math.max(0, ...(saved.result.matches || []).map(match => match.score || match.total || 0));
  log(`${copy.token} 保存 ${candidates.length} 个候选；最佳 ${Math.round(best * 100)}%`, saved.result.query_status === 'matched' ? 'ok' : saved.result.query_status === 'review' ? 'warn' : 'error');
  renderStats(saved.stats);
}

function updateProgress() {
  const ratio = state.target ? Math.min(100, state.processed / state.target * 100) : 0;
  elements.progressBar.style.width = `${ratio}%`;
  elements.progressText.textContent = `本轮 ${state.processed} / ${state.target}`;
}
async function runCollector(retry = false) {
  if (state.running) return;
  try { await loadAmap(); } catch (error) { showToast(error.message); log(error.message, 'error'); return; }
  state.running = true; state.processed = 0;
  state.target = Math.max(1, Math.min(product.maxBatch, Number(elements.batchSize.value) || product.batch));
  updateProgress(); elements.startBtn.disabled = true; elements.retryBtn.disabled = true; elements.pauseBtn.disabled = false;
  log(`开始本轮采集：最多 ${state.target} 条，间隔 ${elements.delayMs.value} ms${retry ? '，包含失败项' : ''}。`, 'ok');
  try {
    while (state.running && state.processed < state.target) {
      const remaining = state.target - state.processed;
      const payload = await api(`/collector/queue?limit=${Math.min(100, remaining)}&retry=${retry ? 'true' : 'false'}`);
      const items = payload.items || [];
      if (!items.length) { log('队列已空。', 'ok'); break; }
      for (const item of items) {
        if (!state.running || state.processed >= state.target) break;
        try { await collectItem(item); }
        catch (error) { log(`${describeQueueItem(item).token} 保存失败：${error.message}`, 'error'); }
        state.processed += 1; updateProgress();
        if (state.running) await sleep(Math.max(500, Number(elements.delayMs.value) || 1200));
      }
    }
  } finally {
    state.running = false; elements.startBtn.disabled = false; elements.retryBtn.disabled = false; elements.pauseBtn.disabled = true;
    elements.currentTitle.textContent = '本轮结束';
    elements.currentSubtitle.textContent = `已处理 ${state.processed} 条；完成项不会重复查询。`;
    elements.currentBadge.className = 'badge'; elements.currentBadge.textContent = '空闲';
    await refreshStats(); await refreshReview();
  }
}

function reviewTitle(item) { return network === 'metro' ? (item.short_name || item.name) : item.route_no; }
function reviewTerminals(item) { return network === 'metro' ? `${item.origin} → ${item.destination}` : `${item.start_stop} → ${item.end_stop}`; }
async function refreshReview() {
  const items = (await api('/collector/review?limit=300')).items || [];
  elements.reviewList.innerHTML = items.length
    ? items.map(item => `<div class="list-item ${String(state.selectedReviewId) === String(item.id) ? 'active' : ''}" data-id="${escapeHtml(item.id)}"><strong>${escapeHtml(reviewTitle(item))} ${badge(item.query_status)}</strong><p>${escapeHtml(reviewTerminals(item))}</p></div>`).join('')
    : '<div class="empty">暂无待复核或失败项目。</div>';
  elements.reviewList.querySelectorAll('[data-id]').forEach(node => node.addEventListener('click', () => openReview(node.dataset.id)));
}
function busCandidateCard(candidate, index, score, direction) {
  return `<div class="candidate"><h4>#${index + 1} ${escapeHtml(candidate.name || '未命名')}</h4>
    <p>${escapeHtml(candidate.start_stop)} → ${escapeHtml(candidate.end_stop)}</p>
    <p>${candidate.via_stops?.length || 0} 站 · ${candidate.path?.length || 0} 个折线点</p>
    <div class="score-row"><span class="badge">总分 ${Math.round((score.total || 0) * 100)}%</span><span class="badge">端点 ${Math.round((score.endpoint || 0) * 100)}%</span><span class="badge">站序 ${Math.round((score.stations || 0) * 100)}%</span></div>
    <div class="candidate-actions"><button data-bus-direction="${escapeHtml(direction.direction)}" data-index="${index}">设为${escapeHtml(direction.label)}</button></div></div>`;
}
function metroCandidateCard(entry) {
  const candidate = entry.candidate; const score = entry.score || {};
  return `<div class="candidate"><h4>#${Number(entry.index) + 1} ${escapeHtml(candidate.name || '未命名')}</h4>
    <p>${escapeHtml(candidate.start_stop)} → ${escapeHtml(candidate.end_stop)}</p>
    <p>${candidate.via_stops?.length || 0} 站 · ${candidate.path?.length || 0} 个折线点</p>
    <div class="score-row"><span class="badge">总分 ${Math.round((score.total || 0) * 100)}%</span><span class="badge">站序 ${Math.round((score.sequence || 0) * 100)}%</span><span class="badge">端点 ${Math.round((score.endpoint || 0) * 100)}%</span></div>
    <div class="candidate-actions"><button data-metro-candidate="${entry.id}">采用候选${score.reversed ? '（反向）' : ''}</button></div></div>`;
}
async function openReview(routeId) {
  state.selectedReviewId = routeId; await refreshReview();
  elements.reviewDetail.innerHTML = '<div class="empty">正在读取候选…</div>';
  const item = await api(`/collector/items/${encodeURIComponent(routeId)}`); const route = item.route;
  if (!item.candidates?.length) {
    elements.reviewDetail.innerHTML = `<h3>${escapeHtml(reviewTitle(route))}</h3><p class="review-error">${escapeHtml(route.last_error || '没有高德候选')}</p><button id="resetOne" class="button warn">重新加入采集队列</button>`;
    $('#resetOne')?.addEventListener('click', async () => {
      await api('/collector/reset', {method: 'POST', body: JSON.stringify({statuses: [route.query_status]})});
      showToast('已重置同状态项目'); await refreshReview();
    });
    return;
  }
  if (network === 'bus') {
    const blocks = (route.directions || []).map(direction => {
      const scores = item.candidate_scores?.[direction.direction] || [];
      const cards = item.candidates.map((candidate, index) => {
        const score = scores.find(entry => entry.index === index)?.score || {};
        return busCandidateCard(candidate, index, score, direction);
      }).join('');
      return `<section><h3>${escapeHtml(direction.label)}：${escapeHtml(direction.start_stop)} → ${escapeHtml(direction.end_stop)}</h3>${cards}</section>`;
    }).join('');
    elements.reviewDetail.innerHTML = `<h2>${escapeHtml(route.route_no)}</h2><p class="review-error">${escapeHtml(route.operator)}</p>${blocks}`;
    elements.reviewDetail.querySelectorAll('[data-bus-direction]').forEach(button => button.addEventListener('click', async () => {
      await api('/collector/selection', {method: 'POST', body: JSON.stringify({route_id: Number(routeId), direction: button.dataset.busDirection, candidate_index: Number(button.dataset.index)})});
      showToast('候选已指定'); await refreshStats(); await openReview(routeId);
    }));
  } else {
    elements.reviewDetail.innerHTML = `<h2>${escapeHtml(route.name)}</h2><p class="review-error">${escapeHtml(route.origin)} → ${escapeHtml(route.destination)}</p>${item.candidates.map(metroCandidateCard).join('')}`;
    elements.reviewDetail.querySelectorAll('[data-metro-candidate]').forEach(button => button.addEventListener('click', async () => {
      await api('/collector/selection', {method: 'POST', body: JSON.stringify({route_id: routeId, candidate_id: Number(button.dataset.metroCandidate)})});
      showToast('候选已采用'); await refreshStats(); await refreshReview();
    }));
  }
}

elements.startBtn.addEventListener('click', () => runCollector(false));
elements.retryBtn.addEventListener('click', () => runCollector(true));
elements.pauseBtn.addEventListener('click', () => { state.running = false; log('已请求暂停，将在当前线路保存后停止。', 'warn'); });
elements.clearLogBtn.addEventListener('click', () => { elements.logBox.textContent = ''; });
elements.refreshReviewBtn.addEventListener('click', refreshReview);
elements.syncBtn.addEventListener('click', async () => {
  elements.syncBtn.disabled = true; log('正在同步官方地铁目录…');
  try { await api('/catalog/sync', {method: 'POST'}); log('官方目录已同步。', 'ok'); await refreshStats(); }
  catch (error) { log(`同步失败：${error.message}`, 'error'); }
  finally { elements.syncBtn.disabled = false; }
});
elements.buildBtn.addEventListener('click', async () => {
  elements.buildBtn.disabled = true; log('开始编译固定坐标、三级 LOD 和站点聚合…');
  try {
    const payload = await api('/build', {method: 'POST'}); const result = payload.result || {};
    const size = result.size_bytes ? `，${(result.size_bytes / 1024 / 1024).toFixed(1)} MB` : '';
    log(`构建完成：${result.directions || 0} 个方向，${result.station_clusters || 0} 个站点簇${size}。`, 'ok');
    showToast('线网构建完成'); await refreshStats();
  } catch (error) { log(`构建失败：${error.message}`, 'error'); showToast(error.message); }
  finally { elements.buildBtn.disabled = false; }
});

async function init() {
  configurePage(); elements.pauseBtn.disabled = true;
  try {
    await refreshStats(); await refreshReview();
    const configuration = await api('/config');
    log(configuration.ready ? '配置已读取，点击“开始 / 继续”后加载高德 API。' : '请先在 .env 配置高德 Web JS Key 和安全密钥。', configuration.ready ? 'ok' : 'warn');
  } catch (error) { log(error.message, 'error'); }
}

init();
