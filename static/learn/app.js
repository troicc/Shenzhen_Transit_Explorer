import {$, clamp, damp, debounce, escapeHtml, normalizePinyin, routeColor, showToast, travelIndex} from './core.js?v=20260726-bus-motion-2';
import {transitApi} from './api.js';
import {buildRouteGeometry} from './geometry.js';
import {deleteLocalAudio, getLocalAudio, putLocalAudio, StationAudioPlayer} from './audio.js';
import {PracticeEngine} from './practice.js?v=20260726-bus-motion-2';
import {RealMapFocusRenderer} from './real-map.js?v=20260726-upright-bus';
import {FocusRenderer, OverviewRenderer} from './renderers.js?v=20260726-upright-bus';
import {restoreTypingFocus} from './typing-focus.js?v=20260726';

const elements = {
  app: $('#app'), stage: $('#mapStage'), canvas: $('#networkCanvas'), svg: $('#focusSvg'), realMap: $('#realMap'),
  routeLayer: $('#routeLayer'), stationLayer: $('#stationLayer'), labelLayer: $('#labelLayer'), train: $('#train'),
  loading: $('#loading'), intro: $('#intro'), routeCard: $('#routeCard'), stationCard: $('#stationCard'),
  practicePanel: $('#practicePanel'), searchShell: $('#searchShell'), searchInput: $('#searchInput'), searchResults: $('#searchResults'),
  reviewDrawer: $('#reviewDrawer'), resultModal: $('#resultModal'), typingInput: $('#typingInput'),
};

const state = {
  overview: null,
  networkType: transitApi.networkType,
  route: null,
  color: '#5cc8ff',
  schematic: true,
  balanced: true,
  allLabels: false,
  reverse: false,
  browseIndex: 0,
  mode: 'overview',
  geometryCache: new Map(),
  pendingStationName: null,
  loadingRouteToken: 0,
  broadcastToken: 0,
  broadcasting: false,
  dragging: false,
  moved: false,
  lastPointer: [0, 0],
  activeSearchIndex: -1,
  searchItems: [],
  stationCompletionToken: 0,
  viewMode: 'flat',
  mapReady: false,
  journeyMotionFrame: 0,
  journeyMotionRatio: 0,
  journeyMotionTarget: 0,
  journeyMotionKey: null,
  journeyMotionLastAt: 0,
};

const overviewRenderer = new OverviewRenderer({canvas: elements.canvas, stage: elements.stage});
const focusRenderer = new FocusRenderer({
  svg: elements.svg,
  routeLayer: elements.routeLayer,
  stationLayer: elements.stationLayer,
  labelLayer: elements.labelLayer,
  train: elements.train,
  stage: elements.stage,
  onStationClick: originalIndex => selectStationByOriginalIndex(originalIndex),
});
const audioPlayer = new StationAudioPlayer();
const realMapRenderer = new RealMapFocusRenderer({container: elements.realMap});
const practice = new PracticeEngine({
  onChange: snapshot => renderPractice(snapshot),
  onFinish: snapshot => showResult(snapshot),
});

function restorePracticeTypingFocus() {
  restoreTypingFocus(elements.typingInput, {
    mode: state.mode,
    running: practice.running,
    finished: practice.finished,
    resultVisible: elements.resultModal.classList.contains('visible'),
  });
}

function displayStops() {
  if (!state.route) return [];
  return state.reverse ? [...state.route.stops].reverse() : state.route.stops;
}

function displayIndex() {
  return state.mode === 'timed' || state.mode === 'full' ? practice.index : state.browseIndex;
}

function originalIndexFromDisplay(index = displayIndex()) {
  if (!state.route) return 0;
  return travelIndex(index, state.route.stops.length, state.reverse);
}

function displayIndexFromOriginal(index) {
  if (!state.route) return 0;
  return travelIndex(index, state.route.stops.length, state.reverse);
}

function currentStation() {
  return displayStops()[displayIndex()] || null;
}

function nextStation() {
  return displayStops()[displayIndex() + 1] || null;
}

function currentGeometry() {
  if (!state.route) return null;
  const key = `${state.route.id}:${state.schematic ? 's' : 'g'}:${state.balanced ? 'b' : 'd'}`;
  if (!state.geometryCache.has(key)) {
    state.geometryCache.set(key, buildRouteGeometry(state.route, {schematic: state.schematic, balanced: state.balanced}));
  }
  return state.geometryCache.get(key);
}

function routeMetaText() {
  if (!state.route) return '—';
  const estimated = state.route.stops.filter(stop => stop.estimated).length;
  const transfer = state.route.stops.filter(stop => stop.transfer).length;
  return `${state.route.stops.length} 站 · ${transfer} 个多线路站 · 匹配 ${Math.round((state.route.score || 0) * 100)}%${estimated ? ` · ${estimated} 个估算站点` : ''}`;
}

