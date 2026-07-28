import {
  clamp, easeOutCubic, lerp, pathD, pointAtProgress, pointSegmentDistance,
  pathSlice, routeColor, stationTravelPhase, stationVisualState, svgEl,
} from './core.js?v=3';
import {computeFocusView, layoutStationLabels} from './geometry.js';

export class OverviewRenderer {
  constructor({canvas, stage}) {
    this.canvas = canvas;
    this.stage = stage;
    this.ctx = canvas.getContext('2d', {alpha: true});
    this.overview = null;
    this.routeCache = [];
    this.view = {x: 0, y: 0, w: 10000, h: 6000};
    this.homeView = {...this.view};
    this.focused = false;
    this.highlightId = null;
    this.dpr = 1;
    this.frame = 0;
  }

  setData(overview) {
    this.overview = overview;
    this.allPath = new Path2D();
    this.colorBuckets = Array.from({length: 12}, () => new Path2D());
    this.bucketColors = [
      '#ff6b5f', '#28b9f5', '#a76bff', '#ffb627', '#21c997', '#f45bb5',
      '#586df4', '#e96d2f', '#53c94f', '#d84ee8', '#00b6a8', '#f18f01',
    ];
    this.routeCache = overview.routes.map(route => {
      const path = new Path2D();
      const points = route.path || [];
      if (points.length) {
        path.moveTo(points[0][0], points[0][1]);
        this.allPath.moveTo(points[0][0], points[0][1]);
        let hash = 0;
        for (const character of String(route.route_no || '')) hash = ((hash << 5) - hash + character.charCodeAt(0)) | 0;
        const bucket = this.colorBuckets[Math.abs(hash) % this.colorBuckets.length];
        bucket.moveTo(points[0][0], points[0][1]);
        for (let index = 1; index < points.length; index += 1) {
          path.lineTo(points[index][0], points[index][1]);
          this.allPath.lineTo(points[index][0], points[index][1]);
          bucket.lineTo(points[index][0], points[index][1]);
        }
      }
      return {...route, canvasPath: path};
    });
    this.fitHome();
  }

  resize() {
    const rectangle = this.stage.getBoundingClientRect();
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.max(1, Math.round(rectangle.width * this.dpr));
    this.canvas.height = Math.max(1, Math.round(rectangle.height * this.dpr));
    this.canvas.style.width = `${rectangle.width}px`;
    this.canvas.style.height = `${rectangle.height}px`;
    if (this.overview) {
      const centerX = this.view.x + this.view.w / 2;
      const centerY = this.view.y + this.view.h / 2;
      const height = this.view.w * rectangle.height / Math.max(1, rectangle.width);
      this.view = {x: centerX - this.view.w / 2, y: centerY - height / 2, w: this.view.w, h: height};
    }
    this.draw();
  }

  fitHome() {
    if (!this.overview) return;
    const world = this.overview.world;
    this.fitBox([0, 0, world.width, world.height], .045, false);
    this.homeView = {...this.view};
  }

  fitBox(box, padding = .12, animate = true) {
    const rectangle = this.stage.getBoundingClientRect();
    let [minX, minY, maxX, maxY] = box;
    let width = Math.max(80, maxX - minX) * (1 + padding * 2);
    let height = Math.max(80, maxY - minY) * (1 + padding * 2);
    const aspect = rectangle.width / Math.max(1, rectangle.height);
    if (width / height < aspect) width = height * aspect;
    else height = width / aspect;
    const target = {x: (minX + maxX - width) / 2, y: (minY + maxY - height) / 2, w: width, h: height};
    if (animate) this.animateView(target);
    else { this.view = target; this.draw(); }
  }

  animateView(target, duration = 420) {
    cancelAnimationFrame(this.frame);
    const start = {...this.view};
    const startedAt = performance.now();
    const step = now => {
      const progress = clamp((now - startedAt) / duration, 0, 1);
      const eased = easeOutCubic(progress);
      this.view = {
        x: lerp(start.x, target.x, eased), y: lerp(start.y, target.y, eased),
        w: lerp(start.w, target.w, eased), h: lerp(start.h, target.h, eased),
      };
      this.draw();
      if (progress < 1) this.frame = requestAnimationFrame(step);
    };
    this.frame = requestAnimationFrame(step);
  }

  setFocused(focused, highlightId = null) {
    this.focused = focused;
    this.highlightId = highlightId;
    this.draw();
  }

