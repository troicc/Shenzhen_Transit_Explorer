(() => {
  const Z = window.TransitPublic;

  class FlatRasterRenderer {
    constructor(svg, viewport, onStationSelect) {
      this.svg = svg;
      this.viewport = viewport;
      this.onStationSelect = onStationSelect;
      this.viewportLayer = document.querySelector('#viewportLayer');
      this.stationLayer = document.querySelector('#stationLayer');
      this.labelLayer = document.querySelector('#labelLayer');
      this.train = document.querySelector('#train');
      this.vectorNodes = ['#routeShadow', '#routeBase', '#routeColor', '#routeProgress']
        .map(selector => document.querySelector(selector));
      this.baseImage = Z.svgEl('image', {class: 'protected-route-raster'});
      this.progressLayer = Z.svgEl('g', {class: 'protected-progress-layer'});
      this.effectLayer = Z.svgEl('g', {class: 'protected-effect-layer'});
      this.viewportLayer.insertBefore(this.baseImage, this.vectorNodes[0]);
      this.viewportLayer.insertBefore(this.progressLayer, this.stationLayer);
      this.viewportLayer.append(this.effectLayer);
      this.vectorNodes.forEach(node => {
        node.removeAttribute('d');
        node.setAttribute('display', 'none');
      });
      this.line = null;
      this.currentOriginalIndex = 0;
      this.showAllLabels = false;
    }

    setLine(line) {
      this.line = line;
      this.currentOriginalIndex = 0;
      document.documentElement.style.setProperty('--line', line.color || '#5cc8ff');
      const viewport = line.viewport || {width: 1280, height: 720};
      const levels = line.raster?.levels || [];
      const target = Math.max(1, Math.min(4, Math.ceil(window.devicePixelRatio || 1)));
      const level = levels.find(item => Number(item.scale) >= target) || levels.at(-1);
      if (!level) throw new Error('当前线路缺少保护性栅格资源');
      this.baseImage.setAttribute('href', level.url);
      this.baseImage.setAttribute('x', '0');
      this.baseImage.setAttribute('y', '0');
      this.baseImage.setAttribute('width', String(viewport.width));
      this.baseImage.setAttribute('height', String(viewport.height));
      this.progressLayer.innerHTML = '';
      this.effectLayer.innerHTML = '';
      this.stationLayer.innerHTML = '';
      line.stations.forEach((station, index) => {
        const [x, y] = station.anchor;
        const group = Z.svgEl('g', {
          class: `station${station.transfer ? ' transfer' : ''}`,
          'data-index': index,
          role: 'button',
          tabindex: '0',
          'aria-label': `${station.name}，第 ${index + 1} 站`,
        });
        group.append(Z.svgEl('circle', {class: 'station-hit', cx: x, cy: y, r: 15}));
        group.append(Z.svgEl('circle', {class: 'station-core', cx: x, cy: y, r: station.transfer ? 6 : 4.5}));
        const select = () => this.onStationSelect?.(index);
        group.addEventListener('click', select);
        group.addEventListener('keydown', event => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            select();
          }
        });
        this.stationLayer.append(group);
      });
      this.fit(false);
      this.render(0, 1, false);
    }

    fit(practice = false) {
      if (!this.line) return;
      const {width, height} = this.line.viewport;
      const extra = practice ? height * .08 : 0;
      this.viewport.set({x: 0, y: -extra, w: width, h: height + extra});
    }

    getView() { return {...this.viewport.view}; }

    setView(view) { this.viewport.set(view); }

    getRouteBounds() {
      if (!this.line) return null;
      return [0, 0, this.line.viewport.width, this.line.viewport.height];
    }

    pointAtProgress(progress) {
      if (!this.line?.stations?.length) return null;
      const ratio = Z.clamp(Number(progress) || 0, 0, 1);
      const stations = this.line.stations;
      let nextIndex = stations.findIndex(station => Number(station.progress) >= ratio);
      if (nextIndex < 0) nextIndex = stations.length - 1;
      const previousIndex = Math.max(0, nextIndex - 1);
      const previous = stations[previousIndex];
      const next = stations[nextIndex];
      if (!previous?.anchor || !next?.anchor) return previous?.anchor || next?.anchor || null;
      const start = Number(previous.progress) || 0;
      const end = Number(next.progress) || start;
      const local = end > start ? Z.clamp((ratio - start) / (end - start), 0, 1) : 0;
      return [
        previous.anchor[0] + (next.anchor[0] - previous.anchor[0]) * local,
        previous.anchor[1] + (next.anchor[1] - previous.anchor[1]) * local,
      ];
    }

    pointAhead(progress, reverse = false) {
      return this.pointAtProgress(Z.clamp(progress + (reverse ? -.035 : .035), 0, 1));
    }

    fitFullRoute({practiceVisible = false} = {}) { this.fit(practiceVisible); }

    fitImmersive(progress, {reverse = false, strong = false, practiceVisible = false} = {}) {
      if (!this.line) return;
      const point = this.pointAtProgress(progress);
      const ahead = this.pointAhead(progress, reverse) || point;
      if (!point) return;
      const rect = this.svg.getBoundingClientRect();
      const aspect = rect.width / Math.max(1, rect.height);
      const factor = strong ? .54 : .68;
      const width = Math.max(240, this.line.viewport.width * factor);
      const height = width / Math.max(.45, aspect);
      const x = point[0] * .7 + ahead[0] * .3 - width * .48;
      const y = point[1] * .7 + ahead[1] * .3 - height * (practiceVisible ? .39 : .44);
      this.viewport.set({x, y, w: width, h: height});
    }

    followJourney(progress, reverse = false) {
      const point = this.pointAtProgress(progress);
      const ahead = this.pointAhead(progress, reverse) || point;
      const view = this.viewport.view;
      if (!point || !view) return;
      const u = (point[0] - view.x) / Math.max(1, view.w);
      const v = (point[1] - view.y) / Math.max(1, view.h);
      if (Math.abs(u - .48) <= .19 && Math.abs(v - .42) <= .16) return;
      const lookX = point[0] * .7 + ahead[0] * .3;
      const lookY = point[1] * .7 + ahead[1] * .3;
      this.viewport.set({...view, x: lookX - view.w * .48, y: lookY - view.h * .42});
    }

    showArrivalPulse(originalIndex) {
      const anchor = this.line?.stations?.[originalIndex]?.anchor;
      if (!anchor) return false;
      const group = Z.svgEl('g', {class: 'arrival-pulse-group'});
      group.append(
        Z.svgEl('circle', {class: 'arrival-pulse outer', cx: anchor[0], cy: anchor[1], r: 8}),
        Z.svgEl('circle', {class: 'arrival-pulse inner', cx: anchor[0], cy: anchor[1], r: 6}),
        Z.svgEl('circle', {class: 'arrival-flash', cx: anchor[0], cy: anchor[1], r: 5}),
      );
      this.effectLayer.append(group);
      setTimeout(() => group.remove(), 1100);
      return true;
    }

    beginManualNavigation() {}
    endManualNavigation() {}

    locate(originalIndex) {
      const station = this.line?.stations?.[originalIndex];
      if (!station) return;
      const [x, y] = station.anchor;
      const rect = this.svg.getBoundingClientRect();
      const aspect = rect.width / Math.max(1, rect.height);
      const width = Math.min(this.viewport.view.w, 500);
      const height = width / Math.max(.45, aspect);
      this.viewport.set({x: x - width / 2, y: y - height / 2, w: width, h: height});
    }

    setLabels(visible) {
      this.showAllLabels = visible;
      this.renderLabels(this.currentOriginalIndex);
    }

    renderLabels(currentOriginalIndex) {
      if (!this.line) return;
      this.labelLayer.innerHTML = '';
      this.line.stations.forEach((station, index) => {
        const isCurrent = index === currentOriginalIndex;
        const isTerminal = index === 0 || index === this.line.stations.length - 1;
        if (!this.showAllLabels && !isCurrent && !isTerminal) return;
        const [x, y] = station.anchor;
        const label = Z.svgEl('text', {
          x: x + (isCurrent ? 12 : 8),
          y: y + (index % 2 === 0 ? -10 : 16),
          class: `station-label${isCurrent ? ' current' : ''}`,
        });
        label.textContent = station.name;
        this.labelLayer.append(label);
      });
    }

    completedSegment(segment) {
      if (segment.strategy === 'quantized-anchor-motion') {
        const start = this.line.stations[segment.from]?.anchor;
        const end = this.line.stations[segment.to]?.anchor;
        if (!start || !end) return;
        this.progressLayer.append(Z.svgEl('line', {
          x1: start[0], y1: start[1], x2: end[0], y2: end[1],
          stroke: this.line.color || '#5cc8ff', 'stroke-width': 10,
          'stroke-linecap': 'round', class: 'completed-coarse-segment',
        }));
        return;
      }
      const image = Z.svgEl('image', {
        href: segment.completedUrl,
        x: segment.origin[0],
        y: segment.origin[1],
        width: segment.size[0],
        height: segment.size[1],
        class: 'completed-raster-segment',
      });
      this.progressLayer.append(image);
    }

    currentAtlas(segment, fraction, reverse) {
      if (segment.strategy === 'quantized-anchor-motion') {
        const from = this.line.stations[reverse ? segment.to : segment.from]?.anchor;
        const to = this.line.stations[reverse ? segment.from : segment.to]?.anchor;
        if (!from || !to) return false;
        const ratio = Z.clamp(fraction, 0, 1);
        const point = [from[0] + (to[0] - from[0]) * ratio, from[1] + (to[1] - from[1]) * ratio];
        this.progressLayer.append(Z.svgEl('line', {
          x1: from[0], y1: from[1], x2: point[0], y2: point[1],
          stroke: this.line.color || '#5cc8ff', 'stroke-width': 10,
          'stroke-linecap': 'round', class: 'active-coarse-segment',
        }));
        this.train.setAttribute('transform', `translate(${point[0]} ${point[1]})`);
        this.train.setAttribute('opacity', '1');
        return true;
      }
      const frame = Math.round(Z.clamp(fraction, 0, 1) * (segment.frameCount - 1));
      const column = frame % segment.columns;
      const row = Math.floor(frame / segment.columns);
      const [width, height] = segment.size;
      const cell = Z.svgEl('svg', {
        x: segment.origin[0], y: segment.origin[1], width, height,
        viewBox: `${column * width} ${row * height} ${width} ${height}`,
        preserveAspectRatio: 'none', class: 'active-raster-segment',
      });
      const rows = Math.ceil(segment.frameCount / segment.columns);
      cell.append(Z.svgEl('image', {
        href: segment.atlasUrls[reverse ? 'reverse' : 'forward'],
        x: 0, y: 0, width: width * segment.columns, height: height * rows,
      }));
      this.progressLayer.append(cell);
      return false;
    }

    render(displayIndex, fraction = 1, reverse = false) {
      if (!this.line) return;
      const count = this.line.stations.length;
      const current = Z.clamp(displayIndex, 0, count - 1);
      const originalCurrent = reverse ? count - 1 - current : current;
      this.progressLayer.innerHTML = '';
      const segmentIndex = reverse ? originalCurrent : originalCurrent - 1;
      const active = this.line.segments[segmentIndex];
      const moving = current > 0 && active && fraction < 1;
      this.line.segments.forEach((segment, index) => {
        const complete = Z.isCompletedSegment(index, originalCurrent, moving, reverse);
        if (complete) this.completedSegment(segment);
      });
      const coarseVehicle = moving ? this.currentAtlas(active, fraction, reverse) : false;
      const station = this.line.stations[originalCurrent];
      if (station && !moving) {
        this.train.setAttribute('transform', `translate(${station.anchor[0]} ${station.anchor[1]})`);
        this.train.setAttribute('opacity', '1');
      } else if (!coarseVehicle) {
        this.train.setAttribute('opacity', '0');
      }
      this.stationLayer.querySelectorAll('.station').forEach((node, index) => {
        node.classList.toggle('current', index === originalCurrent);
      });
      this.currentOriginalIndex = originalCurrent;
      this.renderLabels(originalCurrent);
    }
  }

  Z.FlatRasterRenderer = FlatRasterRenderer;
  Z.RouteRenderer = FlatRasterRenderer;
})();
