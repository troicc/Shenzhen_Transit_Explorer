import {bboxOf, clamp, pathD, pointSegmentDistance, svgEl} from './core.js?v=3';
import {preserveOverviewZoom} from './view-progress.js';

function unionBox(routes) {
  const points = routes.flatMap(route => route.path || []);
  return points.length ? bboxOf(points) : [0, 0, 1000, 600];
}

export class MetroSchematicOverviewRenderer {
  constructor({
    svg,
    stage,
    routeLayer,
    districtLayer,
    stationLayer,
    transferLayer,
    lineStrip,
    onRouteSelect,
    onViewChange = () => {},
  }) {
    this.svg = svg;
    this.stage = stage;
    this.routeLayer = routeLayer;
    this.districtLayer = districtLayer;
    this.stationLayer = stationLayer;
    this.transferLayer = transferLayer;
    this.lineStrip = lineStrip;
    this.onRouteSelect = onRouteSelect;
    this.onViewChange = onViewChange;
    this.presentation = null;
    this.routeCache = [];
    this.routeMap = new Map();
    this.view = {x: 0, y: 0, w: 1000, h: 600};
    this.homeView = {...this.view};
    this.focused = false;
    this.highlightId = null;
    this.flipped = false;
    this.drawFrame = 0;
    this.mapFlipStage = this.svg.querySelector('#mapFlipStage');
    this.committedView = {...this.view};
    this.navigationActive = false;
    this.navigationMetrics = null;
  }

  setData(presentation) {
    this.presentation = presentation;
    this.routeCache = (presentation.routes || []).map(route => ({
      ...route,
      path: (route.path || []).map(point => [Number(point[0]), Number(point[1])]),
    }));
    this.routeMap = new Map(this.routeCache.map(route => [route.id, route]));
    this.fitHome();
    this.renderDistricts();
    this.renderRoutes();
    this.renderStations();
    this.renderTransfers();
    this.renderLineStrip();
    this.updateVisualScale();
  }

  visualUnit() {
    const rectangle = this.stage.getBoundingClientRect();
    if (rectangle.width > 0 && this.view.w > 0) return this.view.w / rectangle.width;
    return Math.max(
      Number(this.presentation?.world?.width || 1000) / 1300,
      Number(this.presentation?.world?.height || 600) / 720,
    );
  }

  updateVisualScale() {
    const unit = this.visualUnit();
    this.districtLayer.querySelectorAll('[data-base-font-size]').forEach(node => {
      node.style.fontSize = `${Number(node.dataset.baseFontSize) * unit}px`;
    });
    this.stationLayer.querySelectorAll('[data-base-r]').forEach(node => {
      node.setAttribute('r', Number(node.dataset.baseR) * unit);
    });
    this.transferLayer.querySelectorAll('[data-base-r]').forEach(node => {
      node.setAttribute('r', Number(node.dataset.baseR) * unit);
    });
    this.transferLayer.querySelectorAll('.metro-transfer-name').forEach(node => {
      node.setAttribute('x', 11 * unit);
      node.setAttribute('y', -8 * unit);
      node.style.fontSize = `${10 * unit}px`;
      node.style.strokeWidth = `${4 * unit}px`;
    });
  }

  resolveRouteId(routeId) {
    if (this.routeMap.has(routeId)) return routeId;
    const directions = this.presentation?.directions || {};
    for (const [logicalId, values] of Object.entries(directions)) {
      if (Object.values(values || {}).includes(routeId)) {
        return this.routeCache.find(route => route.logical_id === logicalId)?.id || null;
      }
    }
    return null;
  }

  renderDistricts() {
    this.districtLayer.replaceChildren();
    (this.presentation?.regions || []).forEach(region => {
      const text = svgEl('text', {
        class: region.kind === 'water' ? 'metro-water-label' : 'metro-district',
        x: region.x,
        y: region.y,
        'data-base-x': region.x,
        'data-base-y': region.y,
        'data-base-font-size': region.kind === 'water' ? 17 : 30,
      });
      text.textContent = region.name;
      this.districtLayer.append(text);
    });
  }

