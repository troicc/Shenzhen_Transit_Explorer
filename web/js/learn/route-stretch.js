import {bboxOf, clamp, pathSlice, pointAtProgress} from './core.js?v=3';

export function stretchEase(value) {
  const ratio = clamp(Number(value) || 0, 0, 1);
  return ratio < .5
    ? 4 * ratio * ratio * ratio
    : 1 - Math.pow(-2 * ratio + 2, 3) / 2;
}

export function completionSpring(value) {
  const ratio = clamp(Number(value) || 0, 0, 1);
  if (ratio >= 1) return 1;
  return Math.min(1.055, Math.max(0, 1 - Math.exp(-6.5 * ratio) * Math.cos(9.2 * ratio)));
}

export function bakedScale(stretch, maximum = 2.7) {
  return 1 + (Math.max(1, Number(maximum) || 1) - 1) * stretchEase(stretch);
}

export function bakedPoint(point, center, scale) {
  return [
    center[0] + (Number(point[0]) - center[0]) * scale,
    center[1] + (Number(point[1]) - center[1]) * scale,
  ];
}

export function stretchedGeometry(source, stretch, maximum = 2.7) {
  if (!source?.path?.length) return null;
  const box = source.bbox?.length === 4 ? source.bbox.map(Number) : bboxOf(source.path);
  const center = [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2];
  const scale = bakedScale(stretch, maximum);
  const path = source.path.map(point => bakedPoint(point, center, scale));
  const stationPoints = (source.stationPoints || []).map(point => bakedPoint(point, center, scale));
  return {
    ...source,
    path,
    stationPoints,
    bbox: bboxOf(path),
    displayStretch: clamp(Number(stretch) || 0, 0, 1),
    displayScale: scale,
    displayCenter: center,
  };
}

export class RouteStretchController {
  constructor({renderer, overviewRenderer = null, maximumScale = 2.7, reducedMotion = false, requestFrame, cancelFrame, now} = {}) {
    this.renderer = renderer;
    this.overviewRenderer = overviewRenderer;
    this.maximumScale = Math.max(1, Number(maximumScale) || 1);
    this.reducedMotion = Boolean(reducedMotion);
    this.requestFrame = requestFrame || (callback => requestAnimationFrame(callback));
    this.cancelFrame = cancelFrame || (frame => cancelAnimationFrame(frame));
    this.now = now || (() => performance.now());
    this.route = null;
    this.source = null;
    this.geometry = null;
    this.progress = 0;
    this.frame = 0;
    this.token = 0;
    this.animationResolve = null;
  }

  setRoute(route, geometry) {
    this.cancel();
    this.route = route || null;
    this.source = geometry ? {
      ...geometry,
      path: geometry.path.map(point => [...point]),
      stationPoints: geometry.stationPoints.map(point => [...point]),
      stationProgresses: [...geometry.stationProgresses],
      bbox: [...geometry.bbox],
    } : null;
    this.progress = 0;
    this.apply(0);
  }

  geometryAt(value) {
    return stretchedGeometry(this.source, value, this.maximumScale);
  }

  apply(value) {
    this.progress = clamp(Number(value) || 0, 0, 1);
    this.geometry = this.geometryAt(this.progress);
    if (!this.geometry) return null;
    const vehicleScale = 1 - .18 * (1 - Math.pow(1 - this.progress, 2.4));
    this.renderer?.setDisplayGeometry?.(this.geometry, {vehicleScale});
    this.overviewRenderer?.setStretch?.(this.route?.id, this.progress, {
      center: this.geometry.displayCenter,
      scale: this.geometry.displayScale,
    });
    return this.geometry;
  }

  animateTo(target, {duration = 920, easing = stretchEase} = {}) {
    const destination = clamp(Number(target) || 0, 0, 1);
    const startValue = this.progress;
    const token = ++this.token;
    if (this.frame) this.cancelFrame(this.frame);
    this.frame = 0;
    const previousResolve = this.animationResolve;
    this.animationResolve = null;
    previousResolve?.(false);
    if (this.reducedMotion || duration <= 0 || Math.abs(destination - startValue) < 1e-6) {
      this.apply(destination);
      return Promise.resolve(true);
    }
    const startedAt = this.now();
    return new Promise(resolve => {
      this.animationResolve = resolve;
      const finish = result => {
        if (this.animationResolve === resolve) this.animationResolve = null;
        resolve(result);
      };
      const step = timestamp => {
        if (token !== this.token) { finish(false); return; }
        const ratio = clamp((timestamp - startedAt) / duration, 0, 1);
        this.apply(startValue + (destination - startValue) * easing(ratio));
        if (ratio < 1) this.frame = this.requestFrame(step);
        else {
          this.frame = 0;
          this.apply(destination);
          finish(true);
        }
      };
      this.frame = this.requestFrame(step);
    });
  }

  displayPath() { return this.geometry?.path || []; }

  stationPoint(index) { return this.geometry?.stationPoints?.[index] || null; }

  pointAtProgress(progress) {
    return this.geometry ? pointAtProgress(this.geometry.path, progress) : null;
  }

  partialPath(progress, reverse = false) {
    if (!this.geometry) return [];
    return reverse
      ? pathSlice(this.geometry.path, 1, progress)
      : pathSlice(this.geometry.path, 0, progress);
  }

  vehicleScale() { return 1 - .18 * (1 - Math.pow(1 - this.progress, 2.4)); }

  reset({duration = 0} = {}) { return this.animateTo(0, {duration}); }

  cancel() {
    this.token += 1;
    if (this.frame) this.cancelFrame(this.frame);
    this.frame = 0;
    const resolve = this.animationResolve;
    this.animationResolve = null;
    resolve?.(false);
  }

  destroy() {
    this.cancel();
    this.route = null;
    this.source = null;
    this.geometry = null;
  }
}