  setView(view) {
    this.view = {...view};
    this.draw();
  }

  panByPixels(dx, dy) {
    const rectangle = this.stage.getBoundingClientRect();
    this.view.x -= dx / Math.max(1, rectangle.width) * this.view.w;
    this.view.y -= dy / Math.max(1, rectangle.height) * this.view.h;
    this.draw();
  }

  zoomAt(clientX, clientY, factor) {
    if (!this.overview) return;
    const rectangle = this.stage.getBoundingClientRect();
    const point = this.worldFromClient(clientX, clientY);
    const maxWidth = this.overview.world.width * 3;
    const width = clamp(this.view.w * factor, 80, maxWidth);
    const height = width * rectangle.height / Math.max(1, rectangle.width);
    const ratioX = (clientX - rectangle.left) / Math.max(1, rectangle.width);
    const ratioY = (clientY - rectangle.top) / Math.max(1, rectangle.height);
    this.view = {x: point[0] - ratioX * width, y: point[1] - ratioY * height, w: width, h: height};
    this.draw();
  }

  worldFromClient(clientX, clientY) {
    const rectangle = this.stage.getBoundingClientRect();
    return [
      this.view.x + (clientX - rectangle.left) / Math.max(1, rectangle.width) * this.view.w,
      this.view.y + (clientY - rectangle.top) / Math.max(1, rectangle.height) * this.view.h,
    ];
  }

  nearestRoute(clientX, clientY) {
    if (!this.overview || this.focused) return null;
    const point = this.worldFromClient(clientX, clientY);
    const rectangle = this.stage.getBoundingClientRect();
    const threshold = this.view.w / Math.max(1, rectangle.width) * 10;
    let best = null;
    let bestDistance = threshold;
    for (const route of this.routeCache) {
      const [minX, minY, maxX, maxY] = route.bbox;
      if (point[0] < minX - threshold || point[0] > maxX + threshold || point[1] < minY - threshold || point[1] > maxY + threshold) continue;
      const points = route.path || [];
      for (let index = 1; index < points.length; index += 1) {
        const value = pointSegmentDistance(point, points[index - 1], points[index]);
        if (value < bestDistance) { bestDistance = value; best = route; }
      }
    }
    return best;
  }

  draw() {
    cancelAnimationFrame(this.drawFrame);
    this.drawFrame = requestAnimationFrame(() => this.drawNow());
  }

  drawNow() {
    const ctx = this.ctx;
    const rectangle = this.stage.getBoundingClientRect();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (!this.overview) return;
    const scaleX = this.dpr * rectangle.width / this.view.w;
    const scaleY = this.dpr * rectangle.height / this.view.h;
    ctx.setTransform(scaleX, 0, 0, scaleY, -this.view.x * scaleX, -this.view.y * scaleY);
    const worldPerPixel = this.view.w / Math.max(1, rectangle.width);
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';

    ctx.strokeStyle = this.focused ? 'rgba(127,157,190,.07)' : 'rgba(132,163,197,.08)';
    ctx.lineWidth = worldPerPixel * (this.focused ? .9 : 1.2);
    if (this.allPath) ctx.stroke(this.allPath);

    if (!this.focused && this.colorBuckets) {
      ctx.globalAlpha = .48;
      ctx.lineWidth = worldPerPixel * 1.45;
      this.colorBuckets.forEach((bucket, index) => {
        ctx.strokeStyle = this.bucketColors[index];
        ctx.stroke(bucket);
      });
      ctx.globalAlpha = 1;
    }

    if (this.highlightId) {
      const selected = this.routeCache.find(route => route.id === this.highlightId);
      if (selected) {
        ctx.strokeStyle = routeColor(selected.route_no);
        ctx.lineWidth = worldPerPixel * 4.5;
        ctx.globalAlpha = this.focused ? .28 : .85;
        ctx.stroke(selected.canvasPath);
        ctx.globalAlpha = 1;
      }
    }
  }
}

export function immersiveScaleFactor(stationCount, strong = false) {
  const base = strong ? .49 : .62;
  return clamp(base + 8 / Math.max(2, stationCount), .50, .72);
}

