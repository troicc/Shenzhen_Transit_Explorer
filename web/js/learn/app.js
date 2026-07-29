import {$, clamp, damp, debounce, escapeHtml, normalizePinyin, routeColor, showToast, travelIndex} from './core.js?v=3';
import {transitApi} from './api.js';
import {buildRouteGeometry, routeGeometryCacheKey} from './geometry.js';
import {createJourneyFrame} from './journey.js';
import {deleteLocalAudio, getLocalAudio, putLocalAudio, StationAudioPlayer} from './audio.js';
import {LearnExperience} from './experience.js';
import {
  fallbackExperienceProfile,
  resolveExperienceProfile,
  userExperienceOverrideAllowed,
} from './experience-profile.js';
import {PracticeEngine} from './practice.js?v=4';
import {learnProduct} from './product.js?v=2';
import {RealMapFocusRenderer} from './real-map.js?v=3';
import {FocusRenderer, OverviewRenderer} from './renderers.js?v=5';
import {MetroSchematicOverviewRenderer} from './metro-overview.js';
import {NavigationController} from './navigation-controller.js';
import {RouteStretchController} from './route-stretch.js';
import {spellingLabel, spellingTarget, VALID_SPELLING_SCHEMES} from './spelling.js';
import {LearnStore} from './store.js';
import {restoreTypingFocus} from './typing-focus.js?v=3';
import {overviewZoomProgress} from './view-progress.js';

const product = learnProduct(transitApi.networkType);
const reducedMotion = Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
const PRACTICE_PREFERENCES_KEY = 'transit.learn.practice.preferences';

function loadPracticePreferences() {
  try {
    const value = JSON.parse(window.localStorage?.getItem(PRACTICE_PREFERENCES_KEY) || '{}');
    return {
      spellingScheme: VALID_SPELLING_SCHEMES.has(value.spellingScheme) ? value.spellingScheme : 'pinyin',
      inlineHint: Boolean(value.inlineHint),
    };
  } catch (_) {
    return {spellingScheme: 'pinyin', inlineHint: false};
  }
}

function savePracticePreferences() {
  try {
    window.localStorage?.setItem(PRACTICE_PREFERENCES_KEY, JSON.stringify({
      spellingScheme: state.spellingScheme,
      inlineHint: state.inlineHint,
    }));
  } catch (_) {}
}

const practicePreferences = loadPracticePreferences();
const learnStore = new LearnStore({cameraMode: product.id === 'metro' ? 'follow' : 'full'});
const elements = {
  app: $('#app'), stage: $('#mapStage'), flipScene: $('#learnFlipScene'), canvas: $('#networkCanvas'), svg: $('#focusSvg'), realMap: $('#realMap'),
  routeLayer: $('#routeLayer'), stationLayer: $('#stationLayer'), labelLayer: $('#labelLayer'), effectLayer: $('#effectLayer'), train: $('#vehicle'),
  metroDistrictLayer: $('#metroDistrictLayer'), metroOverviewRouteLayer: $('#metroOverviewRouteLayer'),
  metroOverviewStationLayer: $('#metroOverviewStationLayer'), metroOverviewTransferLayer: $('#metroOverviewTransferLayer'),
  metroLineStrip: $('#metroLineStrip'),
  loading: $('#loading'), intro: $('#intro'), routeCard: $('#routeCard'), stationCard: $('#stationCard'),
  practicePanel: $('#practicePanel'), searchShell: $('#searchShell'), searchInput: $('#searchInput'), searchResults: $('#searchResults'),
  reviewDrawer: $('#reviewDrawer'), resultModal: $('#resultModal'), typingInput: $('#typingInput'), cameraModeSwitch: $('#cameraModeSwitch'),
  spellingScheme: $('#spellingScheme'), inlineHintToggle: $('#inlineHintToggle'), typingGhost: $('#typingGhost'),
  layoutUpdateNotice: $('#layoutUpdateNotice'), reloadLayoutButton: $('#reloadLayoutButton'),
};