function setActiveMode(mode) {
  document.querySelectorAll('.mode-button').forEach(button => button.classList.toggle('active', button.dataset.mode === mode));
}

function updateAppClasses() {
  elements.app.classList.toggle('focused', Boolean(state.route));
  elements.app.classList.toggle('practice', state.mode === 'timed' || state.mode === 'full');
  elements.app.classList.toggle('map-view', Boolean(state.route) && ['animated', 'real'].includes(state.viewMode));
  elements.app.classList.toggle('flat-map', Boolean(state.route) && state.viewMode === 'flat');
  elements.app.classList.toggle('animated-map', Boolean(state.route) && state.viewMode === 'animated');
  elements.app.classList.toggle('realistic-map', Boolean(state.route) && state.viewMode === 'real');
}

function updateViewControls() {
  const controls = [
    {mode: 'flat', buttons: [$('#flatViewButton'), $('#practiceFlatButton')], title: '活泼的扁平轨道动画'},
    {mode: 'animated', buttons: [$('#animatedViewButton'), $('#practiceAnimatedButton')], title: '沿真实道路前进的动画地图'},
    {mode: 'real', buttons: [$('#realMapViewButton'), $('#practiceRealButton')], title: '带平滑跟随视角的真实地图'},
  ];
  controls.forEach(({mode, buttons, title}) => buttons.forEach(button => {
    const active = state.viewMode === mode;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
    button.disabled = mode !== 'flat' && !state.mapReady;
    button.title = mode === 'flat' || state.mapReady ? title : '请先配置高德 Web JS Key';
  }));
}

async function setViewMode(mode) {
  if (!state.route) return;
  if (mode === 'flat') {
    state.viewMode = 'flat';
    realMapRenderer.hide();
    updateAppClasses();
    updateViewControls();
    renderDynamic();
    return;
  }
  if (!state.mapReady) {
    showToast('尚未配置高德 Web JS Key，继续使用扁平动画');
    return;
  }
  const routeId = state.route.id;
  const button = mode === 'real' ? $('#realMapViewButton') : $('#animatedViewButton');
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = '加载地图…';
  try {
    await realMapRenderer.show(state.route, state.color, mode);
    if (!state.route || state.route.id !== routeId) return;
    state.viewMode = mode;
    updateAppClasses();
    updateViewControls();
    renderDynamic();
  } catch (error) {
    state.viewMode = 'flat';
    realMapRenderer.hide();
    updateAppClasses();
    updateViewControls();
    showToast(`${error.message}，已回到扁平动画，练习进度未重置`);
  } finally {
    button.textContent = originalText;
    updateViewControls();
  }
}

function rebuildFocusScene({fit = true, animate = true} = {}) {
  if (!state.route) return;
  const geometry = currentGeometry();
  focusRenderer.setRoute(state.route, geometry, state.color);
  if (fit) focusRenderer.fit(state.mode === 'timed' || state.mode === 'full', animate);
  renderDynamic();
}

async function selectRoute(routeId, stationName = null) {
  const token = ++state.loadingRouteToken;
  elements.loading.classList.remove('hidden');
  elements.loading.querySelector('strong').textContent = '正在进入线路';
  elements.loading.querySelector('small').textContent = '正在加载详细折线、站序、拼音和语言设置。';
  try {
    const route = await transitApi.route(routeId);
    if (token !== state.loadingRouteToken) return;
    stopBroadcast(true);
    practice.reset();
    state.route = route;
    state.color = routeColor(route.route_no);
    state.reverse = false;
    state.viewMode = 'flat';
    state.mode = 'overview';
    state.browseIndex = 0;
    state.pendingStationName = stationName;
    state.geometryCache.clear();
    realMapRenderer.hide();
    if (stationName) {
      const index = route.stops.findIndex(stop => stop.name === stationName);
      if (index >= 0) state.browseIndex = index;
    }
    overviewRenderer.setFocused(true, route.id);
    overviewRenderer.view = {...overviewRenderer.homeView};
    overviewRenderer.draw();
    elements.intro.classList.add('hidden');
    elements.routeCard.classList.add('visible');
    elements.stationCard.classList.add('visible');
    elements.resultModal.classList.remove('visible');
    setActiveMode('overview');
    updateAppClasses();
    updateViewControls();
    rebuildFocusScene({fit: true, animate: true});
    renderCards();
  } catch (error) {
    showToast(error.message);
  } finally {
    if (token === state.loadingRouteToken) elements.loading.classList.add('hidden');
  }
}