  renderRoutes() {
    this.routeLayer.replaceChildren();
    this.routeCache.forEach(route => {
      const data = pathD(route.path);
      const group = svgEl('g', {class: 'metro-overview-route', 'data-route-id': route.id});
      group.style.setProperty('--metro-line-color', route.color || '#5cc8ff');
      group.append(
        svgEl('path', {class: 'metro-overview-casing', d: data}),
        svgEl('path', {class: 'metro-overview-color', d: data, stroke: route.color || '#5cc8ff'}),
        svgEl('path', {class: 'metro-overview-hit', d: data, 'data-route-id': route.id}),
      );
      this.routeLayer.append(group);
      route.group = group;
    });
  }

  renderStations() {
    this.stationLayer.replaceChildren();
    const seen = new Set();
    this.routeCache.forEach(route => {
      (route.stops || []).forEach((stop, index) => {
        if (stop.transfer || seen.has(stop.name)) return;
        const point = route.station_points?.[index];
        if (!point) return;
        seen.add(stop.name);
        const node = svgEl('circle', {
          class: 'metro-overview-station',
          cx: point[0], cy: point[1], r: 3, 'data-base-r': 3,
          'data-name': stop.name,
        });
        this.stationLayer.append(node);
      });
    });
  }

  renderTransfers() {
    this.transferLayer.replaceChildren();
    const anchors = this.presentation?.transfer_anchors || {};
    Object.entries(anchors).forEach(([key, anchor]) => {
      const count = Math.max(1, anchor.lines?.length || 0);
      if (count < 2 || !Number.isFinite(Number(anchor.x)) || !Number.isFinite(Number(anchor.y))) return;
      const group = svgEl('g', {
        class: 'metro-overview-transfer',
        'data-anchor-key': key,
        transform: `translate(${anchor.x} ${anchor.y})`,
      });
      group.append(
        svgEl('circle', {class: 'metro-transfer-shell', r: 8.5, 'data-base-r': 8.5}),
        svgEl('circle', {class: 'metro-transfer-core', r: 4.4, 'data-base-r': 4.4}),
      );
      const label = svgEl('text', {class: 'metro-transfer-name', x: 11, y: -8});
      label.textContent = anchor.name || key;
      group.append(label);
      this.transferLayer.append(group);
    });
  }

