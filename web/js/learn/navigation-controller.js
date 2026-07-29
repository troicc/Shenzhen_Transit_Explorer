import {normalizeWheelInput, safariGestureZoomFactor} from './input-normalizer.js';

const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));

export class NavigationController {
  constructor({
    target,
    renderer,
    enabled = () => true,
    isFlipped = () => false,
    onTap = () => {},
    onBackgroundDoubleClick = () => {},
    isInteractiveTarget = () => false,
    onInteractionStart = () => {},
    onInteractionEnd = () => {},
    requestFrame = callback => requestAnimationFrame(callback),
    cancelFrame = frame => cancelAnimationFrame(frame),
    setTimer = (callback, delay) => setTimeout(callback, delay),
    clearTimer = timer => clearTimeout(timer),
    now = () => globalThis.performance?.now?.() ?? Date.now(),
  } = {}) {
    this.target = target;
    this.renderer = renderer;
    this.enabled = enabled;
    this.isFlipped = isFlipped;
    this.onTap = onTap;
    this.onBackgroundDoubleClick = onBackgroundDoubleClick;
    this.isInteractiveTarget = isInteractiveTarget;
    this.onInteractionStart = onInteractionStart;
    this.onInteractionEnd = onInteractionEnd;
    this.requestFrame = requestFrame;
    this.cancelFrame = cancelFrame;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.now = now;
    this.active = false;
    this.source = null;
    this.endTimer = 0;
    this.interactionMetrics = null;
    this.lastWheelAt = 0;
    this.wheelEndDelay = 0;
    this.pointer = null;
    this.wheelFrame = 0;
    this.wheelPanX = 0;
    this.wheelPanY = 0;
    this.wheelZoomDelta = 0;
    this.wheelAnchor = [.5, .5];
    this.gesture = null;
    this.gestureFrame = 0;
    this.handlers = {
      pointerdown: event => this.handlePointerDown(event),
      pointermove: event => this.handlePointerMove(event),
      pointerup: event => this.handlePointerEnd(event),
      pointercancel: event => this.handlePointerEnd(event, true),
      dblclick: event => this.handleDoubleClick(event),
      wheel: event => this.handleWheel(event),
      gesturestart: event => this.handleGestureStart(event),
      gesturechange: event => this.handleGestureChange(event),
      gestureend: event => this.handleGestureEnd(event),
    };
    this.attach();
  }

  adapter() {
    return typeof this.renderer === 'function' ? this.renderer() : this.renderer;
  }

  attach() {
    if (!this.target?.addEventListener) return;
    for (const [type, handler] of Object.entries(this.handlers)) {
      this.target.addEventListener(type, handler, type === 'wheel' || type.startsWith('gesture') ? {passive: false} : undefined);
    }
  }

  begin(source) {
    if (this.active) {
      if (this.source === source) return;
      if (this.endTimer) this.clearTimer(this.endTimer);
      this.endTimer = 0;
      this.source = source;
      return;
    }
    const rectangle = this.target?.getBoundingClientRect?.() || {};
    this.interactionMetrics = {
      left: Number(rectangle.left) || 0,
      top: Number(rectangle.top) || 0,
      width: Math.max(1, Number(rectangle.width) || 0),
      height: Math.max(1, Number(rectangle.height) || 0),
    };
    if (this.endTimer) this.clearTimer(this.endTimer);
    this.endTimer = 0;
    this.active = true;
    this.source = source;
    this.adapter()?.beginManualNavigation?.(source, this.interactionMetrics);
    this.onInteractionStart(source);
  }

  scheduleEnd(delay = 90) {
    if (this.endTimer) this.clearTimer(this.endTimer);
    this.endTimer = this.setTimer(() => this.finish(), delay);
  }

