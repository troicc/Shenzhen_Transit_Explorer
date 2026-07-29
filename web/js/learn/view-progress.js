const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));

export function overviewZoomProgress(
  homeWidth,
  currentWidth,
  {start = 1.03, end = 1.85} = {},
) {
  const home = Number(homeWidth);
  const current = Number(currentWidth);
  if (!(home > 0) || !(current > 0) || !(end > start)) return 0;
  const zoomRatio = home / current;
  const raw = clamp((zoomRatio - start) / (end - start), 0, 1);
  return raw * raw * (3 - 2 * raw);
}

export function preserveOverviewZoom(
  view,
  homeView,
  nextHomeView,
  aspect,
  {homeThreshold = 1.02} = {},
) {
  if (!view || !homeView || !nextHomeView) return nextHomeView ? {...nextHomeView} : null;
  const oldRatio = Number(homeView.w) / Math.max(.0001, Number(view.w));
  if (!Number.isFinite(oldRatio) || oldRatio < homeThreshold) return {...nextHomeView};
  const width = Number(nextHomeView.w) / oldRatio;
  const height = width / Math.max(.0001, Number(aspect) || 1);
  const centerX = Number(view.x) + Number(view.w) / 2;
  const centerY = Number(view.y) + Number(view.h) / 2;
  return {
    x: centerX - width / 2,
    y: centerY - height / 2,
    w: width,
    h: height,
  };
}
