export const SVG_NS = 'http://www.w3.org/2000/svg';

export function $(selector, root = document) {
  const node = root.querySelector(selector);
  if (!node) throw new Error(`找不到界面元素：${selector}`);
  return node;
}

export function svgEl(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  Object.entries(attrs).forEach(([key, value]) => node.setAttribute(key, String(value)));
  return node;
}

export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

export function damp(current, target, elapsedMs, responseMs = 110) {
  const elapsed = Math.max(0, Number(elapsedMs) || 0);
  const response = Math.max(1, Number(responseMs) || 1);
  return lerp(Number(current), Number(target), 1 - Math.exp(-elapsed / response));
}

export function travelIndex(originalIndex, count, reverse = false) {
  if (!Number.isFinite(Number(originalIndex)) || count <= 0) return -1;
  const index = clamp(Math.trunc(Number(originalIndex)), 0, count - 1);
  return reverse ? count - 1 - index : index;
}

export function stationTravelPhase(originalIndex, count, currentOriginalIndex, nextOriginalIndex, reverse = false) {
  if (originalIndex === currentOriginalIndex) return 'current';
  if (nextOriginalIndex != null && originalIndex === nextOriginalIndex) return 'next';
  const stationIndex = travelIndex(originalIndex, count, reverse);
  const currentIndex = travelIndex(currentOriginalIndex, count, reverse);
  return stationIndex < currentIndex ? 'passed' : 'future';
}

export function stationVisualState(originalIndex, count, currentOriginalIndex, nextOriginalIndex, reverse = false) {
  const phase = stationTravelPhase(originalIndex, count, currentOriginalIndex, nextOriginalIndex, reverse);
  if (phase === 'current' || phase === 'next') return phase;
  if (originalIndex === 0 || originalIndex === count - 1) return 'terminal';
  return phase;
}

export function easeOutCubic(t) {
  return 1 - Math.pow(1 - t, 3);
}

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
}

export function routeColor(routeNo) {
  let hash = 2166136261;
  for (const character of String(routeNo || '公交')) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  // Route identifiers act as a stable random seed: colors stay consistent during
  // a journey while unrelated routes fan out across a map-compatible palette.
  // Hex is intentional: AMap polyline colors do not reliably accept CSS hsl().
  const palette = [
    '#ff5f57', '#ff7a3d', '#f2b705', '#94c83d', '#28b96b', '#12b8a6',
    '#1aa7d8', '#3e8cff', '#596df4', '#7a62e8', '#a557ef', '#d14fd2',
    '#ef4f9a', '#ff667f', '#00a8c6', '#4fbd5a', '#f28b20', '#e65d3f',
  ];
  return palette[(hash >>> 0) % palette.length];
}

export function normalizePinyin(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[üǖǘǚǜ]/g, 'v')
    .replace(/u:/g, 'v')
    .replace(/[1-5]/g, '')
    .replace(/[^a-zv]/g, '');
}

export function distance(a, b) {
  return Math.hypot(b[0] - a[0], b[1] - a[1]);
}

export function bboxOf(points) {
  if (!points?.length) return [0, 0, 100, 100];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  points.forEach(([x, y]) => {
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  });
  return [minX, minY, maxX, maxY];
}

export function pathMetrics(points) {
  const cumulative = [0];
  let total = 0;
  for (let index = 1; index < points.length; index += 1) {
    total += distance(points[index - 1], points[index]);
    cumulative.push(total);
  }
  return { cumulative, total };
}

export function pointAtProgress(points, progress) {
  if (!points?.length) return [0, 0];
  if (points.length === 1) return points[0].slice();
  const { cumulative, total } = pathMetrics(points);
  if (!total) return points[0].slice();
  const target = clamp(progress, 0, 1) * total;
  for (let index = 1; index < points.length; index += 1) {
    if (cumulative[index] >= target) {
      const span = cumulative[index] - cumulative[index - 1] || 1;
      const ratio = (target - cumulative[index - 1]) / span;
      return [
        lerp(points[index - 1][0], points[index][0], ratio),
        lerp(points[index - 1][1], points[index][1], ratio),
      ];
    }
  }
  return points.at(-1).slice();
}

export function pathSlice(points, startProgress, endProgress) {
  if (!points?.length) return [];
  if (points.length === 1) return [points[0].slice(), points[0].slice()];
  const {cumulative, total} = pathMetrics(points);
  if (!total) return [points[0].slice(), points.at(-1).slice()];
  const start = clamp(startProgress, 0, 1);
  const end = clamp(endProgress, 0, 1);
  const low = Math.min(start, end) * total;
  const high = Math.max(start, end) * total;
  const output = [pointAtProgress(points, low / total)];
  for (let index = 1; index < points.length - 1; index += 1) {
    if (cumulative[index] > low && cumulative[index] < high) output.push(points[index].slice());
  }
  output.push(pointAtProgress(points, high / total));
  return start <= end ? output : output.reverse();
}

export function pathD(points) {
  return points.map((point, index) => `${index ? 'L' : 'M'} ${point[0].toFixed(2)} ${point[1].toFixed(2)}`).join(' ');
}

export function pointSegmentDistance(point, start, end) {
  const vx = end[0] - start[0];
  const vy = end[1] - start[1];
  const denominator = vx * vx + vy * vy;
  const ratio = denominator
    ? clamp(((point[0] - start[0]) * vx + (point[1] - start[1]) * vy) / denominator, 0, 1)
    : 0;
  return Math.hypot(point[0] - (start[0] + ratio * vx), point[1] - (start[1] + ratio * vy));
}

export function showToast(message) {
  const toast = document.querySelector('#toast');
  if (!toast) return;
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove('show'), 1900);
}

export function formatDirection(route) {
  return route?.direction_label || route?.direction || '';
}

export function debounce(callback, delay = 180) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => callback(...args), delay);
  };
}