const state = {
  overview: null,
  presentation: null,
  networkType: transitApi.networkType,
  color: '#5cc8ff',
  schematic: true,
  balanced: true,
  allLabels: false,
  geometryCache: new Map(),
  pendingStationName: null,
  loadingRouteToken: 0,
  broadcastToken: 0,
  activeSearchIndex: -1,
  searchItems: [],
  stationCompletionToken: 0,
  mapReady: false,
  runtime: null,
  experienceProfile: fallbackExperienceProfile(transitApi.networkType),
  allowExperienceOverride: true,
  returning: false,
  journeyMotionFrame: 0,
  journeyMotionRatio: 0,
  journeyMotionTarget: 0,
  journeyMotionKey: null,
  journeyMotionLastAt: 0,
  journeyMotionWaiters: new Set(),
  overviewIntroProgress: 0,
  spellingScheme: practicePreferences.spellingScheme,
  inlineHint: practicePreferences.inlineHint,
};
Object.defineProperties(state, {
  route: {get: () => learnStore.getState().route},
  reverse: {get: () => learnStore.getState().direction === 'reverse'},
  browseIndex: {get: () => learnStore.getState().browseIndex},
  mode: {get: () => learnStore.getState().practiceMode},
  viewMode: {get: () => learnStore.getState().viewMode},
  cameraMode: {get: () => learnStore.getState().cameraMode},
  broadcasting: {get: () => learnStore.getState().broadcasting},
  presentationRevision: {get: () => learnStore.getState().presentationRevision},
});

const overviewRenderer = state.networkType === 'metro'
  ? new MetroSchematicOverviewRenderer({
    svg: elements.svg,
    stage: elements.stage,
    routeLayer: elements.metroOverviewRouteLayer,
    districtLayer: elements.metroDistrictLayer,
    stationLayer: elements.metroOverviewStationLayer,
    transferLayer: elements.metroOverviewTransferLayer,
    lineStrip: elements.metroLineStrip,
    onRouteSelect: routeId => selectRoute(routeId),
    onViewChange: updateOverviewIntro,
  })
  : new OverviewRenderer({canvas: elements.canvas, stage: elements.stage, onViewChange: updateOverviewIntro});
const focusRenderer = new FocusRenderer({
  svg: elements.svg,
  routeLayer: elements.routeLayer,
  stationLayer: elements.stationLayer,
  labelLayer: elements.labelLayer,
  effectLayer: elements.effectLayer,
  train: elements.train,
  stage: elements.stage,
  onStationClick: originalIndex => selectStationByOriginalIndex(originalIndex),
});
const stretchController = new RouteStretchController({
  renderer: focusRenderer,
  overviewRenderer,
  maximumScale: state.networkType === 'metro' ? 2.7 : 1.85,
  reducedMotion,
});
const audioPlayer = new StationAudioPlayer();
const realMapRenderer = new RealMapFocusRenderer({container: elements.realMap});
const experience = new LearnExperience({
  profile: state.experienceProfile,
  network: state.networkType,
  appElement: elements.app,
  flipScene: elements.flipScene,
  focusRenderer,
  overviewRenderer,
  realMapRenderer,
  stretchController,
  cameraMode: state.cameraMode,
  reducedMotion,
});
const navigationAdapter = {
  panByPixels(dx, dy) {
    (state.route ? focusRenderer : overviewRenderer).panByPixels(dx, dy);
  },
  zoomAt(x, y, factor) {
    (state.route ? focusRenderer : overviewRenderer).zoomAt(x, y, factor);
  },
  beginManualNavigation() {
    if (state.route) focusRenderer.beginManualNavigation();
  },
  endManualNavigation() {
    if (state.route) focusRenderer.endManualNavigation();
  },
};
const navigationController = new NavigationController({
  target: elements.stage,
  renderer: navigationAdapter,
  enabled: () => state.viewMode === 'flat',
  isFlipped: () => !state.route && Boolean(overviewRenderer.flipped),
  onTap: event => {
    if (state.route) return;
    const route = overviewRenderer.nearestRoute(event.clientX, event.clientY);
    if (route) selectRoute(route.id);
  },
  onBackgroundDoubleClick: () => {
    if (!state.route || state.returning) return;
    clearSelection({source: 'background-double-click'});
  },
  isInteractiveTarget: target => Boolean(target?.closest?.([
    '.route-hit',
    '.station-node',
    '.metro-overview-route',
    '.metro-overview-transfer',
    '.target-station-beacon',
    'button',
    'a',
    'input',
    'select',
    'textarea',
    'label',
    '[data-no-background-return]',
  ].join(','))),
  onInteractionStart: source => {
    document.body.classList.add('is-map-navigating');
    document.body.classList.toggle('is-panning', source === 'pointer');
    if (!state.route) elements.app.classList.add('overview-navigation-active');
    if (state.route) experience.suspendForManualNavigation();
  },
  onInteractionEnd: () => {
    document.body.classList.remove('is-map-navigating', 'is-panning');
    elements.app.classList.remove('overview-navigation-active');
    commitOverviewIntroEffects();
  },
});
const practice = new PracticeEngine({
  onChange: snapshot => renderPractice(snapshot),
  onFinish: snapshot => showResult(snapshot),
  targetForStation: station => spellingTarget(station, state.spellingScheme),
});
let layoutChannel = null;

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
  return state.mode === 'timed' || state.mode === 'full' ? practice.snapshot().arrivedIndex : state.browseIndex;
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
  const key = routeGeometryCacheKey(state.route, {
    revision: state.route.presentation_revision || state.presentationRevision,
    schematic: state.schematic,
    balanced: state.balanced,
  });
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

