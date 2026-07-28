
(() => {
  const districtLayerV42 = document.getElementById('districtLayer');
  const districtNodesV42 = districtLayerV42
    ? [...districtLayerV42.querySelectorAll('text')]
    : [];

  let districtLastKeyV42 = '';
  let districtSyncRAFV42 = 0;
  let completionRAFV42 = 0;
  let practiceWasOnV42 = document.body.classList.contains('practice-on');

  /* ------------------------------------------------------------
     1. 底图坐标与线路使用同一比例、同一中心拉伸
     ------------------------------------------------------------ */

  districtNodesV42.forEach(node => {
    if (!node.dataset.v42BaseX) node.dataset.v42BaseX = node.getAttribute('x') || '0';
    if (!node.dataset.v42BaseY) node.dataset.v42BaseY = node.getAttribute('y') || '0';
  });

  function easeV42(t) {
    t = clamp(Number(t) || 0, 0, 1);
    return t < .5
      ? 4 * t * t * t
      : 1 - Math.pow(-2 * t + 2, 3) / 2;
  }

  function activeStretchScaleV42() {
    if (!state.selectedLineId || state.reviewOpen) return 1;
    if (typeof window.__zhanyueBakedScale === 'function') {
      return window.__zhanyueBakedScale(state.immersiveStretch || 0);
    }
    return 1 + 1.7 * easeV42(state.immersiveStretch || 0);
  }

  function syncDistrictGeometryV42(force = false) {
    const line = currentLine();
    const active = !!line && !!state.selectedLineId && !state.reviewOpen;
    const stretch = active ? Number(state.immersiveStretch || 0) : 0;
    const scale = active ? activeStretchScaleV42() : 1;
    const key = `${active ? line.id : 'overview'}:${stretch.toFixed(5)}:${scale.toFixed(5)}`;

    if (!force && key === districtLastKeyV42) return;
    districtLastKeyV42 = key;

    if (!districtNodesV42.length) return;

    if (!active) {
      districtNodesV42.forEach(node => {
        node.setAttribute('x', node.dataset.v42BaseX);
        node.setAttribute('y', node.dataset.v42BaseY);
      });
      return;
    }

    const [x1, y1, x2, y2] = line.bbox;
    const cx = (x1 + x2) / 2;
    const cy = (y1 + y2) / 2;

    districtNodesV42.forEach(node => {
      const x = Number(node.dataset.v42BaseX);
      const y = Number(node.dataset.v42BaseY);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;

      node.setAttribute('x', String(cx + (x - cx) * scale));
      node.setAttribute('y', String(cy + (y - cy) * scale));
    });
  }

  window.__zhanyueBaseMapSync = syncDistrictGeometryV42;

  /*
   * 进入线路的旧动画在闭包内逐帧改变 immersiveStretch。
   * 这里只在值实际变化时更新 9 个底图文字节点，开销很小。
   */
  function districtAnimationLoopV42() {
    syncDistrictGeometryV42();
    districtSyncRAFV42 = requestAnimationFrame(districtAnimationLoopV42);
  }
  districtSyncRAFV42 = requestAnimationFrame(districtAnimationLoopV42);

  /* ------------------------------------------------------------
     2. 练习态严格隔离站名、换乘牌和提示气泡
     ------------------------------------------------------------ */

  function cleanPracticeStationArtifactsV42() {
    const practice =
      !!state.selectedLineId &&
      (state.mode === 'timed' || state.mode === 'full') &&
      document.body.classList.contains('practice-on');

    if (!practice) return;

    // hoverLayer 只保留到站光波；鼠标提示气泡与历史残留文本全部删除。
    hoverLayer.querySelectorAll('.station-tip').forEach(node => node.remove());
    hoverLayer.querySelectorAll('text').forEach(node => node.remove());

    /*
     * currentStationOverlay 应只存在一个 current-station-beacon。
     * 若历史补丁或异步渲染留下多个，保留最后一个。
     */
    const overlay = document.getElementById('currentStationOverlay');
    if (overlay) {
      const beacons = [...overlay.querySelectorAll('.current-station-beacon')];
      beacons.slice(0, -1).forEach(node => node.remove());
    }
  }

  let practiceCleanupRAFV42 = 0;
  function schedulePracticeCleanupV42() {
    if (practiceCleanupRAFV42) cancelAnimationFrame(practiceCleanupRAFV42);
    practiceCleanupRAFV42 = requestAnimationFrame(() => {
      practiceCleanupRAFV42 = 0;
      cleanPracticeStationArtifactsV42();
    });
  }

  /* ------------------------------------------------------------
     3. 打字速率（CPM，字/分）
     ------------------------------------------------------------ */

  const speedStatStrongV42 = (() => {
    let node = document.getElementById('typingSpeedStat');
    if (node) return node;

    const stats = document.querySelector('.practice-stats');
    if (!stats) return null;

    const wrapper = document.createElement('div');
    wrapper.className = 'stat';
    wrapper.id = 'typingSpeedStatWrap';

    node = document.createElement('strong');
    node.id = 'typingSpeedStat';
    node.textContent = '0';

    const label = document.createElement('span');
    label.textContent = '字/分';

    wrapper.append(node, label);
    stats.appendChild(wrapper);
    return node;
  })();

  const typingMetricsV42 = {
    active: false,
    startedAt: 0,
    chars: 0,
    lastLength: 0,
    finalSpeed: 0,
  };

  function normalizedTypedLengthV42(value) {
    return (String(value || '').match(/[a-z0-9]/gi) || []).length;
  }

  function resetTypingMetricsV42() {
    typingMetricsV42.active = true;
    typingMetricsV42.startedAt = 0;
    typingMetricsV42.chars = 0;
    typingMetricsV42.lastLength = 0;
    typingMetricsV42.finalSpeed = 0;
    if (speedStatStrongV42) speedStatStrongV42.textContent = '0';
  }

  function currentTypingSpeedV42() {
    if (!typingMetricsV42.startedAt || !typingMetricsV42.chars) return 0;
    const minutes = Math.max((performance.now() - typingMetricsV42.startedAt) / 60000, 1 / 120);
    return Math.round(typingMetricsV42.chars / minutes);
  }

  function updateTypingSpeedV42(final = false) {
    const speed = final
      ? Math.max(typingMetricsV42.finalSpeed, currentTypingSpeedV42())
      : currentTypingSpeedV42();

    if (final) typingMetricsV42.finalSpeed = speed;
    if (speedStatStrongV42) speedStatStrongV42.textContent = String(speed || 0);
    return speed;
  }

  typeInput.addEventListener('input', () => {
    if (!document.body.classList.contains('practice-on')) return;

    const length = normalizedTypedLengthV42(typeInput.value);
    if (length < typingMetricsV42.lastLength) {
      // 新题清空输入框或用户退格，重新建立本题长度基线。
      typingMetricsV42.lastLength = 0;
    }

    const delta = Math.max(0, length - typingMetricsV42.lastLength);
    if (delta > 0) {
      if (!typingMetricsV42.startedAt) typingMetricsV42.startedAt = performance.now();
      typingMetricsV42.chars += delta;
    }

    typingMetricsV42.lastLength = length;
    updateTypingSpeedV42();
    schedulePracticeCleanupV42();
  });

  setInterval(() => {
    if (document.body.classList.contains('practice-on')) updateTypingSpeedV42();
  }, 500);

  /* ------------------------------------------------------------
     4. 全线完成：取消拉伸并回弹到单线全屏
     ------------------------------------------------------------ */

  function originalLineFitViewV42(line) {
    const [x1, y1, x2, y2] = line.bbox;
    const ratio = state.overviewView.w / state.overviewView.h;
    const width = Math.max(1, x2 - x1);
    const height = Math.max(1, y2 - y1);
    const padX = Math.max(42, width * .09);
    const padY = Math.max(42, height * .11);

    let viewW = Math.max(width + padX * 2, (height + padY * 2) * ratio);
    viewW = clamp(viewW, 330, state.overviewView.w);
    const viewH = viewW / ratio;

    const cx = (x1 + x2) / 2;
    const cy = (y1 + y2) / 2;

    // 为底部练习栏预留空间，使线路整体略偏上。
    return {
      x: cx - viewW / 2,
      y: cy - viewH / 2 + viewH * .055,
      w: viewW,
      h: viewH,
    };
  }

  function springProgressV42(t) {
    t = clamp(t, 0, 1);
    if (t >= 1) return 1;
    return clamp(1 - Math.exp(-6.5 * t) * Math.cos(9.2 * t), 0, 1.055);
  }

  function animateFullLineReturnV42(duration = 1180) {
    const line = currentLine();
    if (!line || !state.selectedLineId) return Promise.resolve();

    if (completionRAFV42) cancelAnimationFrame(completionRAFV42);
    if (state.viewAnimationRAF) cancelAnimationFrame(state.viewAnimationRAF);
    if (state.immersiveStretchRAF) cancelAnimationFrame(state.immersiveStretchRAF);

    const startView = { ...state.view };
    const targetView = originalLineFitViewV42(line);
    const startStretch = clamp(Number(state.immersiveStretch || 0), 0, 1);
    const startTime = performance.now();

    // 全线完成后，任何旧的镜头目标都不能再接管 viewBox。
    if (typeof window.__zhanyueStopBakedCamera === 'function') {
      window.__zhanyueStopBakedCamera();
    }
    if (state.cameraFollowRAF) {
      cancelAnimationFrame(state.cameraFollowRAF);
      state.cameraFollowRAF = 0;
    }
    if (state.trueCameraRAF) {
      cancelAnimationFrame(state.trueCameraRAF);
      state.trueCameraRAF = 0;
    }
    clearTimeout(state.cameraResumeTimer);
    state.cameraTargetView = null;
    state.trueCameraTarget = null;
    state.cameraFollowEnabled = false;
    state.cameraSuspended = true;

    document.body.classList.add('line-completing', 'is-view-animating');
    document.body.classList.remove('camera-following');

    return new Promise(resolve => {
      function frame(now) {
        const t = clamp((now - startTime) / duration, 0, 1);
        const geometryEase = 1 - Math.pow(1 - t, 4);
        const viewEase = springProgressV42(t);

        state.immersiveStretch = startStretch * (1 - geometryEase);
        state.view = {
          x: startView.x + (targetView.x - startView.x) * viewEase,
          y: startView.y + (targetView.y - startView.y) * viewEase,
          w: startView.w + (targetView.w - startView.w) * viewEase,
          h: startView.h + (targetView.h - startView.h) * viewEase,
        };

        if (typeof window.__zhanyueApplyBakedGeometry === 'function') {
          window.__zhanyueApplyBakedGeometry();
        }
        syncDistrictGeometryV42(true);
        applyView();

        if (t < 1) {
          completionRAFV42 = requestAnimationFrame(frame);
          return;
        }

        completionRAFV42 = 0;
        state.immersiveStretch = 0;
        state.view = targetView;

        if (typeof window.__zhanyueApplyBakedGeometry === 'function') {
          window.__zhanyueApplyBakedGeometry();
        }
        syncDistrictGeometryV42(true);
        commitView();

        document.body.classList.remove('line-completing', 'is-view-animating');
        document.body.classList.add('line-completed');

        // 第二次清理用于拦截完成流程末尾可能排队的 requestAnimationFrame。
        if (typeof window.__zhanyueStopBakedCamera === 'function') {
          window.__zhanyueStopBakedCamera();
        }
        if (state.cameraFollowRAF) {
          cancelAnimationFrame(state.cameraFollowRAF);
          state.cameraFollowRAF = 0;
        }
        if (state.trueCameraRAF) {
          cancelAnimationFrame(state.trueCameraRAF);
          state.trueCameraRAF = 0;
        }
        clearTimeout(state.cameraResumeTimer);
        state.cameraTargetView = null;
        state.trueCameraTarget = null;
        state.cameraFollowEnabled = false;

        /*
         * 自动镜头通过 line-completed 状态被禁用；
         * cameraSuspended 必须恢复为 false，否则触控板和拖动流程
         * 无法完成正常的 begin/end navigation 状态切换。
         */
        state.cameraSuspended = false;
        document.body.classList.remove(
          'camera-following',
          'is-map-navigating',
          'map-flipping'
        );
        mapStage.style.removeProperty('pointer-events');

        state.view = { ...targetView };
        commitView();
        cleanPracticeStationArtifactsV42();
        resolve();
      }

      completionRAFV42 = requestAnimationFrame(frame);
    });
  }

  window.__zhanyueAnimateFullLineReturn = animateFullLineReturnV42;

  const previousCompleteTypingV42 = completeTyping;
  completeTyping = async function(...args) {
    const stationsBefore = displayStations();
    const completingWholeLine =
      state.mode === 'full' &&
      stationsBefore.length > 0 &&
      state.currentIndex === stationsBefore.length - 1;

    const result = await previousCompleteTypingV42(...args);

    if (completingWholeLine) {
      const speed = updateTypingSpeedV42(true);
      const feedbackNode = document.getElementById('feedback');
      if (feedbackNode) {
        feedbackNode.className = 'feedback ok';
        feedbackNode.textContent =
          `完成全线，共答对 ${state.correct} 站 · 平均 ${speed} 字/分。`;
      }

      await animateFullLineReturnV42();
    }

    return result;
  };

  /* ------------------------------------------------------------
     5. 高层渲染入口统一收口
     ------------------------------------------------------------ */

  const previousRenderAllV42 = renderAll;
  renderAll = function() {
    previousRenderAllV42();
    syncDistrictGeometryV42(true);
    schedulePracticeCleanupV42();
  };

  const previousRenderDynamicV42 = renderDynamic;
  renderDynamic = function() {
    previousRenderDynamicV42();
    syncDistrictGeometryV42(true);
    schedulePracticeCleanupV42();
  };

  const previousPositionTrainV42 = positionTrain;
  positionTrain = function(progress = state.trainProgress) {
    previousPositionTrainV42(progress);
    schedulePracticeCleanupV42();
  };

  const previousSelectLineV42 = selectLine;
  selectLine = function(...args) {
    document.body.classList.remove('line-completed');
    const result = previousSelectLineV42(...args);
    syncDistrictGeometryV42(true);
    schedulePracticeCleanupV42();
    return result;
  };

  const previousClearSelectionV42 = clearSelection;
  clearSelection = function(...args) {
    document.body.classList.remove('line-completed', 'line-completing');
    const result = previousClearSelectionV42(...args);
    state.immersiveStretch = 0;
    syncDistrictGeometryV42(true);
    return result;
  };

  const bodyObserverV42 = new MutationObserver(() => {
    const practiceNow = document.body.classList.contains('practice-on');

    if (practiceNow && !practiceWasOnV42) {
      resetTypingMetricsV42();
      document.body.classList.remove('line-completed');
    }

    practiceWasOnV42 = practiceNow;
    schedulePracticeCleanupV42();
    syncDistrictGeometryV42();
  });

  bodyObserverV42.observe(document.body, {
    attributes: true,
    attributeFilter: ['class'],
  });

  [labelLayer, transferLayer, hoverLayer].forEach(layer => {
    if (!layer) return;
    new MutationObserver(schedulePracticeCleanupV42).observe(layer, {
      childList: true,
      subtree: true,
    });
  });

  syncDistrictGeometryV42(true);
  schedulePracticeCleanupV42();
})();