function clearSelection() {
  ++state.loadingRouteToken;
  ++state.stationCompletionToken;
  stopBroadcast(true);
  practice.reset();
  state.route = null;
  state.mode = 'overview';
  state.browseIndex = 0;
  state.reverse = false;
  state.viewMode = 'flat';
  focusRenderer.clear();
  realMapRenderer.hide();
  overviewRenderer.setFocused(false, null);
  overviewRenderer.animateView(overviewRenderer.homeView, 420);
  elements.intro.classList.remove('hidden');
  elements.routeCard.classList.remove('visible');
  elements.stationCard.classList.remove('visible');
  elements.practicePanel.classList.remove('visible');
  elements.reviewDrawer.classList.remove('visible');
  elements.resultModal.classList.remove('visible');
  setActiveMode('overview');
  updateAppClasses();
  updateViewControls();
}

function selectStationByOriginalIndex(originalIndex) {
  if (!state.route) return;
  if (state.mode === 'timed' || state.mode === 'full') {
    showToast('练习中不能跳站，按 Esc 可退出练习');
    return;
  }
  state.browseIndex = displayIndexFromOriginal(originalIndex);
  renderDynamic();
}

function renderCards() {
  const route = state.route;
  if (!route) return;
  const station = currentStation();
  const stops = displayStops();
  $('#routeBadge').textContent = route.route_no;
  $('#routeBadge').style.background = state.color;
  $('#routeTitle').textContent = `${route.route_no} · ${route.direction_label || route.direction}`;
  $('#routeTerminals').textContent = `${stops[0]?.name || route.start_stop} → ${stops.at(-1)?.name || route.end_stop}`;
  $('#routeMeta').textContent = routeMetaText();
  $('#practiceRouteLabel').textContent = `${route.route_no} · ${route.direction_label || route.direction}`;
  $('#practiceRouteProgress').textContent = `${String(displayIndex() + 1).padStart(2, '0')} / ${String(route.stops.length).padStart(2, '0')}`;
  $('#previousDirectionButton').textContent = state.reverse ? '恢复正向浏览' : '反向浏览';
  const sibling = route.siblings?.find(item => item.id !== route.id);
  $('#switchDirectionButton').disabled = !sibling;
  $('#switchDirectionButton').textContent = sibling ? `切换${sibling.direction_label || '另一方向'}` : '无另一方向';
  $('#broadcastButton').textContent = state.broadcasting ? '■ 停止播报' : '▶ 全线播报';
  $('#broadcastButton').classList.toggle('active', state.broadcasting);
  $('#schematicToggle').checked = state.schematic;
  $('#balancedToggle').checked = state.balanced;
  $('#labelsToggle').checked = state.allLabels;

  if (!station) return;
  $('#stationNumber').textContent = String(displayIndex() + 1).padStart(2, '0');
  $('#stationName').textContent = station.name;
  $('#stationPinyin').textContent = `拼音：${station.pinyin || '待校核'}`;
  $('#stationJyutping').textContent = `粤拼：${station.jyutping || '待校核'}`;
  const chips = $('#stationLineChips');
  chips.innerHTML = '';
  (station.route_nos || [route.route_no]).slice(0, 12).forEach(routeNo => {
    const chip = document.createElement('span');
    chip.textContent = routeNo;
    chips.append(chip);
  });
  if ((station.route_nos || []).length > 12) {
    const chip = document.createElement('span');
    chip.textContent = `+${station.route_nos.length - 12}`;
    chips.append(chip);
  }
}

function stopJourneyMotion(ratio = 0, key = null) {
  cancelAnimationFrame(state.journeyMotionFrame);
  state.journeyMotionFrame = 0;
  state.journeyMotionRatio = ratio;
  state.journeyMotionTarget = ratio;
  state.journeyMotionKey = key;
  state.journeyMotionLastAt = 0;
}

function journeyFrame(typingRatio) {
  const index = displayIndex();
  const originalIndex = originalIndexFromDisplay(index);
  const nextDisplay = index + 1 < state.route.stops.length ? index + 1 : null;
  const nextOriginal = nextDisplay == null ? null : originalIndexFromDisplay(nextDisplay);
  return {
    currentOriginalIndex: originalIndex,
    nextOriginalIndex: nextOriginal,
    reverse: state.reverse,
    typingRatio,
    allLabels: state.allLabels,
    journeyActive: state.mode === 'timed' || state.mode === 'full',
  };
}

function renderJourneyFrame(typingRatio) {
  if (!state.route) return;
  const frame = journeyFrame(typingRatio);
  focusRenderer.renderDynamic(frame);
  if (state.viewMode === 'animated' || state.viewMode === 'real') realMapRenderer.renderDynamic(frame);
}