function updateOverviewIntro({zoomRatio = 1, focused = false} = {}) {
  const ratio = Math.max(.0001, Number(zoomRatio) || 1);
  const progress = state.route || focused
    ? 1
    : overviewZoomProgress(1, 1 / ratio);
  state.overviewIntroProgress = progress;
  elements.app.style.setProperty('--overview-zoom-progress', progress.toFixed(4));
  elements.app.style.setProperty('--overview-intro-opacity', Math.max(.04, 1 - progress * .96).toFixed(4));
  elements.app.style.setProperty('--overview-intro-scale', (1 + progress * .12).toFixed(4));
  if (!elements.app.classList.contains('overview-navigation-active')) {
    elements.app.style.setProperty('--overview-intro-blur', `${(progress * 10).toFixed(2)}px`);
  }
  const hiddenByZoom = progress >= .72;
  elements.app.classList.toggle('intro-zoom-obscured', hiddenByZoom);
  elements.intro.toggleAttribute('inert', hiddenByZoom);
  elements.intro.setAttribute('aria-hidden', String(hiddenByZoom));
}

function commitOverviewIntroEffects() {
  const progress = clamp(state.overviewIntroProgress, 0, 1);
  elements.app.style.setProperty('--overview-intro-blur', `${(progress * 10).toFixed(2)}px`);
}