export class FocusRenderer {
  constructor({svg, routeLayer, stationLayer, labelLayer, effectLayer, train, stage, onStationClick}) {
    this.svg = svg;
    this.routeLayer = routeLayer;
    this.stationLayer = stationLayer;
    this.labelLayer = labelLayer;
    this.effectLayer = effectLayer;
    this.train = train;
    this.stage = stage;
    this.onStationClick = onStationClick;
    this.route = null;
    this.sourceGeometry = null;
    this.geometry = null;
    this.color = '#5cc8ff';
    this.stationNodes = [];
    this.view = {x: 0, y: 0, w: 1000, h: 600};
    this.viewFrame = 0;
    this.viewAnimationToken = 0;
    this.lastDynamic = null;
    this.lastFollowKey = null;
    this.vehicleScale = 1;
    this.vehicleFacingNode = train.querySelector('.vehicle-facing');
  }

  clear() {
    this.cancelViewAnimation();
    this.route = null;
    this.sourceGeometry = null;
    this.geometry = null;
    this.routeLayer.innerHTML = '';
    this.stationLayer.innerHTML = '';
    this.labelLayer.innerHTML = '';
    if (this.effectLayer) this.effectLayer.innerHTML = '';
    this.train.setAttribute('opacity', '0');
    this.lastDynamic = null;
    this.lastFollowKey = null;
  }

  setRoute(route, geometry, color) {
    this.cancelViewAnimation();
    this.route = route;
    this.sourceGeometry = {
      ...geometry,
      path: geometry.path.map(point => [...point]),
      stationPoints: geometry.stationPoints.map(point => [...point]),
      stationProgresses: [...geometry.stationProgresses],
      bbox: [...geometry.bbox],
    };
    this.geometry = this.sourceGeometry;
    this.vehicleScale = 1;
    this.color = color;
    document.documentElement.style.setProperty('--route', color);
    this.routeLayer.innerHTML = '';
    this.stationLayer.innerHTML = '';
    this.labelLayer.innerHTML = '';
    if (this.effectLayer) this.effectLayer.innerHTML = '';
    this.lastFollowKey = null;

    const data = pathD(geometry.path);
    const base = svgEl('path', {d: data, class: 'route-base'});
    const main = svgEl('path', {d: data, class: 'route-main route-draw', pathLength: 1});
    const progress = svgEl('path', {d: data, class: 'route-progress', pathLength: 1});
    const hit = svgEl('path', {d: data, class: 'route-hit'});
    this.routeLayer.append(base, main, progress, hit);
    this.mainPath = main;
    this.progressPath = progress;
    this.basePath = base;
    this.hitPath = hit;

    this.stationNodes = route.stops.map((stop, index) => {
      const point = geometry.stationPoints[index];
      const group = svgEl('g', {class: `station-node${stop.transfer ? ' transfer' : ''}${stop.estimated ? ' estimated' : ''}`, 'data-index': index});
      const circle = svgEl('circle', {class: 'station-core', cx: point[0], cy: point[1], r: 5});
      group.append(circle);
      group.addEventListener('click', event => { event.stopPropagation(); this.onStationClick?.(index); });
      this.stationLayer.append(group);
      return {group, circle};
    });

  }

  setDisplayGeometry(geometry, {vehicleScale = 1} = {}) {
    if (!this.route || !geometry) return false;
    this.geometry = geometry;
    this.vehicleScale = Number.isFinite(Number(vehicleScale)) ? Number(vehicleScale) : 1;
    const data = pathD(geometry.path);
    [this.basePath, this.mainPath, this.hitPath].forEach(path => path?.setAttribute('d', data));
    this.stationNodes.forEach((item, index) => {
      const point = geometry.stationPoints[index];
      if (!point) return;
      item.circle.setAttribute('cx', point[0]);
      item.circle.setAttribute('cy', point[1]);
    });
    if (this.lastDynamic) this.renderDynamic(this.lastDynamic);
    return true;
  }

  resetDisplayGeometry() {
    return this.sourceGeometry ? this.setDisplayGeometry(this.sourceGeometry, {vehicleScale: 1}) : false;
  }

  setVehicleType(type) {
    const template = this.svg.querySelector(`#${type}VehicleTemplate`);
    const content = this.train.querySelector('.vehicle-content') || this.train;
    if (!template || !content) return false;
    const clone = template.cloneNode(true);
    clone.removeAttribute('id');
    content.replaceChildren(clone);
    this.train.dataset.vehicleType = type;
    this.vehicleFacingNode = this.train.querySelector('.vehicle-facing');
    return true;
  }