function stepJourneyMotion(now) {
  state.journeyMotionFrame = 0;
  if (!state.route || (state.mode !== 'timed' && state.mode !== 'full')) return;
  const elapsed = clamp(now - (state.journeyMotionLastAt || now - 16), 8, 48);
  state.journeyMotionLastAt = now;
  state.journeyMotionRatio = damp(
    state.journeyMotionRatio,
    state.journeyMotionTarget,
    elapsed,
    state.journeyMotionTarget >= .9999 ? 60 : 105,
  );
  if (Math.abs(state.journeyMotionTarget - state.journeyMotionRatio) < .001) {
    state.journeyMotionRatio = state.journeyMotionTarget;
  }
  renderJourneyFrame(state.journeyMotionRatio);
  if (state.journeyMotionRatio !== state.journeyMotionTarget) {
    state.journeyMotionFrame = requestAnimationFrame(stepJourneyMotion);
  }
}

function syncJourneyMotion(targetRatio) {
  const key = `${state.route.id}:${state.reverse}:${displayIndex()}`;
  if (key !== state.journeyMotionKey) stopJourneyMotion(0, key);
  state.journeyMotionTarget = clamp(targetRatio, 0, 1);
  if (state.journeyMotionRatio !== state.journeyMotionTarget && !state.journeyMotionFrame) {
    state.journeyMotionLastAt = performance.now();
    state.journeyMotionFrame = requestAnimationFrame(stepJourneyMotion);
  }
  return state.journeyMotionRatio;
}

function renderDynamic() {
  if (!state.route) return;
  const snapshot = practice.snapshot();
  const journeyActive = state.mode === 'timed' || state.mode === 'full';
  const typingRatio = journeyActive ? syncJourneyMotion(snapshot.typingRatio) : 0;
  if (!journeyActive && state.journeyMotionKey != null) stopJourneyMotion();
  renderJourneyFrame(typingRatio);
  renderCards();
  if (elements.reviewDrawer.classList.contains('visible')) renderReviewPanel();
}

function setMode(mode) {
  if (mode === 'overview') {
    clearSelection();
    return;
  }
  if (!state.route) {
    showToast('请先选择一条线路');
    return;
  }
  stopBroadcast(true);
  state.mode = mode;
  state.browseIndex = 0;
  stopJourneyMotion();
  practice.start(displayStops(), mode);
  elements.practicePanel.classList.add('visible');
  setActiveMode(mode);
  updateAppClasses();
  focusRenderer.fit(true, true);
  renderDynamic();
  elements.typingInput.value = '';
  setTimeout(() => elements.typingInput.focus(), 90);
}

function exitPractice() {
  if (state.mode !== 'timed' && state.mode !== 'full') return;
  ++state.stationCompletionToken;
  stopJourneyMotion();
  practice.reset();
  state.mode = 'overview';
  elements.practicePanel.classList.remove('visible');
  setActiveMode('overview');
  updateAppClasses();
  if (state.viewMode === 'animated' || state.viewMode === 'real') realMapRenderer.fitRoute();
  else focusRenderer.fit(false, true);
  renderDynamic();
}

function renderPinyinWords(snapshot) {
  const container = $('#pinyinWords');
  container.innerHTML = '';
  const tokens = String(snapshot.targetStation?.pinyin || '待校核').split(/\s+/).filter(Boolean);
  let cursor = 0;
  tokens.forEach(token => {
    const normalized = normalizePinyin(token);
    const node = document.createElement('span');
    node.textContent = token;
    if (snapshot.value.length >= cursor + normalized.length) node.className = 'matched';
    else if (snapshot.value.length > cursor || snapshot.value.length === cursor) node.className = 'active';
    container.append(node);
    cursor += normalized.length;
  });
}

function renderTypingCells(snapshot) {
  const container = $('#typingCells');
  container.innerHTML = '';
  const raw = String(snapshot.targetStation?.pinyin || '').toLowerCase();
  let normalizedIndex = 0;
  for (const character of raw) {
    const node = document.createElement('span');
    if (/\s/.test(character)) {
      node.className = 'space';
      container.append(node);
      continue;
    }
    const normalizedCharacter = normalizePinyin(character);
    if (!normalizedCharacter) continue;
    node.textContent = normalizedCharacter;
    if (normalizedIndex < snapshot.value.length) node.classList.add('done');
    else if (normalizedIndex === snapshot.value.length) node.classList.add('current');
    normalizedIndex += 1;
    container.append(node);
  }
}

