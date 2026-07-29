import {bboxOf, clamp, pathD, pointSegmentDistance, svgEl} from './core.js?v=3';

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
  }) {
    this.svg = svg;
    this.stage = stage;
    this.routeLayer = routeLayer;
    this.districtLayer = districtLayer;
    this.stationLayer = stationLayer;
    this.transferLayer = transferLayer;
    this.lineStrip = lineStrip;
    this.onRouteSelect = onRouteSelect;
    this.presentation = null;
    this.routeCache = [];
    this.routeMap = new Map();
    this.view = {x: 0, y: 0, w: 1000, h: 600};
    this.homeView = {...this.view};
    this.focused = false;
    this.highlightId = null;
    this.flipped = false;
    this.drawFrame = 0;
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
    this.fitBox(unionBox(this.routeCache), .055, false);
    this.homeView = {...this.view};
  }

  fitBox(box, padding = .08, animate = false) {
    const rectangle = this.stage.getBoundingClientRect();
    const [minX, minY, maxX, maxY] = box;
    let width = Math.max(80, maxX - minX) * (1 + padding * 2);
    let height = Math.max(80, maxY - minY) * (1 + padding * 2);
    const aspect = rectangle.width / Math.max(1, rectangle.height);
    if (width / height < aspect) width = height * aspect;
    else height = width / aspect;
    const target = {x: (minX + maxX - width) / 2, y: (minY + maxY - height) / 2, w: width, h: height};
    this.setView(target, {animate});
  }

  getView() { return {...this.view}; }

  setView(view) {
    this.view = {...view};
    this.applyView();
  }

  applyView() {
    this.svg.setAttribute('viewBox', `${this.view.x} ${this.view.y} ${this.view.w} ${this.view.h}`);
    const grid = this.svg.querySelector('#gridRect');
    if (grid) {
      grid.setAttribute('x', this.view.x);
      grid.setAttribute('y', this.view.y);
      grid.setAttribute('width', this.view.w);
      grid.setAttribute('height', this.view.h);
    }
  }

  resize() {
    if (!this.presentation || this.focused) return;
    const rectangle = this.stage.getBoundingClientRect();
    const centerX = this.view.x + this.view.w / 2;
    const centerY = this.view.y + this.view.h / 2;
    const height = this.view.w * rectangle.height / Math.max(1, rectangle.width);
    this.view = {x: centerX - this.view.w / 2, y: centerY - height / 2, w: this.view.w, h: height};
    this.homeView = {...this.view};
    this.applyView();
    this.updateVisualScale();
  }

  panByPixels(dx, dy) {
    const rectangle = this.stage.getBoundingClientRect();
    this.view.x -= dx / Math.max(1, rectangle.width) * this.view.w;
    this.view.y -= dy / Math.max(1, rectangle.height) * this.view.h;
    this.applyView();
  }

  zoomAt(clientX, clientY, factor) {
    if (!this.presentation) return;
    const rectangle = this.stage.getBoundingClientRect();
    const point = this.worldFromClient(clientX, clientY);
    const fullWidth = this.homeView.w || this.presentation.world?.width || 10000;
    const width = clamp(this.view.w * factor, 100, fullWidth * 3);
    const height = width * rectangle.height / Math.max(1, rectangle.width);
    const ratioX = (clientX - rectangle.left) / Math.max(1, rectangle.width);
    const rawY = (clientY - rectangle.top) / Math.max(1, rectangle.height);
    const ratioY = this.flipped ? 1 - rawY : rawY;
    this.view = {x: point[0] - ratioX * width, y: point[1] - ratioY * height, w: width, h: height};
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
    this.routeLayer.replaceChildren();
    this.stationLayer.replaceChildren();
    this.transferLayer.replaceChildren();
    this.districtLayer.replaceChildren();
  }
}
