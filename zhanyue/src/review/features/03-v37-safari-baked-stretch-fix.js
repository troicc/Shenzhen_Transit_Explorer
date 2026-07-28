
(() => {
  /*
   * Safari 会按 SVG 元素变换前的 bbox 做裁剪/剔除。
   * 这里不再给整条线路设置 scale transform，而是把拉伸后的坐标
   * 直接写入 path d、站点、换乘标记和标签坐标。
   */
  const BAKED_MAX_SCALE = 2.7;
  const BAKED_ENTER_MS = 920;
  const BAKED_RETURN_MS = 860;
  const originalPathD = new Map(LINES.map(line => [line.id, line.d]));
  const parsedPathCache = new Map();
  const bakedAnimation = { raf: 0, token: 0 };

  function bakedEase(t) {
    t = clamp(t, 0, 1);
    return t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  }

  function bakedScale(stretch = state.immersiveStretch || 0) {
    return 1 + (BAKED_MAX_SCALE - 1) * bakedEase(stretch);
  }

  function bakedCenter(line) {
    const [x1, y1, x2, y2] = line.bbox;
    return { x: (x1 + x2) / 2, y: (y1 + y2) / 2 };
  }

  function bakedPoint(point, line, stretch = state.immersiveStretch || 0) {
    const c = bakedCenter(line);
    const s = bakedScale(stretch);
    return {
      x: c.x + (point.x - c.x) * s,
      y: c.y + (point.y - c.y) * s,
    };
  }

  function parseLinePath(line) {
    const d = originalPathD.get(line.id) || line.d;
    const cached = parsedPathCache.get(line.id);
    if (cached && cached.d === d) return cached.points;

    const tokens = String(d).match(/[ML]|[-+]?(?:\d*\.?\d+)(?:e[-+]?\d+)?/ig) || [];
    const points = [];
    let i = 0;
    let command = "M";

    while (i < tokens.length) {
      if (/^[ML]$/i.test(tokens[i])) command = tokens[i++];
      const x = Number(tokens[i++]);
      const y = Number(tokens[i++]);
      if (!Number.isFinite(x) || !Number.isFinite(y)) break;
      points.push({ command: points.length ? "L" : command.toUpperCase(), x, y });
      command = "L";
    }

    parsedPathCache.set(line.id, { d, points });
    return points;
  }

  function pointsToD(points) {
    if (!points.length) return "M 0 0";
    return points.map((p, index) => {
      const command = index === 0 ? "M" : "L";
      return `${command} ${p.x.toFixed(3)} ${p.y.toFixed(3)}`;
    }).join(" ");
  }

  function stretchedFullD(line, stretch = state.immersiveStretch || 0) {
    return pointsToD(parseLinePath(line).map(point => {
      const p = bakedPoint(point, line, stretch);
      return { x: p.x, y: p.y };
    }));
  }

  function pathMetrics(line) {
    const points = parseLinePath(line);
    const cumulative = [0];
    let total = 0;
    for (let i = 1; i < points.length; i++) {
      total += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
      cumulative.push(total);
    }
    return { points, cumulative, total: Math.max(total, 1e-9) };
  }

  function pointAtRawProgress(line, progress) {
    const { points, cumulative, total } = pathMetrics(line);
    if (!points.length) return { x: 0, y: 0 };
    if (points.length === 1) return { x: points[0].x, y: points[0].y };

    const target = clamp(progress, 0, 1) * total;
    let index = 1;
    while (index < cumulative.length && cumulative[index] < target) index++;
    index = Math.min(index, points.length - 1);

    const a = points[index - 1];
    const b = points[index];
    const span = Math.max(1e-9, cumulative[index] - cumulative[index - 1]);
    const t = clamp((target - cumulative[index - 1]) / span, 0, 1);
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
  }

  function partialRawPoints(line, progress) {
    const { points, cumulative, total } = pathMetrics(line);
    if (!points.length) return [];

    const reverse = !!state.reverse;
    const target = clamp(progress, 0, 1) * total;

    if (!reverse) {
      const result = [{ x: points[0].x, y: points[0].y }];
      for (let i = 1; i < points.length; i++) {
        if (cumulative[i] <= target) {
          result.push({ x: points[i].x, y: points[i].y });
          continue;
        }
        const a = points[i - 1];
        const b = points[i];
        const span = Math.max(1e-9, cumulative[i] - cumulative[i - 1]);
        const t = clamp((target - cumulative[i - 1]) / span, 0, 1);
        result.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
        break;
      }
      return result;
    }

    const result = [{ x: points[points.length - 1].x, y: points[points.length - 1].y }];
    for (let i = points.length - 2; i >= 0; i--) {
      if (cumulative[i] >= target) {
        result.push({ x: points[i].x, y: points[i].y });
        continue;
      }
      const a = points[i];
      const b = points[i + 1];
      const span = Math.max(1e-9, cumulative[i + 1] - cumulative[i]);
      const t = clamp((target - cumulative[i]) / span, 0, 1);
      result.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
      break;
    }
    return result;
  }

  function stretchedPartialD(line, progress, stretch = state.immersiveStretch || 0) {
    return pointsToD(partialRawPoints(line, progress).map(point => {
      const p = bakedPoint(point, line, stretch);
      return { x: p.x, y: p.y };
    }));
  }

  function stationPoint(line, index, stretch = state.immersiveStretch || 0) {
    const progress = visualProgress(line, index);
    const raw = pointAtRawProgress(line, progress);
    return bakedPoint(raw, line, stretch);
  }

  function rawStationPoint(line, index) {
    return pointAtRawProgress(line, visualProgress(line, index));
  }

  function mixHexWithWhite(value, ratio = 0.36) {
    const match = String(value || '').trim().match(/^#([0-9a-f]{6})$/i);
    if (!match) return value || '#ffffff';
    const n = Number.parseInt(match[1], 16);
    const r = (n >> 16) & 255;
    const g = (n >> 8) & 255;
    const b = n & 255;
    const mix = channel => Math.round(channel + (255 - channel) * ratio);
    return `#${[mix(r), mix(g), mix(b)].map(channel => channel.toString(16).padStart(2, '0')).join('')}`;
  }

  function bakedTrainScale(stretch = state.immersiveStretch || 0) {
    const routeScale = bakedScale(stretch);
    // The train gets smaller as the route expands, but remains clearly visible.
    return Math.max(0.62, 1 / Math.pow(routeScale, 0.45));
  }

  function positionBakedTrain(progress = state.trainProgress) {
    const line = currentLine();
    if (!line || !state.selectedLineId) {
      train.setAttribute('opacity', '0');
      return;
    }
    const raw = pointAtRawProgress(line, clamp(progress, 0, 1));
    const point = bakedPoint(raw, line);
    const scale = bakedTrainScale();
    train.setAttribute('transform', `translate(${point.x} ${point.y}) scale(${scale})`);
    train.setAttribute('opacity', '1');
    const body = train.querySelector('.train-body');
    if (body) body.setAttribute('fill', line.color);
    const windowPath = train.querySelector('.train-window');
    if (windowPath) windowPath.setAttribute('stroke-width', String(1.8 / scale));
  }

  function setNumericAttribute(node, attribute, value) {
    if (Number.isFinite(value)) node.setAttribute(attribute, String(value));
  }

  function bakeSelectedRoute(line, stretch = state.immersiveStretch || 0) {
    const selectedD = stretchedFullD(line, stretch);

    routeGroupMap.forEach((group, id) => {
      group.removeAttribute("transform");
      const route = lineMap.get(id);
      const d = id === line.id ? selectedD : (originalPathD.get(id) || route?.d || "");
      group.querySelectorAll(".route-casing,.route-color,.route-hit").forEach(path => {
        if (d) path.setAttribute("d", d);
      });
    });

    [stationLayer, transferLayer, labelLayer, hoverLayer].forEach(layer => {
      layer.removeAttribute("transform");
      layer.style.removeProperty("--immersive-marker-inverse");
    });
  }

  function bakeStations(line, stretch = state.immersiveStretch || 0) {
    stationLayer.querySelectorAll(`.station[data-line="${CSS.escape(line.id)}"][data-index]`).forEach(group => {
      const index = Number(group.getAttribute("data-index"));
      if (!Number.isInteger(index)) return;
      const p = stationPoint(line, index, stretch);
      group.querySelectorAll("circle").forEach(circle => {
        setNumericAttribute(circle, "cx", p.x);
        setNumericAttribute(circle, "cy", p.y);
      });
    });
  }

  function bakeTransfers(line, stretch = state.immersiveStretch || 0) {
    const stationIndexByName = new Map(line.stations.map((station, index) => [station.name, index]));

    transferLayer.querySelectorAll(".transfer-hub[data-name]").forEach(group => {
      const name = group.getAttribute("data-name");
      const index = stationIndexByName.get(name);
      if (index == null) return;

      const raw = rawStationPoint(line, index);
      const next = stationPoint(line, index, stretch);
      const dx = next.x - raw.x;
      const dy = next.y - raw.y;

      group.querySelectorAll("[x],[y],[cx],[cy]").forEach(node => {
        ["x", "y", "cx", "cy"].forEach(attribute => {
          if (!node.hasAttribute(attribute)) return;
          const datasetKey = `bakedBase${attribute.toUpperCase()}`;
          if (!(datasetKey in node.dataset)) node.dataset[datasetKey] = node.getAttribute(attribute);
          const base = Number(node.dataset[datasetKey]);
          if (!Number.isFinite(base)) return;
          setNumericAttribute(node, attribute, base + (attribute === "x" || attribute === "cx" ? dx : dy));
        });
      });

      group.setAttribute("data-cx", String(next.x));
      group.setAttribute("data-cy", String(next.y));
      group.removeAttribute("transform");
    });
  }

  function bakeLabels(line, stretch = state.immersiveStretch || 0) {
    const stationIndexByName = new Map(line.stations.map((station, index) => [station.name, index]));

    labelLayer.querySelectorAll("text").forEach(label => {
      const name = (label.textContent || "").trim();
      const index = stationIndexByName.get(name);
      if (index == null) return;

      const raw = rawStationPoint(line, index);
      const next = stationPoint(line, index, stretch);

      if (!label.dataset.bakedBaseX) {
        label.dataset.bakedBaseX = label.getAttribute("x") || String(raw.x);
        label.dataset.bakedBaseY = label.getAttribute("y") || String(raw.y);
        label.dataset.bakedAnchorX = String(raw.x);
        label.dataset.bakedAnchorY = String(raw.y);
      }

      const offsetX = Number(label.dataset.bakedBaseX) - Number(label.dataset.bakedAnchorX);
      const offsetY = Number(label.dataset.bakedBaseY) - Number(label.dataset.bakedAnchorY);
      setNumericAttribute(label, "x", next.x + offsetX);
      setNumericAttribute(label, "y", next.y + offsetY);
      label.removeAttribute("transform");
    });
  }

  function restoreOriginalGeometry() {
    routeGroupMap.forEach((group, id) => {
      group.removeAttribute("transform");
      const d = originalPathD.get(id) || lineMap.get(id)?.d;
      if (!d) return;
      group.querySelectorAll(".route-casing,.route-color,.route-hit").forEach(path => path.setAttribute("d", d));
    });

    [stationLayer, transferLayer, labelLayer, hoverLayer].forEach(layer => {
      layer.removeAttribute("transform");
      layer.style.removeProperty("--immersive-marker-inverse");
    });

    const viewport = metroMap.querySelector("g");
    if (viewport && !state.selectedLineId) viewport.setAttribute("clip-path", "url(#viewportClip)");
  }

  function bakedProgressPath() {
    const line = currentLine();
    routeLayer.querySelectorAll(".route-progress-halo").forEach(node => node.remove());

    if (!line || !state.selectedLineId) {
      routeLayer.querySelectorAll(".route-progress").forEach(node => node.remove());
      return;
    }

    const group = routeGroupMap.get(line.id);
    if (!group) return;

    routeLayer.querySelectorAll(".route-progress").forEach(node => {
      if (node.parentElement !== group) node.remove();
    });

    let path = group.querySelector(".route-progress");
    if (!path) {
      path = svgEl("path", { class: "route-progress" });
      group.insertBefore(path, group.querySelector(".route-hit") || null);
    }

    const atPracticeStart =
      (state.mode === "timed" || state.mode === "full") &&
      state.currentIndex === 0 &&
      (state.typingFraction || 0) <= 0;

    const d = atPracticeStart ? "" : stretchedPartialD(line, state.trainProgress);
    path.removeAttribute("pathLength");
    path.removeAttribute("stroke-dasharray");
    path.removeAttribute("stroke-dashoffset");
    path.setAttribute("stroke-linecap", "butt");
    path.setAttribute("stroke", mixHexWithWhite(line.color, 0.42));
    path.setAttribute("d", d || "M 0 0");
    path.style.display = d ? "" : "none";
  }

  function applyBakedGeometry() {
    const line = currentLine();
    const active = !!line && !!state.selectedLineId && !state.reviewOpen;
    const viewport = metroMap.querySelector("g");

    if (!active) {
      restoreOriginalGeometry();
      return;
    }

    if (viewport) viewport.removeAttribute("clip-path");
    bakeSelectedRoute(line);
    bakeStations(line);
    bakeTransfers(line);
    bakeLabels(line);
    bakedProgressPath();
    positionTrain(state.trainProgress);
  }

  function finalBakedView(line, progress) {
    const ratio = state.overviewView.w / state.overviewView.h;
    const p = bakedPoint(pointAtRawProgress(line, progress), line, 1);
    const direction = (state.trainTargetProgress - progress) || (state.reverse ? -0.01 : 0.01);
    const aheadProgress = clamp(
      progress + (direction < 0 ? -1 : 1) / Math.max(18, line.stations.length * 1.35),
      0,
      1
    );
    const ahead = bakedPoint(pointAtRawProgress(line, aheadProgress), line, 1);

    const originalW = Math.max(
      line.bbox[2] - line.bbox[0],
      (line.bbox[3] - line.bbox[1]) * ratio
    );
    const w = clamp(originalW * 0.47, 320, 470);
    const h = w / ratio;
    const lookX = p.x + (ahead.x - p.x) * 0.28;
    const lookY = p.y + (ahead.y - p.y) * 0.28;

    return {
      x: lookX - w * 0.48,
      y: lookY - h * 0.40,
      w,
      h,
    };
  }

  function animateBakedEntry(duration = BAKED_ENTER_MS, onComplete = null) {
    const line = currentLine();
    if (!line) {
      if (onComplete) onComplete();
      return;
    }

    if (bakedAnimation.raf) cancelAnimationFrame(bakedAnimation.raf);
    if (state.viewAnimationRAF) cancelAnimationFrame(state.viewAnimationRAF);
    if (state.immersiveStretchRAF) cancelAnimationFrame(state.immersiveStretchRAF);

    const token = ++bakedAnimation.token;
    const startView = { ...state.view };
    const targetView = finalBakedView(line, state.trainProgress);
    const startStretch = Number.isFinite(state.immersiveStretch) ? state.immersiveStretch : 0;
    const start = performance.now();

    document.body.classList.add("route-stretching", "is-view-animating");

    function frame(now) {
      if (token !== bakedAnimation.token) return;
      const p = Math.min(1, (now - start) / duration);
      const eased = bakedEase(p);

      state.immersiveStretch = startStretch + (1 - startStretch) * eased;
      state.view = {
        x: startView.x + (targetView.x - startView.x) * eased,
        y: startView.y + (targetView.y - startView.y) * eased,
        w: startView.w + (targetView.w - startView.w) * eased,
        h: startView.h + (targetView.h - startView.h) * eased,
      };

      applyBakedGeometry();
      applyView();

      if (p < 1) {
        bakedAnimation.raf = requestAnimationFrame(frame);
      } else {
        bakedAnimation.raf = 0;
        state.immersiveStretch = 1;
        state.view = targetView;
        applyBakedGeometry();
        commitView();
        document.body.classList.remove("route-stretching", "is-view-animating");
        if (onComplete) onComplete();
      }
    }

    bakedAnimation.raf = requestAnimationFrame(frame);
  }

  let bakedCameraRAF = 0;
  let bakedCameraLast = 0;
  let bakedCameraTarget = null;
  const bakedCameraVelocity = { x: 0, y: 0 };

  function stopBakedCamera() {
    if (bakedCameraRAF) cancelAnimationFrame(bakedCameraRAF);
    bakedCameraRAF = 0;
    bakedCameraLast = 0;
    bakedCameraTarget = null;
    bakedCameraVelocity.x = 0;
    bakedCameraVelocity.y = 0;
    document.body.classList.remove('camera-following');
  }

  function requestBakedCamera(progress = state.trainProgress, { force = false } = {}) {
    if (!(state.mode === 'timed' || state.mode === 'full')) return;
    if (
      state.cameraSuspended ||
      document.body.classList.contains('route-stretching') ||
      document.body.classList.contains('line-completing') ||
      document.body.classList.contains('line-completed')
    ) {
      stopBakedCamera();
      return;
    }
    const line = currentLine();
    if (!line) return;

    const raw = pointAtRawProgress(line, clamp(progress, 0, 1));
    const point = bakedPoint(raw, line);
    const direction = (state.trainTargetProgress - progress) || (state.reverse ? -0.01 : 0.01);
    const aheadProgress = clamp(
      progress + (direction < 0 ? -1 : 1) / Math.max(24, line.stations.length * 1.7),
      0,
      1
    );
    const ahead = bakedPoint(pointAtRawProgress(line, aheadProgress), line);

    const anchorX = 0.48;
    const anchorY = 0.40;
    const u = (point.x - state.view.x) / Math.max(1, state.view.w);
    const v = (point.y - state.view.y) / Math.max(1, state.view.h);
    const edge = Math.max(Math.abs(u - anchorX) / 0.23, Math.abs(v - anchorY) / 0.19);
    const strength = force ? 1 : clamp(Math.pow(Math.max(0, edge - 0.44) / 0.56, 1.45), 0, 1);
    if (strength < 0.01) return;

    const lookX = point.x + (ahead.x - point.x) * 0.30;
    const lookY = point.y + (ahead.y - point.y) * 0.30;
    bakedCameraTarget = {
      x: lookX - state.view.w * anchorX,
      y: lookY - state.view.h * anchorY,
      w: state.view.w,
      h: state.view.h,
    };

    if (bakedCameraRAF) return;
    document.body.classList.add('camera-following');

    function frame(now) {
      bakedCameraRAF = 0;
      if (
        !bakedCameraTarget ||
        state.cameraSuspended ||
        !(state.mode === 'timed' || state.mode === 'full') ||
        document.body.classList.contains('line-completing') ||
        document.body.classList.contains('line-completed')
      ) {
        stopBakedCamera();
        return;
      }

      const dt = Math.min(0.032, Math.max(0.001, (now - (bakedCameraLast || now)) / 1000));
      bakedCameraLast = now;
      const dx = bakedCameraTarget.x - state.view.x;
      const dy = bakedCameraTarget.y - state.view.y;
      const normalized = Math.hypot(dx / Math.max(1, state.view.w), dy / Math.max(1, state.view.h));
      const spring = 40 + 78 * clamp(Math.pow(normalized / 0.28, 0.72), 0, 1);
      const damping = 2 * Math.sqrt(spring) * 0.96;

      bakedCameraVelocity.x += (dx * spring - bakedCameraVelocity.x * damping) * dt;
      bakedCameraVelocity.y += (dy * spring - bakedCameraVelocity.y * damping) * dt;
      state.view.x += bakedCameraVelocity.x * dt;
      state.view.y += bakedCameraVelocity.y * dt;

      // Commit the real viewBox each frame. This avoids a stale mapFlipStage matrix
      // moving baked SVG geometry several screens away in Safari.
      commitView();

      const settled =
        Math.abs(dx) < state.view.w * 0.0002 &&
        Math.abs(dy) < state.view.h * 0.0002 &&
        Math.hypot(bakedCameraVelocity.x, bakedCameraVelocity.y) < 0.02;

      if (settled) {
        state.view.x = bakedCameraTarget.x;
        state.view.y = bakedCameraTarget.y;
        commitView();
        stopBakedCamera();
        return;
      }
      bakedCameraRAF = requestAnimationFrame(frame);
    }

    bakedCameraRAF = requestAnimationFrame(frame);
  }

  window.__zhanyueBakedCameraFollow = requestBakedCamera;
  window.__zhanyueStopBakedCamera = stopBakedCamera;
  window.__zhanyueApplyBakedGeometry = applyBakedGeometry;
  window.__zhanyueRestoreOriginalGeometry = restoreOriginalGeometry;
  window.__zhanyueBakedScale = bakedScale;
  window.__zhanyueBakedPoint = bakedPoint;

  // Replace the previous transform-based train implementation.
  positionTrain = positionBakedTrain;

  // Replace the previous transform-based entry animation.
  fitSelectedLine = function(duration = BAKED_ENTER_MS, onComplete = null) {
    animateBakedEntry(duration, onComplete);
  };

  // Replace progress rendering with a true baked partial path.
  renderProgressPath = bakedProgressPath;
  updateProgressPathPosition = function(progress = state.trainProgress) {
    state.trainProgress = progress;
    bakedProgressPath();
    positionTrain(progress);
  };

  // Every render in older patches may reapply SVG group transforms; neutralize and bake immediately.
  const oldRenderRoutes = renderRoutes;
  renderRoutes = function() {
    oldRenderRoutes();
    applyBakedGeometry();
  };

  const oldRenderStations = renderStations;
  renderStations = function() {
    oldRenderStations();
    applyBakedGeometry();
  };

  const oldRenderDynamic = renderDynamic;
  renderDynamic = function() {
    oldRenderDynamic();
    applyBakedGeometry();
  };

  const oldRenderAll = renderAll;
  renderAll = function() {
    oldRenderAll();
    applyBakedGeometry();
    requestAnimationFrame(applyBakedGeometry);
  };

  // Keep the transform-based return sequence visually synchronized by rebaking every frame.
  const oldClearSelection = clearSelection;
  clearSelection = function() {
    stopBakedCamera();
    oldClearSelection();
    const token = ++bakedAnimation.token;

    function syncReturn() {
      if (token !== bakedAnimation.token) return;
      if (state.selectedLineId) {
        applyBakedGeometry();
        bakedAnimation.raf = requestAnimationFrame(syncReturn);
      } else {
        state.immersiveStretch = 0;
        restoreOriginalGeometry();
        bakedProgressPath();
      }
    }

    bakedAnimation.raf = requestAnimationFrame(syncReturn);
  };

  // Stronger caret removal for Safari input and overlay combinations.
  typeInput.style.caretColor = "transparent";
  typeInput.addEventListener("focus", () => {
    typeInput.style.caretColor = "transparent";
  });

  applyBakedGeometry();
})();