function renderPractice(snapshot) {
  if (state.mode !== 'timed' && state.mode !== 'full') return;
  elements.practicePanel.classList.add('visible');
  $('#practiceKicker').textContent = state.mode === 'timed' ? '30 秒 · 输入下一站拼音' : '全线 · 输入下一站拼音';
  $('#practiceStation').textContent = snapshot.targetStation?.name || snapshot.currentStation?.name || '—';
  $('#practiceNext').textContent = snapshot.targetStation
    ? `当前：${snapshot.currentStation?.name || '起点'} · 打完正好到站`
    : '已到达本线终点';
  $('#timeStat').textContent = state.mode === 'timed' ? snapshot.timeLeft : '∞';
  $('#stationStat').textContent = snapshot.completedStations;
  $('#speedStat').textContent = snapshot.cpm;
  $('#accuracyStat').textContent = `${Math.round(snapshot.accuracy * 100)}%`;
  const progress = snapshot.totalStations <= 1 ? 1 : snapshot.index / (snapshot.totalStations - 1);
  $('#practiceProgress').style.width = `${clamp((progress + snapshot.typingRatio / Math.max(1, snapshot.totalStations - 1)) * 100, 0, 100)}%`;
  renderPinyinWords(snapshot);
  renderTypingCells(snapshot);
  if (document.activeElement !== elements.typingInput && !snapshot.finished) setTimeout(restorePracticeTypingFocus, 0);
  renderDynamic();
}

async function handleTypingInput() {
  const result = practice.input(elements.typingInput.value);
  const feedback = $('#typingFeedback');
  if (result.type === 'invalid') {
    elements.typingInput.value = result.value;
    feedback.className = 'typing-feedback bad';
    feedback.textContent = '这个字符与下一站拼音不一致，请继续从高亮位置输入。';
    const typingArea = elements.typingInput.closest('.typing-area');
    typingArea.classList.remove('typing-error');
    void typingArea.offsetWidth;
    typingArea.classList.add('typing-error');
    return;
  }
  if (result.type === 'missing-target') {
    feedback.className = 'typing-feedback bad';
    feedback.textContent = '当前站拼音尚未生成，请先在校核中填写。';
    return;
  }
  elements.typingInput.value = result.value;
  feedback.className = 'typing-feedback';
  feedback.textContent = '继续输入，公交车会平滑驶向下一站。';
  if (result.type === 'complete') {
    const completionToken = ++state.stationCompletionToken;
    feedback.className = 'typing-feedback ok';
    feedback.textContent = '正确，正在平滑进站…';
    const station = practice.targetStation();
    audioPlayer.playStation(station).catch(() => {});
    await new Promise(resolve => setTimeout(resolve, 430));
    if (completionToken !== state.stationCompletionToken || practice.finished) return;
    const advanced = practice.advance();
    elements.typingInput.value = '';
    if (!advanced.finished) {
      feedback.className = 'typing-feedback';
      feedback.textContent = '下一站，继续输入它的拼音。';
      elements.typingInput.focus();
    }
  }
}

function showResult(snapshot) {
  elements.typingInput.blur();
  $('#resultTitle').textContent = snapshot.reason === 'timeout' ? '时间到站' : '全线完成';
  $('#resultSubtitle').textContent = state.route ? `${state.route.route_no} · ${displayStops()[0]?.name} → ${displayStops().at(-1)?.name}` : '—';
  $('#resultStations').textContent = snapshot.completedStations;
  $('#resultCpm').textContent = snapshot.cpm;
  $('#resultAccuracy').textContent = `${Math.round(snapshot.accuracy * 100)}%`;
  elements.resultModal.classList.add('visible');
}

async function startBroadcast() {
  if (!state.route || state.broadcasting) return;
  if (state.mode === 'timed' || state.mode === 'full') {
    practice.reset();
    state.mode = 'overview';
    elements.practicePanel.classList.remove('visible');
    setActiveMode('overview');
    updateAppClasses();
    focusRenderer.fit(false, true);
  }
  state.broadcasting = true;
  const token = ++state.broadcastToken;
  renderCards();
  const stops = displayStops();
  for (let index = 0; index < stops.length && state.broadcasting && token === state.broadcastToken; index += 1) {
    state.browseIndex = index;
    renderDynamic();
    try { await audioPlayer.playStation(stops[index]); } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 240));
  }
  if (token === state.broadcastToken) {
    state.broadcasting = false;
    renderCards();
    showToast('全线播报完成');
  }
}

function stopBroadcast(silent = false) {
  if (!state.broadcasting && !audioPlayer.audio) return;
  state.broadcasting = false;
  state.broadcastToken += 1;
  audioPlayer.stop();
  renderCards();
  if (!silent) showToast('已停止播报');
}

function toggleReverse() {
  if (!state.route) return;
  const stationName = currentStation()?.name;
  const currentOriginal = state.route.stops.findIndex(stop => stop.name === stationName);
  state.reverse = !state.reverse;
  const newDisplay = displayIndexFromOriginal(Math.max(0, currentOriginal));
  if (state.mode === 'timed' || state.mode === 'full') {
    setMode(state.mode);
  } else {
    state.browseIndex = newDisplay;
    renderDynamic();
  }
}

async function switchActualDirection() {
  if (!state.route) return;
  const sibling = state.route.siblings?.find(item => item.id !== state.route.id);
  if (!sibling) {
    showToast('当前线路没有可用的另一方向数据');
    return;
  }
  await selectRoute(sibling.id);
}