  renderLineStrip() {
    if (!this.lineStrip) return;
    this.lineStrip.replaceChildren();
    this.routeCache.forEach(route => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'metro-line-chip';
      button.dataset.routeId = route.id;
      const dot = document.createElement('span');
      dot.style.background = route.color || '#5cc8ff';
      const label = document.createElement('b');
      label.textContent = route.short_name || route.route_no;
      button.append(dot, label);
      button.addEventListener('click', event => {
        event.stopPropagation();
        this.onRouteSelect?.(route.id);
      });
      this.lineStrip.append(button);
    });
  }

  setFocused(focused, routeId = null) {
    this.focused = Boolean(focused);
    this.highlightId = this.resolveRouteId(routeId);
    this.routeCache.forEach(route => {
      const selected = this.highlightId === route.id;
      route.group?.classList.toggle('is-selected', this.focused && selected);
      route.group?.classList.toggle('is-muted', this.focused && !selected);
    });
    this.lineStrip?.querySelectorAll('[data-route-id]').forEach(button => {
      button.classList.toggle('active', this.highlightId === button.dataset.routeId);
    });
    this.svg.classList.toggle('metro-route-focused', this.focused);
    this.notifyViewChange();
  }

  setFlipped(flipped) {
    this.flipped = Boolean(flipped);
    this.svg.dataset.coverFlipped = String(this.flipped);
  }

  setStretch(routeId, stretch, {center, scale} = {}) {
    const active = this.resolveRouteId(routeId) === this.highlightId && this.focused;
    const ratio = active ? clamp(Number(stretch) || 0, 0, 1) : 0;
    this.svg.dataset.routeStretch = ratio.toFixed(4);
    this.districtLayer.querySelectorAll('[data-base-x][data-base-y]').forEach(node => {
      const x = Number(node.dataset.baseX);
      const y = Number(node.dataset.baseY);
      const nextX = active ? center[0] + (x - center[0]) * scale : x;
      const nextY = active ? center[1] + (y - center[1]) * scale : y;
      node.setAttribute('x', nextX);
      node.setAttribute('y', nextY);
    });
  }

  fitHome() {
    if (!this.presentation) return;
    const target = this.viewForBox(unionBox(this.routeCache), .055);
    this.homeView = {...target};
    this.view = {...target};
    this.configureGridBounds();
    this.applyView();
  }

  configureGridBounds() {
    const grid = this.svg.querySelector('#gridRect');
    if (!grid) return;
    const width = Math.max(1000, this.homeView.w);
    const height = Math.max(600, this.homeView.h);
    const centerX = this.homeView.x + this.homeView.w / 2;
    const centerY = this.homeView.y + this.homeView.h / 2;
    grid.setAttribute('x', centerX - width * 12);
    grid.setAttribute('y', centerY - height * 12);
    grid.setAttribute('width', width * 24);
    grid.setAttribute('height', height * 24);
  }

  viewForBox(box, padding = .08) {
    const rectangle = this.stage.getBoundingClientRect();
    const [minX, minY, maxX, maxY] = box;
    let width = Math.max(80, maxX - minX) * (1 + padding * 2);
    let height = Math.max(80, maxY - minY) * (1 + padding * 2);
    const aspect = rectangle.width / Math.max(1, rectangle.height);
    if (width / height < aspect) width = height * aspect;
    else height = width / aspect;
    return {x: (minX + maxX - width) / 2, y: (minY + maxY - height) / 2, w: width, h: height};
  }

  fitBox(box, padding = .08, animate = false) {
    const target = this.viewForBox(box, padding);
    this.setView(target, {animate});
  }

  getView() { return {...this.view}; }

  setView(view) {
    this.view = {...view};
    this.applyView();
  }

  applyView() {
    if (this.navigationActive) {
      this.applyPreviewView();
      return;
    }
    this.commitView();
  }

  applyPreviewView() {
    const base = this.committedView;
    const view = this.view;
    const scaleX = base.w / Math.max(.0001, view.w);
    const scaleY = base.h / Math.max(.0001, view.h);
    const translateX = base.x - view.x * scaleX;
    const translateY = base.y - view.y * scaleY;
    const unchanged = Math.abs(scaleX - 1) < 1e-6
      && Math.abs(scaleY - 1) < 1e-6
      && Math.abs(translateX) < 1e-5
      && Math.abs(translateY) < 1e-5;
    if (unchanged) this.mapFlipStage?.removeAttribute('transform');
    else {
      this.mapFlipStage?.setAttribute(
        'transform',
        `matrix(${scaleX} 0 0 ${scaleY} ${translateX} ${translateY})`,
      );
    }
    this.notifyViewChange();
  }

  commitView() {
    this.svg.setAttribute('viewBox', `${this.view.x} ${this.view.y} ${this.view.w} ${this.view.h}`);
    this.committedView = {...this.view};
    this.mapFlipStage?.removeAttribute('transform');
    this.notifyViewChange();
  }

  notifyViewChange() {
    this.onViewChange({
      view: {...this.view},
      homeView: {...this.homeView},
      zoomRatio: this.homeView.w / Math.max(.0001, this.view.w),
      focused: this.focused,
    });
  }

  resize() {
    if (!this.presentation) return;
    const rectangle = this.stage.getBoundingClientRect();
    const previousView = {...this.view};
    const previousHome = {...this.homeView};
    const nextHome = this.viewForBox(unionBox(this.routeCache), .055);
    this.homeView = {...nextHome};
    if (this.focused) {
      this.notifyViewChange();
      return;
    }
    this.view = preserveOverviewZoom(
      previousView,
      previousHome,
      nextHome,
      rectangle.width / Math.max(1, rectangle.height),
    );
    this.applyView();
    this.updateVisualScale();
  }

  beginManualNavigation(source, metrics) {
    if (this.navigationActive) return;
    this.navigationActive = true;
    this.navigationMetrics = {
      left: Number(metrics?.left) || 0,
      top: Number(metrics?.top) || 0,
      width: Math.max(1, Number(metrics?.width) || 0),
      height: Math.max(1, Number(metrics?.height) || 0),
    };
  }

  endManualNavigation() {
    if (!this.navigationActive) return;
    this.navigationActive = false;
    this.commitView();
    this.navigationMetrics = null;
  }

  panByPixels(dx, dy, metrics = null) {
    const rectangle = this.navigationMetrics || metrics || this.stage.getBoundingClientRect();
    this.view.x -= dx / Math.max(1, rectangle.width) * this.view.w;
    this.view.y -= dy / Math.max(1, rectangle.height) * this.view.h;
    this.applyView();
  }

  zoomAt(clientX, clientY, factor) {
    if (!this.presentation) return;
    const rectangle = this.stage.getBoundingClientRect();
    const ratioX = clamp((clientX - rectangle.left) / Math.max(1, rectangle.width), 0, 1);
    const rawY = clamp((clientY - rectangle.top) / Math.max(1, rectangle.height), 0, 1);
    const ratioY = this.flipped ? 1 - rawY : rawY;
    this.zoomAtNormalized(ratioX, ratioY, factor, rectangle);
  }

  zoomAtNormalized(ratioX, ratioY, factor, metrics = null) {
    if (!this.presentation) return;
    const rectangle = this.navigationMetrics || metrics || this.stage.getBoundingClientRect();
    const ux = clamp(Number(ratioX) || 0, 0, 1);
    const uy = clamp(Number(ratioY) || 0, 0, 1);
    const point = [this.view.x + ux * this.view.w, this.view.y + uy * this.view.h];
    const fullWidth = this.homeView.w || this.presentation.world?.width || 10000;
    const width = clamp(this.view.w * factor, 100, fullWidth * 3);
    const height = width * rectangle.height / Math.max(1, rectangle.width);
    this.view = {x: point[0] - ux * width, y: point[1] - uy * height, w: width, h: height};
    this.applyView();
  }

  worldFromClient(clientX, clientY) {
    const rectangle = this.stage.getBoundingClientRect();
    const ratioX = (clientX - rectangle.left) / Math.max(1, rectangle.width);
    const rawY = (clientY - rectangle.top) / Math.max(1, rectangle.height);
    const ratioY = this.flipped ? 1 - rawY : rawY;
    return [this.view.x + ratioX * this.view.w, this.view.y + ratioY * this.view.h];
  }

  nearestRoute(clientX, clientY) {
    if (!this.presentation || this.focused) return null;
    const point = this.worldFromClient(clientX, clientY);
    const rectangle = this.stage.getBoundingClientRect();
    const threshold = this.view.w / Math.max(1, rectangle.width) * 12;
    let best = null;
    let bestDistance = threshold;
    this.routeCache.forEach(route => {
      for (let index = 1; index < route.path.length; index += 1) {
        const value = pointSegmentDistance(point, route.path[index - 1], route.path[index]);
        if (value < bestDistance) { bestDistance = value; best = route; }
      }
    });
    return best;
  }

  draw() { this.applyView(); }

  destroy() {
    if (this.drawFrame) cancelAnimationFrame(this.drawFrame);
    this.mapFlipStage?.removeAttribute('transform');
    this.routeLayer.replaceChildren();
    this.stationLayer.replaceChildren();
    this.transferLayer.replaceChildren();
    this.districtLayer.replaceChildren();
  }
}