  getView() { return {...this.view}; }

  getRouteBounds() { return this.geometry ? [...this.geometry.bbox] : null; }

  pointAtProgress(progress) {
    return this.geometry ? pointAtProgress(this.geometry.path, clamp(progress, 0, 1)) : null;
  }

  pointAhead(progress, reverse = false, distanceHint = null) {
    if (!this.geometry) return null;
    const count = Number(distanceHint) || this.route?.stops?.length || 2;
    const step = 1 / Math.max(18, (count - 1) * 1.45);
    return this.pointAtProgress(clamp(progress + (reverse ? -step : step), 0, 1));
  }

  fit(practiceVisible, animate = true) {
    return this.fitFullRoute({practiceVisible, animate});
  }

  fullRouteView({practiceVisible = false, geometry = this.geometry} = {}) {
    if (!geometry) return null;
    const rectangle = this.stage.getBoundingClientRect();
    return computeFocusView(
      geometry.bbox,
      rectangle.width,
      rectangle.height,
      practiceVisible,
      this.bottomInset(practiceVisible),
    );
  }

  fitFullRoute({practiceVisible = false, animate = true, duration = 430, geometry = this.geometry, easing} = {}) {
    const target = this.fullRouteView({practiceVisible, geometry});
    if (!target) return Promise.resolve(false);
    return this.setView(target, {animate, duration, commit: true, easing});
  }

  immersiveView(progress, {reverse = false, strong = false, practiceVisible = false, geometry = this.geometry} = {}) {
    if (!geometry) return null;
    const rectangle = this.stage.getBoundingClientRect();
    const full = computeFocusView(
      geometry.bbox,
      rectangle.width,
      rectangle.height,
      practiceVisible,
      this.bottomInset(practiceVisible),
    );
    const factor = immersiveScaleFactor(this.route?.stops?.length || 2, strong);
    const width = Math.max(100, full.w * factor);
    const height = width * rectangle.height / Math.max(1, rectangle.width);
    const point = pointAtProgress(geometry.path, clamp(progress, 0, 1)) || [full.x + full.w / 2, full.y + full.h / 2];
    const count = this.route?.stops?.length || 2;
    const step = 1 / Math.max(18, (count - 1) * 1.45);
    const ahead = pointAtProgress(geometry.path, clamp(progress + (reverse ? -step : step), 0, 1)) || point;
    const centerX = lerp(point[0], ahead[0], .27);
    const centerY = lerp(point[1], ahead[1], .27);
    return {x: centerX - width * .48, y: centerY - height * .42, w: width, h: height};
  }

  fitImmersive(progress, {reverse = false, strong = false, practiceVisible = false, animate = true, duration = 620, geometry = this.geometry, easing} = {}) {
    const target = this.immersiveView(progress, {reverse, strong, practiceVisible, geometry});
    if (!target) return Promise.resolve(false);
    return this.setView(target, {
      animate,
      duration,
      commit: true,
      easing,
    });
  }

  bottomInset(practiceVisible) {
    if (!practiceVisible) return 0;
    const stageBox = this.stage.getBoundingClientRect();
    const panel = document.querySelector('#practicePanel.visible');
    if (!panel) return Math.min(180, stageBox.height * .32);
    const panelBox = panel.getBoundingClientRect();
    return clamp(stageBox.bottom - panelBox.top + 12, 0, stageBox.height * .72);
  }

  cancelViewAnimation() {
    this.viewAnimationToken += 1;
    cancelAnimationFrame(this.viewFrame);
    this.viewFrame = 0;
  }

  setView(target, options = {}) {
    const normalized = typeof options === 'boolean' ? {animate: options} : options;
    const {animate = false, duration = 430, easing = easeOutCubic} = normalized;
    this.cancelViewAnimation();
    const token = this.viewAnimationToken;
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (!animate || reduceMotion) {
      this.view = {...target};
      this.applyView();
      return Promise.resolve(true);
    }
    const start = {...this.view};
    const startedAt = performance.now();
    return new Promise(resolve => {
      const step = now => {
        if (token !== this.viewAnimationToken) { resolve(false); return; }
        const ratio = clamp((now - startedAt) / duration, 0, 1);
        const eased = easing(ratio);
        this.view = {
          x: lerp(start.x, target.x, eased), y: lerp(start.y, target.y, eased),
          w: lerp(start.w, target.w, eased), h: lerp(start.h, target.h, eased),
        };
        this.applyView();
        if (ratio < 1) this.viewFrame = requestAnimationFrame(step);
        else { this.viewFrame = 0; resolve(true); }
      };
      this.viewFrame = requestAnimationFrame(step);
    });
  }