function renderSearchResults(items) {
  state.searchItems = items;
  state.activeSearchIndex = items.length ? 0 : -1;
  elements.searchResults.innerHTML = '';
  if (!items.length) {
    elements.searchResults.innerHTML = '<button class="search-result"><span class="search-result-badge">—</span><span class="search-result-copy"><strong>没有找到结果</strong><span>尝试输入线路号、起终点或站名。</span></span></button>';
  }
  items.forEach((item, index) => {
    const button = document.createElement('button');
    button.className = `search-result${index === state.activeSearchIndex ? ' active' : ''}`;
    button.innerHTML = `<span class="search-result-badge">${item.type === 'route' ? escapeHtml(item.title.split('·')[0].trim()) : '站'}</span><span class="search-result-copy"><strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(item.subtitle)}</span></span>`;
    button.addEventListener('click', () => chooseSearchItem(item));
    elements.searchResults.append(button);
  });
  elements.searchResults.classList.add('visible');
}

async function performSearch(query) {
  const value = query.trim();
  if (!value) {
    elements.searchResults.classList.remove('visible');
    return;
  }
  try {
    const data = await transitApi.search(value, 30);
    renderSearchResults(data.results);
  } catch (error) {
    showToast(error.message);
  }
}

function chooseSearchItem(item) {
  elements.searchResults.classList.remove('visible');
  elements.searchInput.value = item.title;
  if (item.type === 'route') selectRoute(item.id);
  else if (item.route_ids?.length) selectRoute(item.route_ids[0], item.title);
}

function updateActiveSearch(delta) {
  if (!state.searchItems.length) return;
  state.activeSearchIndex = (state.activeSearchIndex + delta + state.searchItems.length) % state.searchItems.length;
  elements.searchResults.querySelectorAll('.search-result').forEach((node, index) => node.classList.toggle('active', index === state.activeSearchIndex));
  elements.searchResults.querySelector('.search-result.active')?.scrollIntoView({block: 'nearest'});
}

function renderReviewPanel() {
  const station = currentStation();
  if (!station) return;
  $('#reviewStationName').textContent = station.name;
  if (document.activeElement !== $('#reviewPinyin')) $('#reviewPinyin').value = station.pinyin || '';
  if (document.activeElement !== $('#reviewJyutping')) $('#reviewJyutping').value = station.jyutping || '';
  if (document.activeElement !== $('#reviewAudioUrl')) $('#reviewAudioUrl').value = station.audioUrl || '';
  if (document.activeElement !== $('#reviewNote')) $('#reviewNote').value = station.reviewNote || '';
  getLocalAudio(station.name).then(blob => {
    $('#localAudioState').textContent = blob ? `已设置本机音频 · ${Math.round(blob.size / 1024)} KB` : '未设置本机音频';
  }).catch(() => {});
}

async function saveLanguage() {
  const station = currentStation();
  if (!station) return;
  try {
    const result = await transitApi.updateLanguage({
      name: station.name,
      pinyin: $('#reviewPinyin').value,
      jyutping: $('#reviewJyutping').value,
      audio_url: $('#reviewAudioUrl').value,
      note: $('#reviewNote').value,
    });
    state.route.stops.filter(stop => stop.name === station.name).forEach(stop => {
      stop.pinyin = result.item.pinyin;
      stop.pinyin_source = result.item.pinyin_source;
      stop.jyutping = result.item.jyutping;
      stop.audioUrl = result.item.audio_url;
      stop.reviewNote = result.item.note;
    });
    renderDynamic();
    showToast('站点语言设置已保存');
  } catch (error) {
    showToast(error.message);
  }
}

function restartPractice() {
  elements.resultModal.classList.remove('visible');
  if (state.mode !== 'timed' && state.mode !== 'full') state.mode = 'timed';
  setMode(state.mode);
}

function randomRoute() {
  if (!state.overview?.routes?.length) return;
  const matched = state.overview.routes.filter(route => route.match_state === 'matched');
  const pool = matched.length ? matched : state.overview.routes;
  const route = pool[Math.floor(Math.random() * pool.length)];
  selectRoute(route.id);
}

