import {
  clamp, lerp, stationTravelPhase, stationVisualState,
} from './core.js?v=3';

let amapLoader = null;

function loadAmap(key, serviceHost, securityCode) {
  if (window.AMap?.Map) return Promise.resolve(window.AMap);
  if (amapLoader) return amapLoader;
  if (!key) return Promise.reject(new Error('尚未配置高德 Web JS Key'));
  if (securityCode) window._AMapSecurityConfig = {securityJsCode: securityCode};
  else if (serviceHost) window._AMapSecurityConfig = {serviceHost};
  amapLoader = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    const timer = setTimeout(() => reject(new Error('真实地图加载超时')), 15000);
    script.src = `https://webapi.amap.com/maps?v=2.0&key=${encodeURIComponent(key)}`;
    script.async = true;
    script.addEventListener('load', () => {
      clearTimeout(timer);
      if (window.AMap?.Map) resolve(window.AMap);
      else reject(new Error('高德地图初始化失败'));
    }, {once: true});
    script.addEventListener('error', () => {
      clearTimeout(timer);
      amapLoader = null;
      reject(new Error('无法加载真实地图，已保留示意图进度'));
    }, {once: true});
    document.head.append(script);
  });
  return amapLoader;
}

function geoMetrics(path) {
  const meanLatitude = path.length
    ? path.reduce((sum, point) => sum + Number(point[1]), 0) / path.length
    : 0;
  const longitudeScale = Math.cos(meanLatitude * Math.PI / 180);
  const cumulative = [0];
  let total = 0;
  for (let index = 1; index < path.length; index += 1) {
    const dx = (Number(path[index][0]) - Number(path[index - 1][0])) * longitudeScale;
    const dy = Number(path[index][1]) - Number(path[index - 1][1]);
    total += Math.hypot(dx, dy);
    cumulative.push(total);
  }
  return {cumulative, total};
}

function geoPointAtProgress(path, progress, metrics = geoMetrics(path)) {
  if (!path.length) return null;
  if (path.length === 1 || metrics.total <= 0) return path[0].map(Number);
  const target = clamp(progress, 0, 1) * metrics.total;
  for (let index = 1; index < path.length; index += 1) {
    if (metrics.cumulative[index] >= target) {
      const span = metrics.cumulative[index] - metrics.cumulative[index - 1] || 1;
      const ratio = (target - metrics.cumulative[index - 1]) / span;
      return [
        lerp(Number(path[index - 1][0]), Number(path[index][0]), ratio),
        lerp(Number(path[index - 1][1]), Number(path[index][1]), ratio),
      ];
    }
  }
  return path.at(-1).map(Number);
}

function geoPathSlice(path, startProgress, endProgress, metrics = geoMetrics(path)) {
  if (path.length < 2) return path.map(point => point.map(Number));
  const low = Math.min(startProgress, endProgress);
  const high = Math.max(startProgress, endProgress);
  const lowDistance = clamp(low, 0, 1) * metrics.total;
  const highDistance = clamp(high, 0, 1) * metrics.total;
  const output = [geoPointAtProgress(path, low, metrics)];
  for (let index = 1; index < path.length - 1; index += 1) {
    if (metrics.cumulative[index] > lowDistance && metrics.cumulative[index] < highDistance) {
      output.push(path[index].map(Number));
    }
  }
  output.push(geoPointAtProgress(path, high, metrics));
  return startProgress <= endProgress ? output : output.reverse();
}

function normalizeRotation(value) {
  return ((Number(value) + 180) % 360 + 360) % 360 - 180;
}

function shortestRotationDelta(from, to) {
  return normalizeRotation(Number(to) - Number(from));
}

function smoothedGeoDirection(path, progress, travelSign, metrics, sampleDistance = .005) {
  const start = geoPointAtProgress(path, clamp(progress - travelSign * sampleDistance, 0, 1), metrics);
  const end = geoPointAtProgress(path, clamp(progress + travelSign * sampleDistance, 0, 1), metrics);
  return {dx: end[0] - start[0], dy: end[1] - start[1]};
}

function stationMarkerContent(stop, visualState, travelPhase, terminal) {
  const marker = document.createElement('div');
  marker.className = `real-map-station ${visualState}${terminal ? ' terminal' : ''}`;
  marker.dataset.phase = travelPhase;
  const dot = document.createElement('span');
  dot.className = 'real-map-station-dot';
  const label = document.createElement('span');
  label.className = 'real-map-station-label';
  label.textContent = stop.name;
  marker.append(dot, label);
  return marker;
}

