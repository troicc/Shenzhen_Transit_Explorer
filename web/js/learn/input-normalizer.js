const LINE_DELTA_PIXELS = 32;

export function wheelDeltaPixels(value, deltaMode = 0, pageSize = 600) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  if (deltaMode === 1) return number * LINE_DELTA_PIXELS;
  if (deltaMode === 2) return number * Math.max(1, Number(pageSize) || 600);
  return number;
}

export function normalizeWheelInput(event, {pageSize = 600} = {}) {
  const deltaX = wheelDeltaPixels(event?.deltaX, event?.deltaMode, pageSize);
  const deltaY = wheelDeltaPixels(event?.deltaY, event?.deltaMode, pageSize);
  if (event?.ctrlKey) {
    return {
      kind: 'zoom',
      zoomDelta: Math.max(-46, Math.min(46, deltaY)),
      panX: 0,
      panY: 0,
    };
  }
  if (event?.shiftKey && Math.abs(deltaX) < Math.abs(deltaY)) {
    return {kind: 'pan', zoomDelta: 0, panX: deltaY, panY: 0};
  }
  return {kind: 'pan', zoomDelta: 0, panX: deltaX, panY: deltaY};
}

export function safariGestureZoomFactor(previousScale, nextScale) {
  const previous = Math.max(.08, Number(previousScale) || 1);
  const next = Math.max(.08, Number(nextScale) || 1);
  return Math.max(.5, Math.min(2, Math.pow(previous / next, 1.32)));
}