// Controls
document.querySelectorAll('.mode-button').forEach(button => button.addEventListener('click', () => setMode(button.dataset.mode)));
$('#homeButton').addEventListener('click', clearSelection);
$('#randomRouteButton').addEventListener('click', randomRoute);
$('#previousDirectionButton').addEventListener('click', toggleReverse);
$('#switchDirectionButton').addEventListener('click', switchActualDirection);
$('#broadcastButton').addEventListener('click', () => state.broadcasting ? stopBroadcast() : startBroadcast());
$('#speakButton').addEventListener('click', () => audioPlayer.playStation(currentStation()).catch(error => showToast(error.message)));
$('#locateButton').addEventListener('click', () => focusRenderer.fit(state.mode === 'timed' || state.mode === 'full', true));
$('#schematicToggle').addEventListener('change', event => { state.schematic = event.target.checked; rebuildFocusScene({fit: true, animate: true}); });
$('#balancedToggle').addEventListener('change', event => { state.balanced = event.target.checked; rebuildFocusScene({fit: true, animate: true}); });
$('#labelsToggle').addEventListener('change', event => { state.allLabels = event.target.checked; renderDynamic(); });
$('#flatViewButton').addEventListener('click', () => setViewMode('flat'));
$('#animatedViewButton').addEventListener('click', () => setViewMode('animated'));
$('#realMapViewButton').addEventListener('click', () => setViewMode('real'));
$('#practiceFlatButton').addEventListener('click', () => setViewMode('flat'));
$('#practiceAnimatedButton').addEventListener('click', () => setViewMode('animated'));
$('#practiceRealButton').addEventListener('click', () => setViewMode('real'));
$('#exitPracticeButton').addEventListener('click', exitPractice);
elements.typingInput.addEventListener('input', handleTypingInput);
elements.typingInput.closest('.typing-area').addEventListener('animationend', event => {
  if (event.animationName === 'typingError') event.currentTarget.classList.remove('typing-error');
});
elements.practicePanel.addEventListener('click', event => { if (!event.target.closest('button')) elements.typingInput.focus(); });
// Buttons, maps and other controls may take focus on pointer-down. Restore the
// hidden practice input from the same click so the next keystroke keeps typing.
document.addEventListener('click', restorePracticeTypingFocus, true);

const debouncedSearch = debounce(value => performSearch(value), 180);
elements.searchInput.addEventListener('input', event => debouncedSearch(event.target.value));
elements.searchInput.addEventListener('keydown', event => {
  if (event.key === 'ArrowDown') { event.preventDefault(); updateActiveSearch(1); }
  else if (event.key === 'ArrowUp') { event.preventDefault(); updateActiveSearch(-1); }
  else if (event.key === 'Enter') {
    event.preventDefault();
    const item = state.searchItems[state.activeSearchIndex];
    if (elements.searchResults.classList.contains('visible') && item) chooseSearchItem(item);
    else performSearch(elements.searchInput.value);
  } else if (event.key === 'Escape') elements.searchResults.classList.remove('visible');
});
document.addEventListener('click', event => { if (!event.target.closest('#searchShell')) elements.searchResults.classList.remove('visible'); });

$('#reviewButton').addEventListener('click', () => {
  if (!currentStation()) { showToast('请先选择线路和站点'); return; }
  elements.reviewDrawer.classList.add('visible');
  renderReviewPanel();
});
$('#reviewCloseButton').addEventListener('click', () => elements.reviewDrawer.classList.remove('visible'));
$('#saveLanguageButton').addEventListener('click', saveLanguage);
$('#playReviewAudioButton').addEventListener('click', () => audioPlayer.playStation(currentStation()).catch(error => showToast(error.message)));
$('#chooseLocalAudioButton').addEventListener('click', () => $('#localAudioFile').click());
$('#localAudioFile').addEventListener('change', async event => {
  const file = event.target.files?.[0];
  const station = currentStation();
  if (!file || !station) return;
  try {
    await putLocalAudio(station.name, file);
    renderReviewPanel();
    showToast('本机粤语音频已保存');
  } catch (error) { showToast(error.message); }
  event.target.value = '';
});
$('#clearLocalAudioButton').addEventListener('click', async () => {
  const station = currentStation();
  if (!station) return;
  await deleteLocalAudio(station.name);
  renderReviewPanel();
  showToast('本机音频已移除');
});
$('#restartButton').addEventListener('click', restartPractice);
$('#resultHomeButton').addEventListener('click', clearSelection);

// Pointer navigation
elements.stage.addEventListener('pointerdown', event => {
  if (event.button !== 0 || state.viewMode === 'animated' || state.viewMode === 'real') return;
  state.dragging = true;
  state.moved = false;
  state.lastPointer = [event.clientX, event.clientY];
  elements.stage.setPointerCapture?.(event.pointerId);
  document.body.classList.add('is-panning');
});
elements.stage.addEventListener('pointermove', event => {
  if (!state.dragging) return;
  const dx = event.clientX - state.lastPointer[0];
  const dy = event.clientY - state.lastPointer[1];
  if (Math.abs(dx) + Math.abs(dy) > 2) state.moved = true;
  if (state.route) focusRenderer.panByPixels(dx, dy);
  else overviewRenderer.panByPixels(dx, dy);
  state.lastPointer = [event.clientX, event.clientY];
});
elements.stage.addEventListener('pointerup', event => {
  if (!state.dragging) return;
  state.dragging = false;
  document.body.classList.remove('is-panning');
  if (!state.moved && !state.route) {
    const route = overviewRenderer.nearestRoute(event.clientX, event.clientY);
    if (route) selectRoute(route.id);
  }
});
elements.stage.addEventListener('pointercancel', () => { state.dragging = false; document.body.classList.remove('is-panning'); });
elements.stage.addEventListener('wheel', event => {
  if (state.viewMode === 'animated' || state.viewMode === 'real') return;
  event.preventDefault();
  const factor = Math.exp(event.deltaY * .0012);
  if (state.route) focusRenderer.zoomAt(event.clientX, event.clientY, factor);
  else overviewRenderer.zoomAt(event.clientX, event.clientY, factor);
}, {passive: false});

