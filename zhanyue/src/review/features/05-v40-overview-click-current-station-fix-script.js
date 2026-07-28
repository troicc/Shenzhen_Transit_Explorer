
(() => {
  let restoreTimer = 0;
  let markerRAF = 0;

  function currentOverlay() {
    let overlay = document.getElementById('currentStationOverlay');
    if (overlay) return overlay;
    overlay = svgEl('g', { id: 'currentStationOverlay' });
    hoverLayer.parentNode.insertBefore(overlay, hoverLayer.nextSibling);
    return overlay;
  }

  function selectedPathPoint(line, progress) {
    const path = routeGroupMap.get(line.id)?.querySelector('.route-color');
    if (!path) return null;
    try {
      const total = path.getTotalLength();
      return path.getPointAtLength(clamp(progress, 0, 1) * total);
    } catch (_) {
      return null;
    }
  }

  function currentDestinationPoint() {
    const line = currentLine();
    const station = currentStation();
    if (!line || !station) return null;

    const originalIndex = originalIndexFromDisplay(state.currentIndex);

    const normal = stationLayer.querySelector(
      `.station[data-line="${CSS.escape(line.id)}"][data-index="${originalIndex}"] .station-core`
    );
    if (normal) {
      const x = Number(normal.getAttribute('cx'));
      const y = Number(normal.getAttribute('cy'));
      if (Number.isFinite(x) && Number.isFinite(y)) return { x, y };
    }

    const hub = [...transferLayer.querySelectorAll('.transfer-hub')]
      .find(node => node.dataset.name === station.name);
    if (hub) {
      const x = Number(hub.dataset.cx);
      const y = Number(hub.dataset.cy);
      if (Number.isFinite(x) && Number.isFinite(y)) return { x, y };
    }

    return selectedPathPoint(line, visualProgress(line, originalIndex));
  }

  function ensureCurrentStationVisible() {
    markerRAF = 0;
    const overlay = currentOverlay();
    overlay.replaceChildren();

    const line = currentLine();
    const station = currentStation();
    if (!line || !station || !state.selectedLineId) return;

    const originalIndex = originalIndexFromDisplay(state.currentIndex);

    stationLayer.querySelectorAll(
      `.station[data-line="${CSS.escape(line.id)}"][data-index="${originalIndex}"]`
    ).forEach(node => {
      node.style.removeProperty('display');
      node.style.opacity = '1';
      node.classList.add('is-current');
    });

    transferLayer.querySelectorAll('.transfer-hub').forEach(node => {
      const isCurrent = node.dataset.name === station.name;
      if (!isCurrent) return;
      node.style.removeProperty('display');
      node.style.opacity = '1';
      node.classList.add('is-current');
    });

    labelLayer.querySelectorAll('.station-label').forEach(node => {
      if ((node.textContent || '').trim() !== station.name) return;
      node.style.removeProperty('display');
      node.style.opacity = '1';
      node.classList.add('current-label');
    });

    const point = currentDestinationPoint();
    if (!point) return;

    const group = svgEl('g', {
      class: 'current-station-beacon',
      'data-name': station.name,
    });

    group.append(
      svgEl('circle', {
        class: 'current-target-ring secondary',
        cx: point.x,
        cy: point.y,
        r: 19,
        stroke: line.color,
      }),
      svgEl('circle', {
        class: 'current-target-ring',
        cx: point.x,
        cy: point.y,
        r: 13,
        stroke: line.color,
      }),
      svgEl('circle', {
        class: 'current-target-dot',
        cx: point.x,
        cy: point.y,
        r: 4.7,
      })
    );

    // 列车停靠时只显示圆环，不重复叠加站名；行驶中显示目的站名。
    const trainPoint = train.getCTM();
    const shouldLabel = !trainPoint || Math.hypot(trainPoint.e - point.x, trainPoint.f - point.y) > 12;
    if (shouldLabel) {
      const label = svgEl('text', {
        class: 'current-target-label',
        x: point.x + 15,
        y: point.y - 13,
      });
      label.textContent = station.name;
      group.appendChild(label);
    }

    overlay.appendChild(group);
  }

  function scheduleCurrentStationMarker() {
    if (markerRAF) cancelAnimationFrame(markerRAF);
    markerRAF = requestAnimationFrame(ensureCurrentStationVisible);
  }

  function restoreOverviewInteractivity() {
    if (state.selectedLineId) return;

    document.body.classList.remove(
      'has-line-selection',
      'practice-on',
      'route-stretching',
      'route-returning'
    );

    routeLayer.style.removeProperty('pointer-events');
    mapStage.style.removeProperty('pointer-events');

    routeGroupMap.forEach(group => {
      group.style.removeProperty('pointer-events');
      group.style.removeProperty('display');
      group.style.removeProperty('opacity');

      const hit = group.querySelector('.route-hit');
      if (hit) {
        hit.style.removeProperty('pointer-events');
        hit.setAttribute('pointer-events', 'stroke');
      }
    });

    stationLayer.querySelectorAll('.station').forEach(node => {
      node.style.removeProperty('display');
      node.style.removeProperty('pointer-events');
      node.style.removeProperty('opacity');
    });

    transferLayer.querySelectorAll('.transfer-hub').forEach(node => {
      node.style.removeProperty('display');
      node.style.removeProperty('pointer-events');
      node.style.removeProperty('opacity');
    });

    labelLayer.querySelectorAll('.station-label').forEach(node => {
      node.style.removeProperty('display');
      node.style.removeProperty('opacity');
      node.classList.remove('current-label');
    });

    currentOverlay().replaceChildren();
  }

  function scheduleOverviewRestore() {
    clearTimeout(restoreTimer);
    restoreOverviewInteractivity();
    requestAnimationFrame(restoreOverviewInteractivity);
    setTimeout(restoreOverviewInteractivity, 80);
    setTimeout(restoreOverviewInteractivity, 820);
    restoreTimer = setTimeout(restoreOverviewInteractivity, 1250);
  }

  const previousClearSelectionV40 = clearSelection;
  clearSelection = function(...args) {
    const result = previousClearSelectionV40(...args);
    scheduleOverviewRestore();
    return result;
  };

  const previousRenderAllV40 = renderAll;
  renderAll = function() {
    previousRenderAllV40();
    if (state.selectedLineId) {
      scheduleCurrentStationMarker();
    } else {
      scheduleOverviewRestore();
    }
  };

  const previousRenderDynamicV40 = renderDynamic;
  renderDynamic = function() {
    previousRenderDynamicV40();
    scheduleCurrentStationMarker();
  };

  const previousPositionTrainV40 = positionTrain;
  positionTrain = function(progress = state.trainProgress) {
    previousPositionTrainV40(progress);
    scheduleCurrentStationMarker();
  };

  const previousSelectLineV40 = selectLine;
  selectLine = function(...args) {
    const result = previousSelectLineV40(...args);
    scheduleCurrentStationMarker();
    return result;
  };

  // 页面初始化时清除可能由旧补丁遗留的内联点击锁。
  if (!state.selectedLineId) scheduleOverviewRestore();
  else scheduleCurrentStationMarker();
})();