  markWheelActivity(delay = 150) {
    this.lastWheelAt = this.now();
    this.wheelEndDelay = delay;
    if (this.endTimer) return;
    const check = () => {
      this.endTimer = 0;
      if (!this.active || this.source !== 'wheel') return;
      const remaining = this.wheelEndDelay - (this.now() - this.lastWheelAt);
      if (remaining > 1) {
        this.endTimer = this.setTimer(check, remaining);
        return;
      }
      this.finish();
    };
    this.endTimer = this.setTimer(check, delay);
  }

  finish() {
    if (this.endTimer) this.clearTimer(this.endTimer);
    this.endTimer = 0;
    if (!this.active) return;
    const source = this.source;
    if (source === 'wheel' && this.wheelFrame) {
      this.cancelFrame(this.wheelFrame);
      this.wheelFrame = 0;
      this.flushWheel();
    }
    this.active = false;
    this.source = null;
    this.adapter()?.endManualNavigation?.();
    this.interactionMetrics = null;
    this.lastWheelAt = 0;
    this.wheelEndDelay = 0;
    this.onInteractionEnd(source);
  }

  screenPan(dx, dy) {
    const adjustedY = this.isFlipped() ? -dy : dy;
    this.adapter()?.panByPixels?.(dx || 0, adjustedY || 0, this.interactionMetrics);
  }

  handlePointerDown(event) {
    if (!this.enabled() || event?.button !== 0 || !this.adapter()) return;
    this.pointer = {
      id: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
      moved: false,
    };
  }

  handlePointerMove(event) {
    const pointer = this.pointer;
    if (!pointer || (pointer.id != null && event.pointerId !== pointer.id)) return;
    const total = Math.abs(event.clientX - pointer.startX) + Math.abs(event.clientY - pointer.startY);
    if (!pointer.moved && total <= 3) return;
    if (!pointer.moved) {
      pointer.moved = true;
      this.target?.setPointerCapture?.(event.pointerId);
      this.begin('pointer');
    }
    const dx = event.clientX - pointer.lastX;
    const dy = event.clientY - pointer.lastY;
    pointer.lastX = event.clientX;
    pointer.lastY = event.clientY;
    this.screenPan(dx, dy);
  }

  handlePointerEnd(event, cancelled = false) {
    const pointer = this.pointer;
    if (!pointer || (pointer.id != null && event?.pointerId !== pointer.id)) return;
    this.pointer = null;
    if (pointer.moved) this.scheduleEnd(80);
    else if (!cancelled) this.onTap(event);
  }

  handleDoubleClick(event) {
    if (!this.enabled() || !this.adapter()) return;
    if (this.pointer?.moved || this.isInteractiveTarget(event?.target)) return;
    event?.preventDefault?.();
    event?.stopPropagation?.();
    this.cancelActiveInteraction();
    this.onBackgroundDoubleClick(event);
  }

  resetWheel() {
    this.wheelPanX = 0;
    this.wheelPanY = 0;
    this.wheelZoomDelta = 0;
  }

  queueWheelFrame() {
    if (this.wheelFrame) return;
    this.wheelFrame = this.requestFrame(() => this.flushWheel());
  }

  flushWheel() {
    this.wheelFrame = 0;
    const panX = this.wheelPanX;
    const panY = this.wheelPanY;
    const zoomDelta = clamp(this.wheelZoomDelta, -46, 46);
    const anchor = this.wheelAnchor;
    this.resetWheel();
    if (panX || panY) this.screenPan(-panX, -panY);
    if (zoomDelta) {
      const factor = clamp(Math.exp(zoomDelta * .0085), .74, 1.35);
      this.zoomAtNormalized(anchor[0], anchor[1], factor);
    }
  }

  normalizedAnchor(event, {centerOnZero = false} = {}) {
    const metrics = this.interactionMetrics || {left: 0, top: 0, width: 1, height: 1};
    const hasCoordinates = Number.isFinite(event?.clientX)
      && Number.isFinite(event?.clientY)
      && (!centerOnZero || event.clientX !== 0 || event.clientY !== 0);
    const clientX = hasCoordinates ? event.clientX : metrics.left + metrics.width / 2;
    const clientY = hasCoordinates ? event.clientY : metrics.top + metrics.height / 2;
    const ux = clamp((clientX - metrics.left) / metrics.width, 0, 1);
    const rawUy = clamp((clientY - metrics.top) / metrics.height, 0, 1);
    return [ux, this.isFlipped() ? 1 - rawUy : rawUy];
  }