window.addEventListener('resize', () => {
  overviewRenderer.resize();
  if (state.route) focusRenderer.fit(state.mode === 'timed' || state.mode === 'full', false);
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    if (state.broadcasting) stopBroadcast();
    else if (elements.resultModal.classList.contains('visible')) elements.resultModal.classList.remove('visible');
    else if (elements.reviewDrawer.classList.contains('visible')) elements.reviewDrawer.classList.remove('visible');
    else if (state.mode === 'timed' || state.mode === 'full') exitPractice();
    else if (state.route) clearSelection();
  }
  if (event.code === 'Space' && !['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName) && currentStation()) {
    event.preventDefault();
    audioPlayer.playStation(currentStation()).catch(error => showToast(error.message));
  }
});

function configureNetworkUi() {
  const metro = state.networkType === 'metro';
  document.title = metro ? '站粤地铁 · 深圳地铁拼音与粤语学习' : '站粤公交 · 深圳公交拼音与粤语学习';
  const brand = document.querySelector('.brand');
  if (brand) brand.href = metro ? '/metro/learn' : '/bus/learn';
  const mark = document.querySelector('.brand-mark');
  if (mark) mark.textContent = metro ? '轨' : '粤';
  const brandStrong = document.querySelector('.brand-copy strong');
  if (brandStrong) brandStrong.textContent = metro ? '站粤地铁' : '站粤公交';
  const brandSmall = document.querySelector('.brand-copy small');
  if (brandSmall) brandSmall.textContent = metro ? 'Shenzhen Metro Typing' : 'Shenzhen Bus Typing';
  const mapLink = document.querySelector('.top-actions a.text-button');
  if (mapLink) {
    mapLink.href = transitApi.endpoints.map;
    mapLink.textContent = metro ? '地铁图' : '地理图';
  }
  const introTitle = document.querySelector('#intro h1');
  if (introTitle) introTitle.innerHTML = metro ? '沿着深圳地铁，<br>记住每一个站。' : '沿着一条公交线路，<br>记住深圳的每一个站。';
  const collectorLink = document.querySelector('.intro-actions .ghost-link');
  if (collectorLink) collectorLink.href = transitApi.endpoints.collector;
  const loadingStrong = elements.loading.querySelector('strong');
  if (loadingStrong) loadingStrong.textContent = metro ? '正在读取地铁线网' : '正在读取公交线网';
  const exportLink = document.querySelector('.drawer-export');
  if (exportLink) exportLink.href = transitApi.endpoints.languageExport;
  elements.stage.setAttribute('aria-label', metro ? '深圳地铁线路学习地图' : '深圳公交线路学习地图');
  elements.svg.setAttribute('aria-label', metro ? '当前地铁线路示意图' : '当前公交线路示意图');
  elements.realMap.setAttribute('aria-label', metro ? '当前地铁线路真实地图' : '当前公交线路真实地图');
}

async function init() {
  configureNetworkUi();
  try {
    const [overview, config] = await Promise.all([
      transitApi.overview(),
      transitApi.publicConfig().catch(() => ({map_ready: false, admin_enabled: false})),
    ]);
    state.overview = overview;
    state.mapReady = Boolean(config.map_ready);
    if (!config.admin_enabled) {
      document.querySelectorAll('.admin-only, #reviewButton').forEach(node => { node.hidden = true; });
    }
    updateViewControls();
    overviewRenderer.setData(overview);
    overviewRenderer.resize();
    $('#networkMeta').textContent = `${overview.stats.directions} 个方向 · ${overview.stats.station_clusters} 个站点簇 · Canvas 全网 / SVG 单线`;
    elements.loading.classList.add('hidden');
    const routeId = new URLSearchParams(window.location.search).get('route');
    if (routeId) selectRoute(routeId);
  } catch (error) {
    elements.loading.innerHTML = `<strong>尚未生成${state.networkType === 'metro' ? '地铁' : '公交'}线网数据</strong><small>${escapeHtml(error.message)}<br><br><a href="${transitApi.endpoints.collector}" style="color:#fff">进入采集页面并构建全网 →</a></small>`;
  }
}

init();