  applyView() {
    this.svg.setAttribute('viewBox', `${this.view.x} ${this.view.y} ${this.view.w} ${this.view.h}`);
    const grid = this.svg.querySelector('#gridRect');
    if (grid) {
      grid.setAttribute('x', this.view.x); grid.setAttribute('y', this.view.y);
      grid.setAttribute('width', this.view.w); grid.setAttribute('height', this.view.h);
    }
    if (this.lastDynamic) this.renderDynamic(this.lastDynamic);
  }

  panByPixels(dx, dy) {
    this.cancelViewAnimation();
    const rectangle = this.stage.getBoundingClientRect();
    this.view.x -= dx / Math.max(1, rectangle.width) * this.view.w;
    this.view.y -= dy / Math.max(1, rectangle.height) * this.view.h;
    this.applyView();
  }

  zoomAt(clientX, clientY, factor) {
    this.cancelViewAnimation();
    const rectangle = this.stage.getBoundingClientRect();
    const ratioX = (clientX - rectangle.left) / Math.max(1, rectangle.width);
    const ratioY = (clientY - rectangle.top) / Math.max(1, rectangle.height);
    const point = [this.view.x + ratioX * this.view.w, this.view.y + ratioY * this.view.h];
    const width = clamp(this.view.w * factor, 100, Math.max(100, (this.geometry?.bbox[2] - this.geometry?.bbox[0]) * 5));
    const height = width * rectangle.height / Math.max(1, rectangle.width);
    this.view = {x: point[0] - ratioX * width, y: point[1] - ratioY * height, w: width, h: height};
    this.applyView();
  }

  beginManualNavigation() { this.cancelViewAnimation(); }

  endManualNavigation() {}

  showArrivalPulse(originalStationIndex) {
    if (!this.effectLayer || !this.geometry) return false;
    const point = this.geometry.stationPoints[originalStationIndex];
    if (!point) return false;
    const rectangle = this.stage.getBoundingClientRect();
    const unitPerPixel = this.view.w / Math.max(1, rectangle.width);
    const group = svgEl('g', {class: 'arrival-pulse-group', 'data-station-index': originalStationIndex});
    group.append(
      svgEl('circle', {class: 'arrival-pulse outer', cx: point[0], cy: point[1], r: 7 * unitPerPixel}),
      svgEl('circle', {class: 'arrival-pulse inner', cx: point[0], cy: point[1], r: 6 * unitPerPixel}),
      svgEl('circle', {class: 'arrival-flash', cx: point[0], cy: point[1], r: 5 * unitPerPixel}),
    );
    this.effectLayer.append(group);
    setTimeout(() => group.remove(), 1120);
    return true;
  }

