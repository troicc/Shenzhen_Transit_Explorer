
(() => {
  const finalTrainGeometryCache = new WeakMap();
  let isolationRAF = 0;

  function mixHexWithWhiteFinal(value, ratio = .3) {
    const match = String(value || '').trim().match(/^#([0-9a-f]{6})$/i);
    if (!match) return value || '#ffffff';
    const n = Number.parseInt(match[1], 16);
    const channels = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    const mixed = channels.map(channel => Math.round(channel + (255 - channel) * ratio));
    return `#${mixed.map(channel => channel.toString(16).padStart(2, '0')).join('')}`;
  }

  function selectedStationNames() {
    const line = currentLine();
    return line ? new Set(line.stations.map(station => station.name)) : null;
  }

  function isCurrentLineStationNode(node, line, names) {
    return node.dataset.line === line.id && names.has(node.dataset.name || '');
  }

  function enforceCurrentRouteVisuals() {
    isolationRAF = 0;
    const line = currentLine();

    if (!line || !state.selectedLineId) {
      stationLayer.querySelectorAll('.station').forEach(node => node.style.removeProperty('display'));
      transferLayer.querySelectorAll('.transfer-hub').forEach(node => node.style.removeProperty('display'));
      labelLayer.querySelectorAll('.station-label').forEach(node => node.style.removeProperty('display'));
      return;
    }

    const names = selectedStationNames();
    const currentOriginal = originalIndexFromDisplay(state.currentIndex);

    stationLayer.querySelectorAll('.station').forEach(node => {
      const visible = isCurrentLineStationNode(node, line, names);
      node.style.display = visible ? '' : 'none';
      if (!visible) return;

      const index = Number(node.dataset.index);
      const displayIndex = Number.isInteger(index) ? displayIndexFromOriginal(index) : -1;
      const core = node.querySelector('.station-core');
      if (!core) return;

      const isCurrent = index === currentOriginal;
      const isAhead = (state.mode === 'timed' || state.mode === 'full') && displayIndex > state.currentIndex;
      core.setAttribute('r', isCurrent ? '5.1' : '4.05');
      core.setAttribute('stroke', isCurrent ? mixHexWithWhiteFinal(line.color, .48) : '#07101d');
      core.setAttribute('fill', isAhead ? '#8995a7' : '#f5f8fc');
    });

    transferLayer.querySelectorAll('.transfer-hub').forEach(node => {
      const visible = names.has(node.dataset.name || '');
      node.style.display = visible ? '' : 'none';
    });

    labelLayer.querySelectorAll('.station-label').forEach(node => {
      const visible = names.has((node.textContent || '').trim());
      node.style.display = visible ? '' : 'none';
    });

    routeGroupMap.forEach((group, id) => {
      const selected = id === line.id;
      group.style.pointerEvents = selected ? '' : 'none';
      const colorPath = group.querySelector('.route-color');
      if (selected && colorPath) {
        colorPath.setAttribute('stroke', mixHexWithWhiteFinal(line.color, .26));
        colorPath.style.opacity = state.mode === 'timed' || state.mode === 'full' ? '.78' : '1';
      }
    });

    const progressPath = routeGroupMap.get(line.id)?.querySelector('.route-progress');
    if (progressPath) {
      progressPath.setAttribute('stroke', mixHexWithWhiteFinal(line.color, .62));
      progressPath.setAttribute('stroke-linecap', 'butt');
      progressPath.style.opacity = '1';
    }
  }

  function scheduleVisualIsolation() {
    if (isolationRAF) return;
    isolationRAF = requestAnimationFrame(enforceCurrentRouteVisuals);
  }

  function currentBakedPath() {
    const line = currentLine();
    if (!line) return null;
    const group = routeGroupMap.get(line.id);
    return group?.querySelector('.route-color') || null;
  }

  function pointOnCurrentBakedPath(progress) {
    const path = currentBakedPath();
    if (!path) return null;
    const d = path.getAttribute('d') || '';
    let geometry = finalTrainGeometryCache.get(path);
    if (!geometry || geometry.d !== d) {
      geometry = { d, total: Math.max(1e-9, path.getTotalLength()) };
      finalTrainGeometryCache.set(path, geometry);
    }
    return path.getPointAtLength(clamp(progress, 0, 1) * geometry.total);
  }

  function finalTrainScale() {
    const stretch = clamp(Number(state.immersiveStretch) || 0, 0, 1);
    const eased = 1 - Math.pow(1 - stretch, 2.4);
    return 1 - .18 * eased; // 拉伸完成后仍保留 82% 尺寸。
  }

  positionTrain = function(progress = state.trainProgress) {
    const line = currentLine();
    if (!line || !state.selectedLineId) {
      train.setAttribute('opacity', '0');
      return;
    }

    const point = pointOnCurrentBakedPath(progress);
    if (!point) {
      train.setAttribute('opacity', '0');
      return;
    }

    const scale = finalTrainScale();
    train.setAttribute('transform', `translate(${point.x} ${point.y}) scale(${scale})`);
    train.setAttribute('opacity', '1');

    const body = train.querySelector('.train-body');
    if (body) {
      body.setAttribute('x', '-7.5');
      body.setAttribute('y', '-5.6');
      body.setAttribute('width', '15');
      body.setAttribute('height', '10');
      body.setAttribute('rx', '3');
      body.setAttribute('fill', line.color);
    }
    const windowPath = train.querySelector('.train-window');
    if (windowPath) {
      windowPath.setAttribute('d', 'M-5 -1.5 H5');
      windowPath.setAttribute('stroke-width', String(2.1 / scale));
    }
    scheduleVisualIsolation();
  };

  // 第一题的列车已经停在首站；只有从第二题开始才发生站间移动。
  typingSegment = function(eased = state.typingFraction) {
    const line = currentLine();
    const stations = displayStations();
    if (!line || !stations.length) return { start: 0, end: 0, target: 0 };

    const currentOriginal = originalIndexFromDisplay(state.currentIndex);
    const end = visualProgress(line, currentOriginal);
    if (state.currentIndex === 0) return { start: end, end, target: end };

    const previousOriginal = originalIndexFromDisplay(state.currentIndex - 1);
    const start = visualProgress(line, previousOriginal);
    const t = clamp(eased, 0, 1);
    return { start, end, target: start + (end - start) * t };
  };

  function visibleStationPoint(originalIndex) {
    const line = currentLine();
    if (!line) return null;
    const station = line.stations[originalIndex];
    const normalNode = stationLayer.querySelector(
      `.station[data-line="${CSS.escape(line.id)}"][data-index="${originalIndex}"] .station-core`
    );
    if (normalNode) {
      return { x: Number(normalNode.getAttribute('cx')), y: Number(normalNode.getAttribute('cy')) };
    }

    const hub = transferLayer.querySelector(`.transfer-hub[data-name="${CSS.escape(station.name)}"]`);
    if (hub) {
      const x = Number(hub.getAttribute('data-cx'));
      const y = Number(hub.getAttribute('data-cy'));
      if (Number.isFinite(x) && Number.isFinite(y)) return { x, y };
    }

    return pointOnCurrentBakedPath(visualProgress(line, originalIndex));
  }

  function emitFinalArrivalPulse(originalIndex) {
    const point = visibleStationPoint(originalIndex);
    if (!point) return;
    const group = svgEl('g', { class: 'arrival-pulse-group' });
    group.append(
      svgEl('circle', { class: 'arrival-pulse outer', cx: point.x, cy: point.y, r: 5 }),
      svgEl('circle', { class: 'arrival-pulse inner', cx: point.x, cy: point.y, r: 5 }),
      svgEl('circle', { class: 'arrival-flash', cx: point.x, cy: point.y, r: 4 })
    );
    hoverLayer.appendChild(group);
    setTimeout(() => group.remove(), 1120);
  }

  // 重写完成流程，确保首站不倒退，并在正确的烘焙站点上播放到站亮效。
  completeTyping = async function() {
    if (state.answerLocked) return;
    state.answerLocked = true;

    const stations = displayStations();
    const station = currentStation();
    const target = practiceTarget(station);
    const arrivedOriginal = originalIndexFromDisplay(state.currentIndex);
    const segment = typingSegment(1);

    state.correct += 1;
    state.attempts += 1;
    state.typingFraction = 1;
    typeInput.classList.add('correct');
    setTrainTarget(segment.end);
    updatePracticeProgressBar(1);
    renderPracticePinyin(true);

    if (window.__zhanyueBakedCameraFollow) {
      window.__zhanyueBakedCameraFollow(segment.end, { force: true });
    }

    const feedbackNode = document.getElementById('feedback');
    feedbackNode.className = 'feedback ok';
    feedbackNode.textContent = `正确：${station.name} · ${target.display}`;
    playStationAudio(station, { silent: true }).catch(() => {});

    await waitForTrainTarget(segment.end, state.currentIndex === 0 ? 80 : 430);
    state.trainProgress = segment.end;
    state.trainTargetProgress = segment.end;
    positionTrain(segment.end);
    emitFinalArrivalPulse(arrivedOriginal);
    await delay(150);

    if (state.currentIndex < stations.length - 1) {
      state.currentIndex += 1;
      state.typingFraction = 0;
      state.selectedStationName = currentStation().name;
      typeInput.value = '';
      state.lastValidInput = '';
      typeInput.className = 'type-input';
      state.answerLocked = false;
      renderDynamic();
      scheduleVisualIsolation();

      const nextTarget = practiceTarget(currentStation());
      feedbackNode.className = 'feedback';
      feedbackNode.textContent = `下一站：${currentStation().name} · ${nextTarget.display}`;
      typeInput.focus();
    } else {
      stopTimer();
      feedbackNode.textContent = `完成全线，共答对 ${state.correct} 站。`;
      state.answerLocked = false;
      typeInput.classList.remove('correct');
    }
  };

  const previousFinalRenderDynamic = renderDynamic;
  renderDynamic = function() {
    previousFinalRenderDynamic();
    scheduleVisualIsolation();
    positionTrain(state.trainProgress);
  };

  const previousFinalRenderAll = renderAll;
  renderAll = function() {
    previousFinalRenderAll();
    scheduleVisualIsolation();
    requestAnimationFrame(() => {
      enforceCurrentRouteVisuals();
      positionTrain(state.trainProgress);
    });
  };

  const previousFinalRenderProgressPath = renderProgressPath;
  renderProgressPath = function() {
    previousFinalRenderProgressPath();
    scheduleVisualIsolation();
  };

  const previousFinalUpdateProgress = updateProgressPathPosition;
  updateProgressPathPosition = function(progress = state.trainProgress) {
    previousFinalUpdateProgress(progress);
    scheduleVisualIsolation();
  };

  const previousFinalSelectLine = selectLine;
  selectLine = function(...args) {
    previousFinalSelectLine(...args);
    renderStations();
    scheduleVisualIsolation();
    setTimeout(() => {
      renderStations();
      enforceCurrentRouteVisuals();
      positionTrain(state.trainProgress);
    }, 980);
  };

  const layerObserver = new MutationObserver(scheduleVisualIsolation);
  [stationLayer, transferLayer, labelLayer].forEach(layer => {
    layerObserver.observe(layer, { childList: true, subtree: true });
  });

  typeInput.style.caretColor = 'transparent';
  typeInput.addEventListener('focus', () => { typeInput.style.caretColor = 'transparent'; });

  scheduleVisualIsolation();
})();