function vehicleContent(type = 'bus') {
  const marker = document.createElement('div');
  marker.className = `real-map-vehicle ${type}`;
  marker.innerHTML = [
    '<div class="real-map-bus">',
    '<i class="real-map-wheel wheel-left"></i>',
    '<i class="real-map-wheel wheel-right"></i>',
    '<span class="real-map-bus-body"></span>',
    '<span class="real-map-bus-sign"></span>',
    '<span class="real-map-windshield"></span>',
    '<span class="real-map-window-divider"></span>',
    '<span class="real-map-front-panel"></span>',
    '<span class="real-map-grille"></span>',
    '<i class="real-map-headlight light-a"></i>',
    '<i class="real-map-headlight light-b"></i>',
    '<span class="real-map-bumper"></span>',
    '</div>',
  ].join('');
  return marker;
}

export class RealMapFocusRenderer {
  constructor({container}) {
    this.container = container;
    this.map = null;
    this.AMap = null;
    this.route = null;
    this.color = '#5cc8ff';
    this.overlays = [];
    this.stationMarkers = [];
    this.lastStationKey = null;
    this.cameraFrame = 0;
    this.cameraState = null;
    this.cameraTarget = null;
    this.cameraLastTime = 0;
    this.cameraPaused = false;
    this.lastFrame = null;
    this.vehicleType = 'bus';
  }

  setVehicleType(type) { this.vehicleType = type === 'metro' ? 'metro' : 'bus'; }

  async ensureMap() {
    if (this.map) return;
    const response = await fetch('/api/runtime');
    if (!response.ok) throw new Error('无法读取真实地图配置');
    const runtime = await response.json();
    const config = runtime.amap || {};
    this.AMap = await loadAmap(
      config.amap_js_key,
      config.amap_service_host,
      config.amap_security_code,
    );
    this.map = new this.AMap.Map(this.container, {
      viewMode: '3D',
      zoom: 11,
      showLabel: false,
      mapStyle: 'amap://styles/darkblue',
      features: ['bg', 'road', 'building', 'point'],
    });
  }

  async show(route, color, styleMode = 'animated') {
    const path = route.geometry?.gcj02?.path;
    if (!path?.length) throw new Error('当前线路尚未生成真实地图坐标');
    await this.ensureMap();
    this.container.setAttribute('aria-hidden', 'false');
    if (this.route?.id !== route.id) {
      this.lastFrame = null;
      this.setRoute(route, color);
    }
    this.setStyleMode(styleMode);
    requestAnimationFrame(() => this.map?.resize());
  }

  setStyleMode(styleMode) {
    this.styleMode = styleMode;
    this.stopCameraMotion();
    this.cameraPaused = false;
    if (!this.map) return;
    if (styleMode === 'animated') {
      this.map.setMapStyle('amap://styles/darkblue');
      this.map.setFeatures(['bg', 'road', 'building']);
      this.map.setPitch(48);
    } else {
      this.map.setMapStyle('amap://styles/normal');
      this.map.setFeatures(['bg', 'road', 'building', 'point']);
      this.map.setPitch(34);
      this.map.setRotation(0);
    }
  }

  hide() {
    this.stopCameraMotion();
    this.container.setAttribute('aria-hidden', 'true');
  }

  stopCameraMotion() {
    cancelAnimationFrame(this.cameraFrame);
    this.cameraFrame = 0;
    this.cameraState = null;
    this.cameraTarget = null;
    this.cameraLastTime = 0;
  }

  applyCamera(camera) {
    if (!this.map || !camera) return;
    const rotation = normalizeRotation(camera.rotation);
    this.container.dataset.cameraMode = this.styleMode || 'animated';
    this.container.dataset.cameraRotation = rotation.toFixed(2);
    this.container.dataset.cameraPitch = Number(camera.pitch).toFixed(1);
    this.map.setRotation(rotation);
    this.map.setPitch(camera.pitch);
    this.map.setZoomAndCenter(camera.zoom, camera.center, true, 0);
  }

