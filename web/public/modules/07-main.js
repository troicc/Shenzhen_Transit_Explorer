(() => {
  const Z = window.TransitPublic;
  const elements = Object.fromEntries([
    'app','networkLanding','networkCards','overview','overviewImage','focus','hero','heroKicker','heroTitle','heroText',
    'brandSubtitle','attribution','routeMap','routeDock','routeCode','routeName','routeMeta','lineStats','lineStrip',
    'homeButton','homeIconButton','overviewModeButton','timedModeButton','fullModeButton','forwardButton','reverseButton',
    'practiceButton','broadcastButton','allLabelsToggle','resetViewButton','stationName','stationPinyin','stationMeta',
    'previousStationButton','nextStationButton','speakButton','locateButton','practicePanel','practiceModeLabel',
    'practicePrompt','practiceStation','practicePinyin','typingHint','typingInput','feedback','timeStat','correctStat',
    'accuracyStat','speedStat','progressStat','progressBar','spellingScheme','inlineHintToggle','exitPracticeButton',
    'searchInput','searchResults','loading','accessPanel','accessInput','accessButton','accessError','realMap',
    'flatViewButton','animatedViewButton','realViewButton','practiceFlatViewButton','practiceAnimatedViewButton',
    'practiceRealViewButton','experienceSwitch'
  ].map(id => [id, document.getElementById(id)]));

  const viewport = new Z.ViewportController(elements.routeMap);
  const state = {
    manifest: null, line: null, reverse: false, displayIndex: 0, practice: false,
    answerLocked: false, tickTimer: 0, broadcast: false, searchTimer: 0, pendingMode: '',
    runtime: null, viewMode: 'flat', geographic: null, realRoute: null,
    experienceProfile: Z.api.network === 'metro' ? 'immersive' : 'standard', returning: false,
  };
  const renderer = new Z.RouteRenderer(elements.routeMap, viewport, originalIndex => selectStationOriginal(originalIndex));
  const realMapRenderer = new Z.RealMapFocusRenderer({container: elements.realMap});
  const experience = new Z.PublicLearnExperience({
    app: elements.app,
    renderer,
    realMapRenderer,
    network: Z.api.network,
  });
  viewport.setManualHandler(() => experience.suspendForManualNavigation());

  const practice = new Z.PracticeEngine(snapshot => {
    if (!elements.practicePanel || elements.practicePanel.classList.contains('hidden') || !snapshot.station) return;
    state.displayIndex = snapshot.index;
    elements.practiceStation.textContent = snapshot.station.name;
    elements.practicePinyin.textContent = snapshot.station.pinyin || '拼音待补充';
    elements.typingHint.textContent = snapshot.target;
    elements.timeStat.textContent = snapshot.mode === 'timed' ? `${Math.ceil(snapshot.remaining)}s` : '∞';
    elements.correctStat.textContent = String(snapshot.correct);
    elements.accuracyStat.textContent = `${snapshot.accuracy}%`;
    elements.speedStat.textContent = String(snapshot.speed);
    elements.progressStat.textContent = `${Math.min(snapshot.index + 1, snapshot.total)} / ${snapshot.total}`;
    elements.progressBar.style.width = `${Math.min(100, (snapshot.index + snapshot.ratio) / Math.max(1, snapshot.total) * 100)}%`;
    renderJourney(snapshot.index, snapshot.index === 0 ? 1 : snapshot.ratio);
  }, (snapshot, reason) => {
    clearInterval(state.tickTimer);
    state.tickTimer = 0;
    state.practice = false;
    state.answerLocked = true;
    elements.typingInput.disabled = true;
    elements.correctStat.textContent = String(snapshot.correct);
    elements.accuracyStat.textContent = `${snapshot.accuracy}%`;
    elements.speedStat.textContent = String(snapshot.speed);
    elements.feedback.className = 'feedback ok';
    if (reason === 'time') {
      elements.feedback.textContent = `时间到 · 答对 ${snapshot.correct} 站 · 正确率 ${snapshot.accuracy}%`;
      Z.showToast(`30 秒挑战完成：${snapshot.correct} 站`);
    } else {
      elements.feedback.textContent = `全线完成 · ${snapshot.correct} 站 · ${snapshot.speed} 字/分`;
      elements.progressBar.style.width = '100%';
      Z.showToast('全线练习完成');
    }
    experience.leavePractice();
  });

  function setAccessVisible(visible, message = '') {
    elements.accessPanel.classList.toggle('hidden', !visible);
    elements.accessError.textContent = message;
    if (visible) setTimeout(() => elements.accessInput.focus(), 20);
  }

  function setModeActive(mode) {
    elements.overviewModeButton.classList.toggle('active', mode === 'overview');
    elements.timedModeButton.classList.toggle('active', mode === 'timed');
    elements.fullModeButton.classList.toggle('active', mode === 'full');
  }

  function displayStations() {
    if (!state.line) return [];
    return state.reverse ? [...state.line.stations].reverse() : state.line.stations;
  }

  function currentStation() { return displayStations()[state.displayIndex] || null; }

  function currentOriginalIndex() {
    if (!state.line) return 0;
    return state.reverse ? state.line.stations.length - 1 - state.displayIndex : state.displayIndex;
  }

  function journeyFrame(displayIndex = state.displayIndex, fraction = 1, overrides = {}) {
    if (!state.line) return null;
    const count = state.line.stations.length;
    const moving = state.practice && displayIndex > 0 && fraction < 1;
    const currentDisplay = moving ? displayIndex - 1 : displayIndex;
    const nextDisplay = moving ? displayIndex : null;
    const original = index => state.reverse ? count - 1 - index : index;
    const currentOriginalIndex = original(currentDisplay);
    const nextOriginalIndex = nextDisplay == null ? null : original(nextDisplay);
    const startProgress = Number(state.line.stations[currentOriginalIndex]?.progress) || 0;
    const nextProgress = nextOriginalIndex == null
      ? startProgress
      : Number(state.line.stations[nextOriginalIndex]?.progress ?? startProgress);
    const typingRatio = moving ? Z.clamp(fraction, 0, 1) : 0;
    return {
      network: state.manifest?.id || Z.api.network,
      routeId: state.line.id,
      route: state.line,
      direction: state.reverse ? 'reverse' : 'forward',
      currentDisplayIndex: currentDisplay,
      currentOriginalIndex,
      nextDisplayIndex: nextDisplay,
      nextOriginalIndex,
      reverse: state.reverse,
      typingRatio,
      routeProgress: startProgress + (nextProgress - startProgress) * typingRatio,
      journeyActive: moving,
      practiceMode: state.practice ? practice.mode : 'overview',
      mapMode: state.viewMode,
      ...overrides,
    };
  }

  function renderJourney(displayIndex = state.displayIndex, fraction = 1) {
    renderer.render(displayIndex, fraction, state.reverse);
    const frame = journeyFrame(displayIndex, fraction);
    if (frame && (state.viewMode === 'animated' || state.viewMode === 'real')) {
      realMapRenderer.renderDynamic(frame);
    }
    if (frame) experience.updateJourney(frame);
  }

  function currentRenderFraction() {
    if (!state.practice || state.displayIndex === 0) return 1;
    return practice.snapshot().ratio;
  }

  function fitCurrentRoute(practiceMode = state.practice) {
    if (state.viewMode === 'animated' || state.viewMode === 'real') realMapRenderer.fitRoute();
    else if (state.experienceProfile === 'immersive') {
      const frame = journeyFrame(state.displayIndex, currentRenderFraction());
      renderer.fitImmersive(frame?.routeProgress || 0, {reverse: state.reverse, strong: practiceMode, practiceVisible: practiceMode});
    } else renderer.fitFullRoute({practiceVisible: practiceMode});
  }

  function updateExperienceControls() {
    if (!elements.experienceSwitch) return;
    elements.experienceSwitch.hidden = state.runtime?.learnExperience?.allowUserOverride === false;
    elements.experienceSwitch.querySelectorAll('[data-experience]').forEach(button => {
      const active = button.dataset.experience === state.experienceProfile;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    });
  }

  async function setExperienceProfile(profile, {persist = false, reframe = true} = {}) {
    state.experienceProfile = experience.setProfile(profile);
    if (persist) Z.saveExperienceProfile(Z.api.network, state.experienceProfile);
    updateExperienceControls();
    if (!state.line || !reframe) return;
    const frame = journeyFrame(state.displayIndex, currentRenderFraction());
    if (state.practice) await experience.enterPractice(frame);
    else await experience.enterRoute(frame);
    if (state.practice) elements.typingInput?.focus?.({preventScroll: true});
  }

  function updateViewButtons() {
    const geographicReady = Boolean(state.runtime?.amap?.ready)
      && Boolean(state.line?.availableModes?.includes('animated'));
    const groups = [
      ['flat', elements.flatViewButton, elements.practiceFlatViewButton],
      ['animated', elements.animatedViewButton, elements.practiceAnimatedViewButton],
      ['real', elements.realViewButton, elements.practiceRealViewButton],
    ];
    groups.forEach(([mode, ...buttons]) => buttons.forEach(button => {
      if (!button) return;
      button.classList.toggle('active', state.viewMode === mode);
      button.setAttribute('aria-pressed', String(state.viewMode === mode));
      button.disabled = mode !== 'flat' && !geographicReady;
    }));
  }

  async function setViewMode(mode) {
    if (!state.line || !['flat', 'animated', 'real'].includes(mode)) return;
    if (mode === 'flat') {
      state.viewMode = 'flat';
      elements.app.classList.remove('map-view', 'animated-map', 'realistic-map');
      realMapRenderer.hide();
      updateViewButtons();
      renderJourney(state.displayIndex, currentRenderFraction());
      return;
    }
    experience.suspendForManualNavigation();
    if (!state.runtime?.amap?.ready || !state.line.availableModes?.includes(mode)) {
      Z.showToast('当前部署尚未配置真实地图能力');
      return;
    }
    try {
      if (!state.geographic) state.geographic = await Z.api.geographic(state.line.id);
      if (!state.realRoute) {
        state.realRoute = {
          id: state.line.id,
          geometry: state.geographic.geometry,
          stops: state.line.stations.map((station, index) => ({
            ...station,
            ...(state.geographic.stops[index] || {}),
          })),
        };
      }
      await realMapRenderer.show(state.realRoute, state.line.color, mode);
      state.viewMode = mode;
      elements.app.classList.add('map-view');
      elements.app.classList.toggle('animated-map', mode === 'animated');
      elements.app.classList.toggle('realistic-map', mode === 'real');
      updateViewButtons();
      renderJourney(state.displayIndex, currentRenderFraction());
    } catch (error) {
      state.viewMode = 'flat';
      elements.app.classList.remove('map-view', 'animated-map', 'realistic-map');
      realMapRenderer.hide();
      updateViewButtons();
      Z.showToast(error.message || '真实地图加载失败，已保留学习进度');
    }
  }

  function renderManifest(manifest) {
    state.manifest = manifest;
    const metro = manifest.id === 'metro';
    elements.app.dataset.network = manifest.id;
    realMapRenderer.setVehicleType(metro ? 'metro' : 'bus');
    document.title = `站粤 · ${manifest.name}`;
    elements.overviewImage.src = `/assets/${manifest.id}/network-overview.png?v=${encodeURIComponent(manifest.buildId || '')}`;
    elements.overviewImage.alt = `${manifest.name}公开派生概览`;
    elements.brandSubtitle.textContent = manifest.name;
    elements.heroKicker.textContent = metro ? '真实线网结构 · 八方向示意 · 站名学习' : '全市公交网络 · 派生示意 · 站名学习';
    elements.heroTitle.innerHTML = metro ? '沿着深圳地铁，<br>记住每一个站。' : '沿着一条公交线路，<br>记住深圳的每一个站。';
    elements.heroText.textContent = metro
      ? '选择一条线路开始。列车会沿线路推进，支持全线练习与 30 秒挑战。'
      : '选择一条方向线路开始。车辆会沿线路推进，支持全线练习与 30 秒挑战。';
    elements.attribution.textContent = `${manifest.name} · 站序来源于公开运营信息 · 非官方产品`;
    elements.lineStrip.innerHTML = '';
    manifest.lines.forEach(line => {
      const button = document.createElement('button');
      button.className = 'line-chip';
      button.type = 'button';
      button.dataset.lineId = line.id;
      button.style.setProperty('--chip', line.color);
      button.textContent = metro ? line.name.replace('号线', '') : line.name.split(' · ')[0];
      button.setAttribute('aria-label', line.name);
      button.title = `${line.name} · ${line.terminals[0]} → ${line.terminals[1]}`;
      button.addEventListener('click', () => selectLine(line.id));
      elements.lineStrip.append(button);
    });
    elements.loading.classList.add('hidden');
  }

  async function loadNetworks() {
    elements.app.classList.add('landing-state');
    elements.networkLanding.classList.remove('hidden');
    elements.overview.classList.add('hidden');
    elements.hero.classList.add('hidden');
    elements.lineStrip.classList.add('hidden');
    try {
      const payload = await Z.api.networks();
      elements.networkCards.innerHTML = (payload.networks || []).map(network => `
        <a class="network-landing-card ${network.id}" href="/${network.id}">
          <small>${network.id === 'metro' ? 'METRO' : 'BUS'}</small>
          <strong>${Z.escapeHtml(network.name)}</strong>
          <span>进入站名挑战 →</span>
        </a>`).join('');
      elements.loading.classList.add('hidden');
    } catch (error) {
      elements.loading.textContent = error.message;
      elements.loading.classList.remove('hidden');
    }
  }

  async function loadManifest() {
    try {
      const [runtime, manifest] = await Promise.all([Z.api.runtime(), Z.api.manifest()]);
      state.runtime = runtime;
      await setExperienceProfile(Z.resolveExperienceProfile(Z.api.network, runtime), {reframe: false});
      renderManifest(manifest);
      updateViewButtons();
      setAccessVisible(false);
    } catch (error) {
      if (error.code === 'AUTH_REQUIRED') {
        elements.loading.classList.add('hidden');
        setAccessVisible(true);
      } else {
        elements.loading.textContent = error.message;
        elements.loading.classList.remove('hidden');
      }
    }
  }

  function updateLineAndStation() {
    if (!state.line) return;
    const stations = displayStations();
    const station = currentStation();
    const transfers = state.line.stations.filter(item => item.transfer).length;
    const terminals = state.reverse ? [...state.line.terminals].reverse() : state.line.terminals;
    elements.routeCode.textContent = state.line.name.split(' · ')[0].replace('号线', '');
    elements.routeCode.style.background = state.line.color;
    elements.routeName.textContent = state.line.name;
    elements.routeMeta.textContent = `${terminals[0]} → ${terminals[1]}`;
    elements.lineStats.textContent = `${stations.length} 站 · ${transfers} 个换乘站`;
    elements.stationName.textContent = station?.name || '—';
    elements.stationPinyin.textContent = station?.pinyin || '拼音待补充';
    elements.stationMeta.textContent = `${state.line.name}第 ${state.displayIndex + 1} 站 · ${state.reverse ? '反向' : '正向'}`;
    elements.previousStationButton.disabled = state.displayIndex === 0;
    elements.nextStationButton.disabled = state.displayIndex >= stations.length - 1;
    elements.forwardButton.classList.toggle('active', !state.reverse);
    elements.reverseButton.classList.toggle('active', state.reverse);
  }

  async function selectLine(id, stationName = '', startMode = '') {
    elements.loading.textContent = '正在按需读取当前线路…';
    elements.loading.classList.remove('hidden');
    try {
      stopBroadcast();
      if (state.practice || !elements.practicePanel.classList.contains('hidden')) stopPractice();
      const line = await Z.api.line(id);
      const manifestLine = state.manifest?.lines?.find(item => String(item.id) === String(id));
      line.availableModes = manifestLine?.availableModes || ['flat'];
      state.line = line;
      state.geographic = null;
      state.realRoute = null;
      state.viewMode = 'flat';
      elements.app.classList.remove('map-view', 'animated-map', 'realistic-map');
      realMapRenderer.hide();
      state.reverse = false;
      state.displayIndex = Math.max(0, stationName ? line.stations.findIndex(station => station.name === stationName) : 0);
      elements.app.classList.remove('overview-state');
      elements.overview.classList.add('hidden');
      elements.hero.classList.add('hidden');
      elements.focus.classList.remove('hidden');
      elements.routeDock.classList.remove('hidden');
      elements.practicePanel.classList.add('hidden');
      elements.lineStrip.classList.remove('hidden');
      elements.lineStrip.querySelectorAll('button').forEach(node => node.classList.toggle('active', node.dataset.lineId === String(id)));
      renderer.setLine(line);
      renderer.setLabels(elements.allLabelsToggle.checked);
      renderJourney(state.displayIndex, 1);
      updateLineAndStation();
      updateViewButtons();
      setModeActive('overview');
      if (stationName) renderer.locate(currentOriginalIndex());
      await experience.enterRoute(journeyFrame(state.displayIndex, 1));
      const requestedMode = startMode || state.pendingMode;
      state.pendingMode = '';
      if (requestedMode) startPractice(requestedMode);
    } catch (error) {
      if (error.code === 'AUTH_REQUIRED') setAccessVisible(true);
      else Z.showToast(error.message);
    } finally {
      elements.loading.classList.add('hidden');
    }
  }

  async function home() {
    if (state.returning) return;
    state.returning = true;
    stopBroadcast();
    stopPractice();
    if (state.line) {
      state.viewMode = 'flat';
      elements.app.classList.remove('map-view', 'animated-map', 'realistic-map');
      await experience.returnOverview();
    }
    state.line = null;
    state.reverse = false;
    state.displayIndex = 0;
    state.pendingMode = '';
    state.viewMode = 'flat';
    state.geographic = null;
    state.realRoute = null;
    elements.app.classList.remove('map-view', 'animated-map', 'realistic-map');
    realMapRenderer.hide();
    updateViewButtons();
    elements.app.classList.add('overview-state');
    elements.overview.classList.remove('hidden');
    elements.hero.classList.remove('hidden');
    elements.focus.classList.add('hidden');
    elements.routeDock.classList.add('hidden');
    elements.practicePanel.classList.add('hidden');
    elements.lineStrip.classList.remove('hidden');
    elements.lineStrip.querySelectorAll('button').forEach(node => node.classList.remove('active'));
    setModeActive('overview');
    state.returning = false;
  }

  function selectStationOriginal(originalIndex) {
    if (!state.line || state.practice) return;
    state.displayIndex = state.reverse ? state.line.stations.length - 1 - originalIndex : originalIndex;
    renderJourney(state.displayIndex, 1);
    updateLineAndStation();
  }

  function moveStation(delta) {
    if (!state.line || state.practice) return;
    state.displayIndex = Z.clamp(state.displayIndex + delta, 0, state.line.stations.length - 1);
    renderJourney(state.displayIndex, 1);
    updateLineAndStation();
  }

  function setDirection(reverse) {
    if (!state.line || state.reverse === reverse || state.practice) return;
    const original = currentOriginalIndex();
    state.reverse = reverse;
    state.displayIndex = reverse ? state.line.stations.length - 1 - original : original;
    renderJourney(state.displayIndex, 1);
    updateLineAndStation();
  }

  function speakStation(station, onEnd) {
    if (!station || !window.speechSynthesis) {
      Z.showToast('当前浏览器不支持语音播报');
      onEnd?.();
      return;
    }
    const utterance = new SpeechSynthesisUtterance(station.name);
    utterance.lang = 'zh-HK';
    utterance.rate = .88;
    utterance.onend = () => onEnd?.();
    utterance.onerror = () => onEnd?.();
    speechSynthesis.speak(utterance);
  }

  function stopBroadcast() {
    state.broadcast = false;
    if (window.speechSynthesis) speechSynthesis.cancel();
    if (elements.broadcastButton) elements.broadcastButton.textContent = '▶ 全线播报';
  }

  function toggleBroadcast() {
    if (!state.line) return;
    if (state.broadcast) { stopBroadcast(); return; }
    state.broadcast = true;
    elements.broadcastButton.textContent = '■ 停止播报';
    const stations = displayStations();
    let index = 0;
    const next = () => {
      if (!state.broadcast || index >= stations.length) { stopBroadcast(); return; }
      state.displayIndex = index;
      renderJourney(index, 1);
      updateLineAndStation();
      speakStation(stations[index], () => { index += 1; setTimeout(next, 180); });
    };
    next();
  }

  function startPractice(mode = 'full') {
    if (!state.line) {
      Z.showToast('请先从下方选择一条线路');
      return;
    }
    stopBroadcast();
    state.practice = true;
    state.answerLocked = false;
    state.displayIndex = 0;
    elements.practicePanel.classList.remove('hidden');
    elements.routeDock.classList.add('hidden');
    elements.lineStrip.classList.add('hidden');
    elements.typingInput.disabled = false;
    elements.typingInput.value = '';
    elements.feedback.className = 'feedback';
    elements.feedback.textContent = `输入正确后，${state.manifest?.id === 'metro' ? '列车' : '车辆'}前往下一站。`;
    elements.practiceModeLabel.textContent = mode === 'timed' ? '30 秒拼音挑战' : '全线拼音';
    elements.practicePrompt.textContent = elements.spellingScheme.value === 'initials' ? '输入每个音节的首字母' : '输入普通话拼音（无需声调）';
    elements.progressBar.style.width = '0%';
    setModeActive(mode);
    practice.start(displayStations(), {mode, duration: 30, scheme: elements.spellingScheme.value});
    experience.enterPractice(journeyFrame(practice.index, 0));
    clearInterval(state.tickTimer);
    state.tickTimer = setInterval(() => practice.tick(), 250);
    elements.typingInput.focus();
  }

  function requestPractice(mode) {
    if (state.line) {
      startPractice(mode);
      return;
    }
    state.pendingMode = mode;
    setModeActive(mode);
    Z.showToast(`请选择一条线路开始${mode === 'timed' ? ' 30 秒挑战' : '全线练习'}`);
  }

  function stopPractice() {
    const snapshot = practice.snapshot();
    const targetNotReached = snapshot.index > 0 && snapshot.value !== snapshot.target;
    if (targetNotReached) state.displayIndex = snapshot.index - 1;
    clearInterval(state.tickTimer);
    state.tickTimer = 0;
    practice.reset();
    state.practice = false;
    state.answerLocked = false;
    if (!elements.practicePanel) return;
    elements.practicePanel.classList.add('hidden');
    elements.typingInput.disabled = false;
    if (state.line) {
      elements.routeDock.classList.remove('hidden');
      elements.lineStrip.classList.remove('hidden');
      state.displayIndex = Z.clamp(state.displayIndex, 0, state.line.stations.length - 1);
      experience.leavePractice();
      renderJourney(state.displayIndex, 1);
      updateLineAndStation();
      setModeActive('overview');
    }
  }

  function renderSearchResults(results) {
    elements.searchResults.innerHTML = '';
    if (!results.length) {
      const empty = document.createElement('div');
      empty.className = 'search-result';
      empty.textContent = '没有找到匹配站点';
      elements.searchResults.append(empty);
    } else {
      results.forEach(result => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'search-result';
        const copy = document.createElement('span');
        const name = document.createElement('strong');
        const pinyin = document.createElement('small');
        name.textContent = result.name;
        pinyin.textContent = result.pinyin || result.lines.map(line => line.name).join(' · ');
        copy.append(name, pinyin);
        const dots = document.createElement('span');
        dots.className = 'result-lines';
        result.lines.forEach(line => {
          const dot = document.createElement('i');
          dot.style.setProperty('--dot', line.color);
          dot.title = line.name;
          dots.append(dot);
        });
        button.append(copy, dots);
        button.addEventListener('click', () => {
          elements.searchResults.classList.add('hidden');
          elements.searchInput.value = result.name;
          selectLine(result.lines[0].id, result.name);
        });
        elements.searchResults.append(button);
      });
    }
    elements.searchResults.classList.remove('hidden');
  }

  async function searchStations() {
    const query = elements.searchInput.value.trim();
    if (!query) { elements.searchResults.classList.add('hidden'); return; }
    try {
      const payload = await Z.api.search(query);
      if (elements.searchInput.value.trim() === query) renderSearchResults(payload.results || []);
    } catch (error) {
      if (error.code === 'AUTH_REQUIRED') setAccessVisible(true);
      else Z.showToast(error.message);
    }
  }

  elements.homeButton.addEventListener('click', home);
  elements.homeIconButton.addEventListener('click', home);
  elements.overviewModeButton.addEventListener('click', home);
  elements.timedModeButton.addEventListener('click', () => requestPractice('timed'));
  elements.fullModeButton.addEventListener('click', () => requestPractice('full'));
  elements.forwardButton.addEventListener('click', () => setDirection(false));
  elements.reverseButton.addEventListener('click', () => setDirection(true));
  elements.practiceButton.addEventListener('click', () => startPractice('full'));
  elements.broadcastButton.addEventListener('click', toggleBroadcast);
  elements.previousStationButton.addEventListener('click', () => moveStation(-1));
  elements.nextStationButton.addEventListener('click', () => moveStation(1));
  elements.speakButton.addEventListener('click', () => { stopBroadcast(); speakStation(currentStation()); });
  elements.locateButton.addEventListener('click', () => {
    if (state.viewMode === 'flat') renderer.locate(currentOriginalIndex());
    else realMapRenderer.fitRoute();
  });
  elements.resetViewButton.addEventListener('click', () => fitCurrentRoute(false));
  elements.allLabelsToggle.addEventListener('change', event => renderer.setLabels(event.target.checked));
  elements.exitPracticeButton.addEventListener('click', stopPractice);
  elements.flatViewButton.addEventListener('click', () => setViewMode('flat'));
  elements.animatedViewButton.addEventListener('click', () => setViewMode('animated'));
  elements.realViewButton.addEventListener('click', () => setViewMode('real'));
  elements.practiceFlatViewButton.addEventListener('click', () => setViewMode('flat'));
  elements.practiceAnimatedViewButton.addEventListener('click', () => setViewMode('animated'));
  elements.practiceRealViewButton.addEventListener('click', () => setViewMode('real'));
  elements.experienceSwitch?.querySelectorAll('[data-experience]').forEach(button => {
    button.addEventListener('click', () => setExperienceProfile(button.dataset.experience, {persist: true}));
  });

  elements.spellingScheme.addEventListener('change', event => {
    practice.setScheme(event.target.value);
    elements.typingInput.value = '';
    elements.practicePrompt.textContent = event.target.value === 'initials' ? '输入每个音节的首字母' : '输入普通话拼音（无需声调）';
    elements.typingInput.focus();
  });
  elements.inlineHintToggle.addEventListener('change', event => {
    elements.typingInput.closest('.typing-shell').classList.toggle('inline-hint', event.target.checked);
    elements.typingInput.focus();
  });
  elements.typingInput.addEventListener('input', () => {
    if (state.answerLocked) return;
    const result = practice.input(elements.typingInput.value);
    if (result.type === 'invalid') {
      elements.typingInput.value = result.value;
      elements.feedback.textContent = '这个字符与目标拼音不一致。';
      elements.feedback.className = 'feedback bad';
    } else if (result.type === 'complete') {
      state.answerLocked = true;
      elements.feedback.textContent = '正确，到站。';
      elements.feedback.className = 'feedback ok';
      setTimeout(async () => {
        const arrivedFrame = journeyFrame(practice.index, 1);
        await experience.arrive({...arrivedFrame, arrivedOriginalIndex: arrivedFrame?.currentOriginalIndex});
        if (practice.advance()) {
          state.answerLocked = false;
          elements.typingInput.value = '';
          elements.feedback.textContent = '下一站。';
          elements.feedback.className = 'feedback';
          elements.typingInput.focus();
        }
      }, 260);
    } else if (result.type === 'valid') {
      elements.feedback.textContent = '继续输入…';
      elements.feedback.className = 'feedback';
    }
  });

  elements.searchInput.addEventListener('input', () => {
    clearTimeout(state.searchTimer);
    state.searchTimer = setTimeout(searchStations, 180);
  });
  elements.searchInput.addEventListener('keydown', event => {
    if (event.key === 'Escape') elements.searchResults.classList.add('hidden');
    if (event.key === 'Enter') {
      const first = elements.searchResults.querySelector('button.search-result');
      if (first) first.click();
    }
  });
  document.addEventListener('pointerdown', event => {
    if (!event.target.closest('.search-box')) elements.searchResults.classList.add('hidden');
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      if (!elements.practicePanel.classList.contains('hidden')) stopPractice();
      else home();
    }
    if (!['INPUT','TEXTAREA','SELECT'].includes(document.activeElement.tagName) && state.line && !state.practice) {
      if (event.key === 'ArrowLeft') moveStation(-1);
      if (event.key === 'ArrowRight') moveStation(1);
      if (event.code === 'Space') { event.preventDefault(); speakStation(currentStation()); }
    }
  });

  elements.accessButton.addEventListener('click', () => {
    Z.api.setToken(elements.accessInput.value.trim());
    elements.accessError.textContent = '';
    loadManifest();
  });
  elements.accessInput.addEventListener('keydown', event => { if (event.key === 'Enter') elements.accessButton.click(); });
  window.addEventListener('resize', () => { if (state.line) fitCurrentRoute(state.practice); });
  window.addEventListener('beforeunload', stopBroadcast);
  if (Z.api.network) loadManifest();
  else loadNetworks();
})();