  renderDynamic({currentOriginalIndex, nextOriginalIndex, reverse, typingRatio, allLabels, journeyActive = false}) {
    if (!this.route || !this.geometry) return;
    this.lastDynamic = {currentOriginalIndex, nextOriginalIndex, reverse, typingRatio, allLabels, journeyActive};
    const rectangle = this.stage.getBoundingClientRect();
    const unitPerPixel = this.view.w / Math.max(1, rectangle.width);
    const stationRadius = 4.4 * unitPerPixel;
    const currentRadius = 7.8 * unitPerPixel;
    const terminalRadius = 6.4 * unitPerPixel;
    const stateClasses = ['passed', 'current', 'next', 'future', 'terminal'];
    this.stationNodes.forEach((item, index) => {
      const visualState = stationVisualState(index, this.route.stops.length, currentOriginalIndex, nextOriginalIndex, reverse);
      const travelPhase = stationTravelPhase(index, this.route.stops.length, currentOriginalIndex, nextOriginalIndex, reverse);
      item.group.classList.remove(...stateClasses, 'muted');
      item.group.classList.add(visualState);
      item.group.classList.toggle('terminal', index === 0 || index === this.route.stops.length - 1);
      item.group.dataset.state = visualState;
      item.group.dataset.phase = travelPhase;
      const radius = visualState === 'current'
        ? currentRadius
        : (index === 0 || index === this.route.stops.length - 1) ? terminalRadius : stationRadius;
      item.circle.setAttribute('r', radius);
    });

    const startProgress = this.geometry.stationProgresses[currentOriginalIndex] ?? 0;
    const nextProgress = nextOriginalIndex == null ? startProgress : (this.geometry.stationProgresses[nextOriginalIndex] ?? startProgress);
    const actualProgress = lerp(startProgress, nextProgress, typingRatio || 0);
    this.train.dataset.motionRatio = Number(typingRatio || 0).toFixed(4);
    this.train.dataset.routeProgress = Number(actualProgress).toFixed(6);
    const traveledPath = reverse
      ? pathSlice(this.geometry.path, 1, actualProgress)
      : pathSlice(this.geometry.path, 0, actualProgress);
    this.progressPath.setAttribute('d', pathD(traveledPath));

    const point = pointAtProgress(this.geometry.path, actualProgress);
    this.train.setAttribute('transform', `translate(${point[0]} ${point[1]}) scale(${unitPerPixel * this.vehicleScale})`);
    this.vehicleFacingNode?.removeAttribute('transform');
    this.train.setAttribute('opacity', '1');

    this.labelLayer.innerHTML = '';
    const labels = layoutStationLabels({
      stops: this.route.stops,
      geometry: this.geometry,
      currentOriginalIndex,
      nextOriginalIndex,
      allLabels,
      unitPerPixel,
    });
    labels.forEach(item => {
      const visualState = stationVisualState(item.index, this.route.stops.length, currentOriginalIndex, nextOriginalIndex, reverse);
      const travelPhase = stationTravelPhase(item.index, this.route.stops.length, currentOriginalIndex, nextOriginalIndex, reverse);
      const isTerminal = item.index === 0 || item.index === this.route.stops.length - 1;
      const text = svgEl('text', {
        x: item.x, y: item.y, 'text-anchor': item.anchor,
        class: `station-label ${visualState}${isTerminal ? ' terminal' : ''}${item.index === currentOriginalIndex ? ' current' : item.priority < 50 ? ' secondary' : ''}`,
        'data-state': visualState,
        'data-phase': travelPhase,
        'font-size': (item.index === currentOriginalIndex ? 13 : item.priority < 50 ? 9.5 : 11) * unitPerPixel,
      });
      text.style.fontSize = `${(item.index === currentOriginalIndex ? 13 : item.priority < 50 ? 9.5 : 11) * unitPerPixel}px`;
      text.textContent = item.stop.name;
      this.labelLayer.append(text);
    });

    if (this.effectLayer) {
      this.effectLayer.querySelectorAll('.current-station-beacon').forEach(node => node.remove());
      const targetIndex = journeyActive && nextOriginalIndex != null ? nextOriginalIndex : currentOriginalIndex;
      const target = this.geometry.stationPoints[targetIndex];
      const stop = this.route.stops[targetIndex];
      if (target && stop) {
        const group = svgEl('g', {
          class: 'current-station-beacon',
          'data-target-index': targetIndex,
          'data-target-role': journeyActive ? 'next-station' : 'current-station',
        });
        group.append(
          svgEl('circle', {class: 'current-target-ring secondary', cx: target[0], cy: target[1], r: 14 * unitPerPixel}),
          svgEl('circle', {class: 'current-target-ring', cx: target[0], cy: target[1], r: 9 * unitPerPixel}),
          svgEl('circle', {class: 'current-target-dot', cx: target[0], cy: target[1], r: 3.3 * unitPerPixel}),
        );
        const targetLabel = svgEl('text', {
          class: 'current-target-label',
          x: target[0] + 12 * unitPerPixel,
          y: target[1] - 12 * unitPerPixel,
          'font-size': 11 * unitPerPixel,
        });
        targetLabel.textContent = journeyActive ? `下一站 · ${stop.name}` : stop.name;
        group.append(targetLabel);
        this.effectLayer.append(group);
      }
    }

    const currentNode = this.stationNodes[currentOriginalIndex]?.group;
    if (currentNode && !currentNode.querySelector('.station-ring')) {
      this.stationLayer.querySelectorAll('.station-ring').forEach(node => node.remove());
      const center = this.geometry.stationPoints[currentOriginalIndex];
      const ring = svgEl('circle', {class: 'station-ring', cx: center[0], cy: center[1], r: 8 * unitPerPixel});
      currentNode.prepend(ring);
    }
  }
}