  queueCamera(camera, immediate = false) {
    if (!this.map) return;
    const target = {
      center: camera.center.map(Number),
      rotation: normalizeRotation(camera.rotation),
      zoom: Number(camera.zoom),
      pitch: Number(camera.pitch),
    };
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (immediate || reduceMotion || !this.cameraState) {
      this.cameraState = {...target, center: [...target.center]};
      this.cameraTarget = target;
      this.applyCamera(this.cameraState);
      return;
    }
    this.cameraTarget = target;
    if (!this.cameraFrame) {
      this.cameraLastTime = performance.now();
      this.cameraFrame = requestAnimationFrame(now => this.stepCamera(now));
    }
  }

  stepCamera(now) {
    this.cameraFrame = 0;
    if (!this.cameraState || !this.cameraTarget || !this.map) return;
    const elapsed = clamp(now - this.cameraLastTime, 4, 48);
    this.cameraLastTime = now;
    const positionBlend = 1 - Math.exp(-elapsed / 230);
    const rotationBlend = 1 - Math.exp(-elapsed / 310);
    const target = this.cameraTarget;
    const rotationDelta = shortestRotationDelta(this.cameraState.rotation, target.rotation);
    this.cameraState = {
      center: [
        lerp(this.cameraState.center[0], target.center[0], positionBlend),
        lerp(this.cameraState.center[1], target.center[1], positionBlend),
      ],
      rotation: normalizeRotation(this.cameraState.rotation + rotationDelta * rotationBlend),
      zoom: lerp(this.cameraState.zoom, target.zoom, positionBlend),
      pitch: lerp(this.cameraState.pitch, target.pitch, positionBlend),
    };
    this.applyCamera(this.cameraState);
    const centerGap = Math.hypot(
      this.cameraState.center[0] - target.center[0],
      this.cameraState.center[1] - target.center[1],
    );
    const settled = centerGap < 1e-7
      && Math.abs(shortestRotationDelta(this.cameraState.rotation, target.rotation)) < .08
      && Math.abs(this.cameraState.zoom - target.zoom) < .002
      && Math.abs(this.cameraState.pitch - target.pitch) < .05;
    if (settled) {
      this.cameraState = {...target, center: [...target.center]};
      this.applyCamera(this.cameraState);
      return;
    }
    this.cameraFrame = requestAnimationFrame(next => this.stepCamera(next));
  }

  setRoute(route, color) {
    this.clearOverlays();
    this.route = route;
    this.color = color;
    this.path = route.geometry.gcj02.path.map(point => point.map(Number));
    this.metrics = geoMetrics(this.path);
    this.lastStationKey = null;
    this.stopCameraMotion();
    this.cameraPaused = false;

    const casing = new this.AMap.Polyline({
      path: this.path,
      strokeColor: '#020711',
      strokeWeight: 13,
      strokeOpacity: .92,
      lineJoin: 'round',
      lineCap: 'round',
      zIndex: 45,
    });
    this.futureLine = new this.AMap.Polyline({
      path: this.path,
      strokeColor: color,
      strokeWeight: 8,
      strokeOpacity: .5,
      lineJoin: 'round',
      lineCap: 'round',
      zIndex: 50,
    });
    this.progressLine = new this.AMap.Polyline({
      path: [this.path[0], this.path[0]],
      strokeColor: color,
      strokeWeight: 8,
      strokeOpacity: .96,
      lineJoin: 'round',
      lineCap: 'round',
      zIndex: 55,
    });
    this.vehicleElement = vehicleContent(this.vehicleType);
    this.vehicleMarker = new this.AMap.Marker({
      position: this.path[0],
      content: this.vehicleElement,
      anchor: 'center',
      zIndex: 90,
    });
    this.overlays.push(casing, this.futureLine, this.progressLine, this.vehicleMarker);
    this.routeCasing = casing;
    this.map.add(this.overlays);
    // Finish the overview fit synchronously so the first follow-camera frame is
    // not overwritten by a late fit animation on long cross-city routes.
    this.map.setFitView([casing], true, [92, 92, 240, 92], 15);
    if (this.lastFrame) this.renderDynamic(this.lastFrame);
  }

  clearOverlays() {
    if (this.map && this.overlays.length) this.map.remove(this.overlays);
    this.overlays = [];
    this.stationMarkers = [];
    this.futureLine = null;
    this.progressLine = null;
    this.vehicleMarker = null;
    this.routeCasing = null;
  }