function updateCameraModeControls() {
  const visible = Boolean(state.route)
    && state.viewMode === 'flat'
    && state.allowExperienceOverride
    && experience.has('cameraFollow');
  elements.cameraModeSwitch.hidden = !visible;
  elements.cameraModeSwitch.querySelectorAll('[data-camera-mode]').forEach(button => {
    const active = button.dataset.cameraMode === state.cameraMode;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
}

async function setExperienceProfile(profile, {reframe = true} = {}) {
  state.experienceProfile = experience.setProfile(profile);
  experience.setCameraMode(state.cameraMode);
  updateCameraModeControls();
  if (!state.route || !reframe) return;
  await fitCurrentExperience({animate: true});
  renderDynamic();
  restorePracticeTypingFocus();
}

function fitCurrentExperience({animate = true, forcePractice = null} = {}) {
  if (!state.route) return Promise.resolve(false);
  const practiceVisible = forcePractice ?? (state.mode === 'timed' || state.mode === 'full');
  const frame = journeyFrame(state.journeyMotionRatio);
  return experience.reframe(frame, {practiceVisible, animate});
}

async function setCameraMode(mode) {
  learnStore.dispatch({type: 'CAMERA_MODE_CHANGED', mode});
  experience.setCameraMode(state.cameraMode);
  updateCameraModeControls();
  if (state.route && state.viewMode === 'flat') {
    await fitCurrentExperience({animate: true});
    renderDynamic();
  }
  restorePracticeTypingFocus();
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
  updateCameraModeControls();
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
    learnStore.dispatch({type: 'VIEW_CHANGED', mode: 'flat'});
    realMapRenderer.hide();
    updateAppClasses();
    updateViewControls();
    await fitCurrentExperience({animate: true});
    renderDynamic();
    restorePracticeTypingFocus();
    return;
  }
  experience.suspendForManualNavigation();
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
    learnStore.dispatch({type: 'VIEW_CHANGED', mode});
    updateAppClasses();
    updateViewControls();
    renderDynamic();
  } catch (error) {
    learnStore.dispatch({type: 'VIEW_CHANGED', mode: 'flat'});
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
  stretchController.setRoute(state.route, geometry);
  if (fit && experience.has('routeStretch')) stretchController.apply(1);
  focusRenderer.setVehicleType(product.vehicle);
  experience.setProfile(state.experienceProfile);
  experience.setCameraMode(state.cameraMode);
  renderDynamic();
  if (fit) fitCurrentExperience({animate});
}

async function selectRoute(routeId, stationName = null) {
  const token = ++state.loadingRouteToken;
  const enteringFromOverview = !state.route;
  state.returning = false;
  elements.app.classList.remove('returning');
  elements.loading.classList.remove('hidden');
  elements.loading.querySelector('strong').textContent = '正在进入线路';
  elements.loading.querySelector('small').textContent = '正在加载详细折线、站序、拼音和语言设置。';
  try {
    const route = await transitApi.route(routeId);
    if (token !== state.loadingRouteToken) return;
    stopBroadcast(true);
    practice.reset();
    learnStore.dispatch({type: 'ROUTE_SELECTED', route});
    state.color = route.color || routeColor(route.route_no);
    state.pendingStationName = stationName;
    state.geometryCache.clear();
    realMapRenderer.hide();
    if (enteringFromOverview) experience.setFace('overview');
    if (stationName) {
      const index = route.stops.findIndex(stop => stop.name === stationName);
      if (index >= 0) learnStore.dispatch({type: 'BROWSE_CHANGED', index});
    }
    overviewRenderer.setFocused(true, route.id);
    overviewRenderer.view = {...overviewRenderer.homeView};
    overviewRenderer.draw();
    elements.intro.classList.add('hidden');
    updateOverviewIntro({zoomRatio: 1, focused: true});
    elements.routeCard.classList.add('visible');
    elements.stationCard.classList.add('visible');
    elements.resultModal.classList.remove('visible');
    setActiveMode('overview');
    updateAppClasses();
    updateViewControls();
    if (enteringFromOverview && overviewRenderer.getView) {
      focusRenderer.setView(overviewRenderer.getView(), {animate: false});
    }
    rebuildFocusScene({fit: false});
    renderCards();
    await experience.enterRoute(journeyFrame(0));
  } catch (error) {
    showToast(error.message);
  } finally {
    if (token === state.loadingRouteToken) elements.loading.classList.add('hidden');
  }
}

async function clearSelection({source = 'explicit'} = {}) {
  if (!state.route || state.returning) return;
  navigationController.cancelActiveInteraction();
  const token = ++state.loadingRouteToken;
  ++state.stationCompletionToken;
  state.returning = true;
  elements.app.classList.add('returning');
  stopBroadcast(true);
  stopJourneyMotion();
  practice.reset();
  learnStore.dispatch({type: 'PRACTICE_EXITED'});
  elements.practicePanel.classList.remove('visible');
  elements.reviewDrawer.classList.remove('visible');
  elements.resultModal.classList.remove('visible');
  setActiveMode('overview');
  learnStore.dispatch({type: 'VIEW_CHANGED', mode: 'flat'});
  realMapRenderer.hide();
  updateAppClasses();
  await experience.returnOverview(journeyFrame(0));
  if (token !== state.loadingRouteToken) return;
  learnStore.dispatch({type: 'ROUTE_CLEARED'});
  focusRenderer.clear();
  realMapRenderer.hide();
  elements.intro.classList.remove('hidden');
  elements.routeCard.classList.remove('visible');
  elements.stationCard.classList.remove('visible');
  elements.loading.classList.add('hidden');
  elements.app.dataset.returnSource = source;
  state.returning = false;
  elements.app.classList.remove('returning');
  updateAppClasses();
  updateViewControls();
  updateOverviewIntro({zoomRatio: 1, focused: false});
}

function selectStationByOriginalIndex(originalIndex) {
  if (!state.route) return;
  if (state.mode === 'timed' || state.mode === 'full') {
    showToast('练习中不能跳站，按 Esc 可退出练习');
    return;
  }
  learnStore.dispatch({type: 'BROWSE_CHANGED', index: displayIndexFromOriginal(originalIndex)});
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

function settleJourneyMotionWaiters(completed) {
  const waiters = [...state.journeyMotionWaiters];
  state.journeyMotionWaiters.clear();
  waiters.forEach(resolve => resolve(completed));
}

function stopJourneyMotion(ratio = 0, key = null) {
  cancelAnimationFrame(state.journeyMotionFrame);
  state.journeyMotionFrame = 0;
  state.journeyMotionRatio = ratio;
  state.journeyMotionTarget = ratio;
  state.journeyMotionKey = key;
  state.journeyMotionLastAt = 0;
  settleJourneyMotionWaiters(false);
}

function journeyFrame(motionRatio, overrides = {}) {
  const snapshot = practice.snapshot();
  const practiceSession = state.mode === 'timed' || state.mode === 'full';
  const active = practiceSession && practice.running;
  const browseIndex = displayIndex();
  const arrivedIndex = practiceSession ? snapshot.arrivedIndex : browseIndex;
  const targetIndex = practiceSession
    ? snapshot.targetIndex
    : (browseIndex + 1 < state.route.stops.length ? browseIndex + 1 : null);
  const challengeIndex = practiceSession ? snapshot.challengeIndex : null;
  const geometry = currentGeometry();
  return createJourneyFrame({
    network: state.networkType,
    route: state.route,
    direction: state.reverse ? 'reverse' : 'forward',
    arrivedIndex,
    targetIndex,
    challengeIndex,
    typingRatio: motionRatio,
    geometry,
    allLabels: state.allLabels,
    journeyActive: active,
    practiceMode: state.mode,
    mapMode: state.viewMode,
    phase: practiceSession ? snapshot.phase : 'idle',
    overrides,
  });
}

function renderJourneyFrame(motionRatio) {
  if (!state.route) return;
  const frame = journeyFrame(motionRatio);
  focusRenderer.renderDynamic(frame);
  if (state.viewMode === 'animated' || state.viewMode === 'real') realMapRenderer.renderDynamic(frame);
  experience.updateJourney(frame);
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
  } else {
    settleJourneyMotionWaiters(true);
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

function animateJourneyMotionTo(targetRatio) {
  syncJourneyMotion(targetRatio);
  if (state.journeyMotionRatio === state.journeyMotionTarget) return Promise.resolve(true);
  return new Promise(resolve => state.journeyMotionWaiters.add(resolve));
}

function renderDynamic() {
  if (!state.route) return;
  const snapshot = practice.snapshot();
  const journeyActive = state.mode === 'timed' || state.mode === 'full';
  const motionRatio = journeyActive ? syncJourneyMotion(snapshot.motionRatio) : 0;
  if (!journeyActive && state.journeyMotionKey != null) stopJourneyMotion();
  renderJourneyFrame(motionRatio);
  renderCards();
  if (elements.reviewDrawer.classList.contains('visible')) renderReviewPanel();
}

async function setMode(mode) {
  if (mode === 'overview') {
    clearSelection();
    return;
  }
  if (!state.route) {
    showToast('请先选择一条线路');
    return;
  }
  stopBroadcast(true);
  learnStore.dispatch({type: 'PRACTICE_STARTED', mode});
  stopJourneyMotion();
  practice.start(displayStops(), mode);
  $('#typingFeedback').className = 'typing-feedback';
  $('#typingFeedback').textContent = product.feedback;
  elements.practicePanel.classList.add('visible');
  setActiveMode(mode);
  updateAppClasses();
  renderDynamic();
  await experience.enterPractice(journeyFrame(0));
  elements.typingInput.value = '';
  setTimeout(() => elements.typingInput.focus(), 90);
}

function exitPractice() {
  if (state.mode !== 'timed' && state.mode !== 'full') return;
  ++state.stationCompletionToken;
  stopJourneyMotion();
  practice.reset();
  learnStore.dispatch({type: 'PRACTICE_EXITED'});
  elements.practicePanel.classList.remove('visible');
  setActiveMode('overview');
  updateAppClasses();
  experience.leavePractice(journeyFrame(0));
  if (state.viewMode === 'animated' || state.viewMode === 'real') realMapRenderer.fitRoute();
  renderDynamic();
}

function renderPinyinWords(snapshot) {
  const container = $('#pinyinWords');
  container.innerHTML = '';
  const tokens = String(snapshot.targetDisplay || '待校核').split(/\s+/).filter(Boolean);
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
  const raw = String(snapshot.targetDisplay || '').toLowerCase();
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

function renderTypingGhost(snapshot) {
  elements.typingGhost.replaceChildren();
  elements.typingInput.closest('.typing-area').classList.toggle('inline-hint', state.inlineHint);
  if (!state.inlineHint) return;
  const raw = String(snapshot.targetDisplay || '').toLowerCase();
  let normalizedIndex = 0;
  for (const character of raw) {
    const node = document.createElement('span');
    const normalizedCharacter = normalizePinyin(character);
    if (/\s/.test(character)) {
      node.className = 'pending';
      node.textContent = '\u00a0';
    } else if (!normalizedCharacter) {
      node.className = /[1-5]/.test(character) ? 'tone' : 'pending';
      node.textContent = character;
    } else {
      node.className = normalizedIndex < snapshot.value.length
        ? 'typed'
        : normalizedIndex === snapshot.value.length ? 'cursor-char' : 'pending';
      node.textContent = character;
      normalizedIndex += normalizedCharacter.length;
    }
    elements.typingGhost.append(node);
  }
}

function renderPractice(snapshot) {
  if (state.mode !== 'timed' && state.mode !== 'full') return;
  elements.practicePanel.classList.add('visible');
  const scheme = spellingLabel(state.spellingScheme);
  $('#practiceKicker').textContent = state.mode === 'timed' ? `30 秒 · ${scheme}` : `全线 · ${scheme}`;
  $('#practiceStation').textContent = snapshot.targetStation?.name || snapshot.currentStation?.name || '—';
  $('#practiceNext').textContent = !snapshot.targetStation
    ? '已完成本线全部站点'
    : snapshot.originChallenge
      ? '起点确认 · 车辆保持原位'
      : `从 ${snapshot.currentStation?.name || '起点'} 出发前往下一站`;
  $('#timeStat').textContent = state.mode === 'timed' ? snapshot.timeLeft : '∞';
  $('#stationStat').textContent = snapshot.completedStations;
  $('#speedStat').textContent = snapshot.cpm;
  $('#accuracyStat').textContent = `${Math.round(snapshot.accuracy * 100)}%`;
  $('#practiceProgress').style.width = `${clamp(snapshot.progressRatio * 100, 0, 100)}%`;
  renderPinyinWords(snapshot);
  renderTypingCells(snapshot);
  renderTypingGhost(snapshot);
  if (document.activeElement !== elements.typingInput && !snapshot.finished) setTimeout(restorePracticeTypingFocus, 0);
  renderDynamic();
}

async function handleTypingInput() {
  const result = practice.input(elements.typingInput.value);
  const feedback = $('#typingFeedback');
  if (result.type === 'invalid') {
    elements.typingInput.value = result.value;
    feedback.className = 'typing-feedback bad';
    feedback.textContent = '这个字符与目标拼音不一致，请继续从高亮位置输入。';
    const typingArea = elements.typingInput.closest('.typing-area');
    typingArea.classList.remove('typing-error');
    void typingArea.offsetWidth;
    typingArea.classList.add('typing-error');
    return;
  }
  if (result.type === 'missing-target') {
    feedback.className = 'typing-feedback bad';
    feedback.textContent = `目标站缺少${spellingLabel(state.spellingScheme)}，请先在校核中填写。`;
    return;
  }
  elements.typingInput.value = result.value;
  const snapshot = practice.snapshot();
  feedback.className = 'typing-feedback';
  feedback.textContent = snapshot.originChallenge
    ? `继续输入，${product.movingNoun}停靠在起点。`
    : `继续输入，${product.movingNoun}正平滑驶向目标站。`;
  if (result.type === 'complete') {
    const completionToken = ++state.stationCompletionToken;
    feedback.className = 'typing-feedback ok';
    feedback.textContent = result.stationary ? '正确，起点确认完成。' : '正确，正在平滑进站…';
    const station = practice.targetStation();
    audioPlayer.playStation(station).catch(error => showToast(error.message));
    const arrivalOriginalIndex = Number.isInteger(snapshot.challengeIndex)
      ? originalIndexFromDisplay(snapshot.challengeIndex)
      : null;
    const arrivalFrame = journeyFrame(result.stationary ? 0 : 1, {
      forceCamera: !result.stationary,
      arrivalOriginalIndex,
      stationaryArrival: result.stationary,
    });
    if (result.stationary) {
      stopJourneyMotion(0, state.journeyMotionKey);
      renderJourneyFrame(0);
    } else {
      const arrived = await animateJourneyMotionTo(1);
      if (completionToken !== state.stationCompletionToken || practice.finished) return;
      if (!arrived) return;
      renderJourneyFrame(1);
    }
    await experience.arrive(arrivalFrame);
    if (completionToken !== state.stationCompletionToken || practice.finished) return;
    const advanced = practice.advance();
    elements.typingInput.value = '';
    if (!advanced.finished) {
      feedback.className = 'typing-feedback';
      feedback.textContent = '继续输入目标站拼音。';
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
  if (snapshot.reason === 'complete' && state.mode === 'full') {
    experience.completeLine(journeyFrame(1));
    if (state.viewMode === 'animated' || state.viewMode === 'real') realMapRenderer.fitRoute();
  } else {
    experience.leavePractice(journeyFrame(1));
    if (state.viewMode === 'animated' || state.viewMode === 'real') realMapRenderer.fitRoute();
  }
}

async function startBroadcast() {
  if (!state.route || state.broadcasting) return;
  if (state.mode === 'timed' || state.mode === 'full') {
    practice.reset();
    learnStore.dispatch({type: 'PRACTICE_EXITED'});
    elements.practicePanel.classList.remove('visible');
    setActiveMode('overview');
    updateAppClasses();
    experience.leavePractice(journeyFrame(0));
  }
  learnStore.dispatch({type: 'BROADCAST_CHANGED', broadcasting: true});
  const token = ++state.broadcastToken;
  renderCards();
  const stops = displayStops();
  for (let index = 0; index < stops.length && state.broadcasting && token === state.broadcastToken; index += 1) {
    learnStore.dispatch({type: 'BROWSE_CHANGED', index});
    renderDynamic();
    try {
      await audioPlayer.playStation(stops[index]);
    } catch (error) {
      if (token === state.broadcastToken) {
        learnStore.dispatch({type: 'BROADCAST_CHANGED', broadcasting: false});
        renderCards();
        showToast(error.message);
      }
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 240));
  }
  if (token === state.broadcastToken) {
    learnStore.dispatch({type: 'BROADCAST_CHANGED', broadcasting: false});
    renderCards();
    showToast('全线播报完成');
  }
}

function stopBroadcast(silent = false) {
  if (!state.broadcasting && !audioPlayer.audio) return;
  learnStore.dispatch({type: 'BROADCAST_CHANGED', broadcasting: false});
  state.broadcastToken += 1;
  audioPlayer.stop();
  renderCards();
  if (!silent) showToast('已停止播报');
}

function toggleReverse() {
  if (!state.route) return;
  const stationName = currentStation()?.name;
  const currentOriginal = state.route.stops.findIndex(stop => stop.name === stationName);
  const direction = state.reverse ? 'forward' : 'reverse';
  const newDisplay = travelIndex(
    Math.max(0, currentOriginal),
    state.route.stops.length,
    direction === 'reverse',
  );
  learnStore.dispatch({type: 'DIRECTION_CHANGED', direction, browseIndex: newDisplay});
  if (state.mode === 'timed' || state.mode === 'full') {
    setMode(state.mode);
  } else {
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
  const mode = state.mode === 'timed' || state.mode === 'full' ? state.mode : 'timed';
  setMode(mode);
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
elements.cameraModeSwitch.querySelectorAll('[data-camera-mode]').forEach(button => {
  button.addEventListener('click', () => setCameraMode(button.dataset.cameraMode));
});
$('#homeButton').addEventListener('click', clearSelection);
$('#randomRouteButton').addEventListener('click', randomRoute);
$('#previousDirectionButton').addEventListener('click', toggleReverse);
$('#switchDirectionButton').addEventListener('click', switchActualDirection);
$('#broadcastButton').addEventListener('click', () => state.broadcasting ? stopBroadcast() : startBroadcast());
$('#speakButton').addEventListener('click', () => audioPlayer.playStation(currentStation()).catch(error => showToast(error.message)));
$('#locateButton').addEventListener('click', () => fitCurrentExperience({animate: true}));
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
elements.spellingScheme.addEventListener('change', event => {
  const next = VALID_SPELLING_SCHEMES.has(event.target.value) ? event.target.value : 'pinyin';
  if (practice.locked && practice.running) {
    event.target.value = state.spellingScheme;
    showToast('列车正在进站，请到站后再切换输入方案');
    return;
  }
  state.spellingScheme = next;
  elements.typingInput.value = '';
  practice.setTargetResolver(station => spellingTarget(station, state.spellingScheme));
  savePracticePreferences();
  $('#typingFeedback').className = 'typing-feedback';
  $('#typingFeedback').textContent = practice.snapshot().originChallenge
    ? `已切换为${spellingLabel(next)}，请继续确认起点。`
    : `已切换为${spellingLabel(next)}，目标仍是车辆当前位置的下一站。`;
  restorePracticeTypingFocus();
});
elements.inlineHintToggle.addEventListener('change', event => {
  state.inlineHint = Boolean(event.target.checked);
  savePracticePreferences();
  renderTypingGhost(practice.snapshot());
  restorePracticeTypingFocus();
});
elements.typingInput.closest('.typing-area').addEventListener('animationend', event => {
  if (event.animationName === 'typingError') event.currentTarget.classList.remove('typing-error');
});
elements.practicePanel.addEventListener('click', event => {
  if (!event.target.closest('button,select,input,label')) elements.typingInput.focus();
});
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
elements.reloadLayoutButton.addEventListener('click', () => window.location.reload());

window.addEventListener('resize', () => {
  overviewRenderer.resize();
  if (state.route) fitCurrentExperience({animate: false});
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

function configureProductUi() {
  document.title = product.documentTitle;
  elements.app.dataset.network = product.id;
  const brand = document.querySelector('.brand');
  if (brand) {
    brand.href = product.learnUrl;
    brand.setAttribute('aria-label', `${product.title}首页`);
  }
  const mark = document.querySelector('.brand-mark');
  if (mark) mark.textContent = product.mark;
  const brandStrong = document.querySelector('.brand-copy strong');
  if (brandStrong) brandStrong.textContent = product.title;
  const brandSmall = document.querySelector('.brand-copy small');
  if (brandSmall) brandSmall.textContent = product.subtitle;
  const mapLink = document.querySelector('.top-actions a.text-button');
  if (mapLink) {
    mapLink.href = product.networkUrl;
    mapLink.textContent = product.networkLinkLabel;
  }
  const introTitle = document.querySelector('#intro h1');
  if (introTitle) introTitle.innerHTML = product.introTitle;
  $('#introPill').textContent = product.introPill;
  $('#introText').textContent = product.introText;
  const collectorLink = document.querySelector('.intro-actions .ghost-link');
  if (collectorLink) collectorLink.href = product.collectorUrl;
  $('#loadingTitle').textContent = product.loadingTitle;
  $('#loadingText').textContent = product.loadingText;
  $('#typingFeedback').textContent = product.feedback;
  const exportLink = document.querySelector('.drawer-export');
  if (exportLink) exportLink.href = transitApi.endpoints.languageExport;
  elements.stage.setAttribute('aria-label', product.mapLabel);
  elements.svg.setAttribute('aria-label', product.focusMapLabel);
  elements.realMap.setAttribute('aria-label', product.realMapLabel);
  focusRenderer.setVehicleType(product.vehicle);
  realMapRenderer.setVehicleType(product.vehicle);
  elements.spellingScheme.value = state.spellingScheme;
  elements.inlineHintToggle.checked = state.inlineHint;
  elements.typingInput.closest('.typing-area').classList.toggle('inline-hint', state.inlineHint);
  updateCameraModeControls();
  updateOverviewIntro({zoomRatio: 1, focused: false});
}

function setupLayoutUpdates() {
  if (state.networkType !== 'metro' || typeof BroadcastChannel === 'undefined') return;
  layoutChannel?.close();
  layoutChannel = new BroadcastChannel('transit.metro.layout');
  layoutChannel.addEventListener('message', event => {
    const revision = event.data?.revision;
    if (!revision || revision === state.presentationRevision) return;
    elements.layoutUpdateNotice.hidden = false;
  });
}

async function init() {
  configureProductUi();
  try {
    const [overview, runtime, presentation] = await Promise.all([
      transitApi.overview(),
      transitApi.runtime().catch(() => ({edition: 'unknown', amap: {map_ready: false}})),
      state.networkType === 'metro' ? transitApi.presentation() : Promise.resolve(null),
    ]);
    state.overview = overview;
    state.presentation = presentation;
    learnStore.dispatch({type: 'PRESENTATION_LOADED', revision: presentation?.revision || null});
    state.runtime = runtime;
    state.mapReady = Boolean(runtime.amap?.map_ready);
    state.allowExperienceOverride = userExperienceOverrideAllowed(runtime);
    await setExperienceProfile(resolveExperienceProfile({network: state.networkType, runtime}), {reframe: false});
    if (runtime.edition !== 'internal') {
      document.querySelectorAll('.admin-only, #reviewButton').forEach(node => { node.hidden = true; });
    }
    updateViewControls();
    overviewRenderer.setData(presentation || overview);
    overviewRenderer.resize();
    $('#networkMeta').textContent = state.networkType === 'metro'
      ? `${presentation.routes.length} 条线路 · ${overview.stats.station_clusters} 个站点簇 · 单 SVG 全网与单线 · ${presentation.revision}`
      : `${overview.stats.directions} 个方向 · ${overview.stats.station_clusters} 个站点簇 · Canvas 全网 / SVG 单线`;
    setupLayoutUpdates();
    const requestedRevision = new URLSearchParams(window.location.search).get('layoutRevision');
    if (requestedRevision && requestedRevision !== state.presentationRevision) {
      elements.layoutUpdateNotice.hidden = false;
    }
    elements.loading.classList.add('hidden');
    const routeId = new URLSearchParams(window.location.search).get('route');
    if (routeId) await selectRoute(routeId);
  } catch (error) {
    elements.loading.innerHTML = `<strong>尚未生成${state.networkType === 'metro' ? '地铁' : '公交'}线网数据</strong><small>${escapeHtml(error.message)}<br><br><a href="${transitApi.endpoints.collector}" style="color:#fff">进入采集页面并构建全网 →</a></small>`;
  }
}

window.addEventListener('pagehide', () => {
  layoutChannel?.close();
  navigationController.destroy();
  experience.destroy();
  overviewRenderer.destroy?.();
}, {once: true});
init();
