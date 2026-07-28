
(() => {
  let visualRAF = 0;

  function isPracticeRunning() {
    return !!state.selectedLineId &&
      (state.mode === 'timed' || state.mode === 'full') &&
      document.body.classList.contains('practice-on');
  }

  function ensureTrainAboveCurrentStationOverlay() {
    const overlay = document.getElementById('currentStationOverlay');
    if (!overlay || !train.parentNode) return;

    /*
     * SVG 使用 DOM 顺序决定绘制层级。
     * 把当前站圆环放到 train 之前，使列车始终绘制在圆环和站点之上。
     */
    if (overlay.nextSibling !== train) {
      train.parentNode.insertBefore(overlay, train);
    }
  }

  function enforcePracticeLabelIsolation() {
    visualRAF = 0;
    ensureTrainAboveCurrentStationOverlay();

    const line = currentLine();
    const station = currentStation();
    const practice = isPracticeRunning();

    if (!line || !station || !state.selectedLineId || !practice) {
      transferLayer.querySelectorAll('.transfer-hub.v41-practice-hidden')
        .forEach(node => node.classList.remove('v41-practice-hidden'));
      labelLayer.querySelectorAll('.station-label.v41-practice-hidden')
        .forEach(node => node.classList.remove('v41-practice-hidden'));
      return;
    }

    const currentName = station.name;
    const lineNames = new Set(line.stations.map(item => item.name));

    transferLayer.querySelectorAll('.transfer-hub').forEach(node => {
      const name = node.dataset.name || '';
      const visible = lineNames.has(name) && name === currentName;
      node.classList.toggle('v41-practice-hidden', !visible);

      if (visible) {
        node.style.removeProperty('display');
        node.style.opacity = '1';
        node.classList.add('is-current');
      }
    });

    labelLayer.querySelectorAll('.station-label').forEach(node => {
      const name = (node.textContent || '').trim();
      const visible = lineNames.has(name) && name === currentName;
      node.classList.toggle('v41-practice-hidden', !visible);

      if (visible) {
        node.style.removeProperty('display');
        node.style.opacity = '1';
        node.classList.add('current-label');
      }
    });
  }

  function schedulePracticeVisualFix() {
    if (visualRAF) cancelAnimationFrame(visualRAF);
    visualRAF = requestAnimationFrame(enforcePracticeLabelIsolation);
  }

  /*
   * 旧补丁会在 render / positionTrain / 当前题目切换时重建或重新排序图层，
   * 因此在所有高层入口之后再次校正。
   */
  const previousRenderAllV41 = renderAll;
  renderAll = function() {
    previousRenderAllV41();
    schedulePracticeVisualFix();
  };

  const previousRenderDynamicV41 = renderDynamic;
  renderDynamic = function() {
    previousRenderDynamicV41();
    schedulePracticeVisualFix();
  };

  const previousPositionTrainV41 = positionTrain;
  positionTrain = function(progress = state.trainProgress) {
    previousPositionTrainV41(progress);
    schedulePracticeVisualFix();
  };

  const previousSelectLineV41 = selectLine;
  selectLine = function(...args) {
    const result = previousSelectLineV41(...args);
    schedulePracticeVisualFix();
    setTimeout(schedulePracticeVisualFix, 980);
    return result;
  };

  const previousClearSelectionV41 = clearSelection;
  clearSelection = function(...args) {
    const result = previousClearSelectionV41(...args);
    schedulePracticeVisualFix();
    return result;
  };

  const observer = new MutationObserver(schedulePracticeVisualFix);
  [stationLayer, transferLayer, labelLayer, train.parentNode].forEach(layer => {
    if (layer) observer.observe(layer, { childList: true, subtree: true });
  });

  typeInput.addEventListener('input', schedulePracticeVisualFix);
  typeInput.addEventListener('focus', schedulePracticeVisualFix);

  schedulePracticeVisualFix();
})();