  fitRoute() {
    if (this.map && this.routeCasing) {
      this.stopCameraMotion();
      this.cameraPaused = true;
      this.map.setRotation(0);
      this.map.setPitch(this.styleMode === 'animated' ? 36 : 24);
      this.map.setFitView([this.routeCasing], false, [92, 92, 240, 92], 15);
    }
  }

  refreshStationMarkers(frame) {
    const {currentOriginalIndex, nextOriginalIndex, reverse} = frame;
    const key = `${currentOriginalIndex}:${nextOriginalIndex}:${reverse}`;
    if (key === this.lastStationKey) return;
    this.lastStationKey = key;
    if (this.stationMarkers.length) {
      this.map.remove(this.stationMarkers);
      this.overlays = this.overlays.filter(item => !this.stationMarkers.includes(item));
    }
    const count = this.route.stops.length;
    const indices = [...new Set([0, currentOriginalIndex, nextOriginalIndex, count - 1])]
      .filter(index => index != null && index >= 0 && index < count);
    this.stationMarkers = indices.map(index => {
      const stop = this.route.stops[index];
      const state = stationVisualState(index, count, currentOriginalIndex, nextOriginalIndex, reverse);
      const phase = stationTravelPhase(index, count, currentOriginalIndex, nextOriginalIndex, reverse);
      return new this.AMap.Marker({
        position: stop.gcj02,
        content: stationMarkerContent(stop, state, phase, index === 0 || index === count - 1),
        anchor: 'center',
        zIndex: state === 'current' ? 86 : state === 'next' ? 82 : 75,
      });
    });
    this.overlays.push(...this.stationMarkers);
    this.map.add(this.stationMarkers);
  }

  renderDynamic(frame) {
    this.lastFrame = frame;
    if (!this.map || !this.route || !this.progressLine || !this.vehicleMarker) return;
    const {currentOriginalIndex, nextOriginalIndex, reverse, typingRatio} = frame;
    const current = this.route.stops[currentOriginalIndex];
    if (!current) return;
    const next = nextOriginalIndex == null ? current : this.route.stops[nextOriginalIndex];
    const startProgress = Number(current.overviewProgress ?? current.progress ?? 0);
    const endProgress = Number(next?.overviewProgress ?? next?.progress ?? startProgress);
    const actualProgress = lerp(startProgress, endProgress, typingRatio || 0);
    this.container.dataset.vehicleProgress = actualProgress.toFixed(6);
    const passed = reverse
      ? geoPathSlice(this.path, 1, actualProgress, this.metrics)
      : geoPathSlice(this.path, 0, actualProgress, this.metrics);
    this.progressLine.setPath(passed.length >= 2 ? passed : [passed[0], passed[0]]);

    const point = geoPointAtProgress(this.path, actualProgress, this.metrics);
    const travelSign = reverse ? -1 : 1;
    const direction = smoothedGeoDirection(this.path, actualProgress, travelSign, this.metrics);
    let {dx, dy} = direction;
    if (Math.hypot(dx, dy) < 1e-9) {
      const fallback = smoothedGeoDirection(this.path, actualProgress, travelSign, this.metrics, .012);
      dx = fallback.dx;
      dy = fallback.dy;
    }
    this.vehicleMarker.setPosition(point);
    this.refreshStationMarkers(frame);

    if (frame.journeyActive) this.cameraPaused = false;
    if (this.cameraPaused) return;
    const bearing = Math.atan2(dx, dy) * 180 / Math.PI;
    const lookAhead = geoPointAtProgress(
      this.path,
      clamp(actualProgress + travelSign * (this.styleMode === 'animated' ? .009 : .007), 0, 1),
      this.metrics,
    );
    const forwardWeight = this.styleMode === 'animated' ? .62 : .48;
    const forwardCenter = [
      lerp(point[0], lookAhead[0], forwardWeight),
      lerp(point[1], lookAhead[1], forwardWeight),
    ];
    this.queueCamera({
      center: forwardCenter,
      rotation: -bearing,
      zoom: this.styleMode === 'animated' ? 15.7 : 15.25,
      pitch: this.styleMode === 'animated' ? 50 : 34,
    });
  }
}

export {
  geoMetrics, geoPathSlice, geoPointAtProgress, normalizeRotation,
  shortestRotationDelta, smoothedGeoDirection,
};