  zoomAtNormalized(ux, uy, factor) {
    const adapter = this.adapter();
    if (adapter?.zoomAtNormalized) {
      adapter.zoomAtNormalized(ux, uy, factor, this.interactionMetrics);
      return;
    }
    const metrics = this.interactionMetrics || {left: 0, top: 0, width: 1, height: 1};
    const rawUy = this.isFlipped() ? 1 - uy : uy;
    adapter?.zoomAt?.(
      metrics.left + ux * metrics.width,
      metrics.top + rawUy * metrics.height,
      factor,
    );
  }

  handleWheel(event) {
    if (!this.enabled() || this.gesture || !this.adapter()) return;
    event.preventDefault?.();
    this.begin('wheel');
    const pageSize = event.deltaMode === 2 ? this.interactionMetrics?.height || 600 : 600;
    const input = normalizeWheelInput(event, {pageSize});
    if (input.kind === 'zoom') {
      this.wheelAnchor = this.normalizedAnchor(event);
      this.wheelZoomDelta += input.zoomDelta;
    } else {
      this.wheelPanX += input.panX;
      this.wheelPanY += input.panY;
    }
    this.queueWheelFrame();
    this.markWheelActivity(input.kind === 'zoom' ? 150 : 110);
  }

  handleGestureStart(event) {
    if (!this.enabled() || !this.adapter()) return;
    event.preventDefault?.();
    if (this.wheelFrame) this.cancelFrame(this.wheelFrame);
    this.wheelFrame = 0;
    this.resetWheel();
    this.begin('gesture');
    this.gesture = {
      anchor: this.normalizedAnchor(event, {centerOnZero: true}),
      appliedScale: 1,
      pendingScale: 1,
    };
  }

  handleGestureChange(event) {
    if (!this.gesture) return;
    event.preventDefault?.();
    this.gesture.pendingScale = Math.max(.08, Number(event.scale) || 1);
    if (!this.gestureFrame) this.gestureFrame = this.requestFrame(() => this.flushGesture());
  }

  flushGesture() {
    this.gestureFrame = 0;
    if (!this.gesture) return;
    if (Math.abs(this.gesture.appliedScale - this.gesture.pendingScale) < 1e-8) return;
    const factor = safariGestureZoomFactor(this.gesture.appliedScale, this.gesture.pendingScale);
    this.gesture.appliedScale = this.gesture.pendingScale;
    this.zoomAtNormalized(this.gesture.anchor[0], this.gesture.anchor[1], factor);
  }

  handleGestureEnd(event) {
    if (!this.gesture) return;
    event.preventDefault?.();
    if (this.gestureFrame) this.cancelFrame(this.gestureFrame);
    this.gestureFrame = 0;
    this.flushGesture();
    this.gesture = null;
    this.scheduleEnd(78);
  }

  cancelActiveInteraction() {
    if (this.endTimer) this.clearTimer(this.endTimer);
    if (this.wheelFrame) this.cancelFrame(this.wheelFrame);
    if (this.gestureFrame) this.cancelFrame(this.gestureFrame);
    this.endTimer = 0;
    this.wheelFrame = 0;
    this.gestureFrame = 0;
    this.pointer = null;
    this.gesture = null;
    this.resetWheel();
    this.finish();
    this.interactionMetrics = null;
    this.lastWheelAt = 0;
    this.wheelEndDelay = 0;
  }

  destroy() {
    if (this.target?.removeEventListener) {
      for (const [type, handler] of Object.entries(this.handlers)) this.target.removeEventListener(type, handler);
    }
    this.cancelActiveInteraction();
  }
}
