import {
  bboxOf, clamp, distance, pathMetrics, pointAtProgress, pointSegmentDistance,
} from './core.js';

function rdp(points, tolerance) {
  if (points.length <= 2) return points.map(point => point.slice());
  let farthest = 0;
  let farthestIndex = -1;
  for (let index = 1; index < points.length - 1; index += 1) {
    const value = pointSegmentDistance(points[index], points[0], points.at(-1));
    if (value > farthest) {
      farthest = value;
      farthestIndex = index;
    }
  }
  if (farthestIndex < 0 || farthest <= tolerance) return [points[0].slice(), points.at(-1).slice()];
  const left = rdp(points.slice(0, farthestIndex + 1), tolerance);
  const right = rdp(points.slice(farthestIndex), tolerance);
  return left.slice(0, -1).concat(right);
}

function capPoints(points, count) {
  if (points.length <= count) return points;
  const output = [];
  for (let index = 0; index < count; index += 1) {
    output.push(points[Math.round(index * (points.length - 1) / (count - 1))]);
  }
  return output;
}

function slicePath(points, startProgress, endProgress) {
  if (points.length < 2) return points.map(point => point.slice());
  const { cumulative, total } = pathMetrics(points);
  if (!total) return [points[0].slice(), points.at(-1).slice()];
  const start = clamp(startProgress, 0, 1) * total;
  const end = clamp(endProgress, 0, 1) * total;
  const low = Math.min(start, end);
  const high = Math.max(start, end);
  const output = [pointAtProgress(points, low / total)];
  for (let index = 1; index < points.length - 1; index += 1) {
    if (cumulative[index] > low && cumulative[index] < high) output.push(points[index].slice());
  }
  output.push(pointAtProgress(points, high / total));
  return start <= end ? output : output.reverse();
}

function snapAngle(dx, dy) {
  return Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
}

function removeNearDuplicates(points, threshold = .2) {
  const output = [];
  points.forEach(point => {
    if (!output.length || distance(output.at(-1), point) > threshold) output.push(point.slice());
  });
  return output;
}

function simplifyInterval(points) {
  if (points.length <= 2) return points.map(point => point.slice());
  const box = bboxOf(points);
  const diagonal = Math.hypot(box[2] - box[0], box[3] - box[1]);
  return capPoints(rdp(points, Math.max(2, diagonal * .055)), 4);
}

function segmentLength(points) {
  return pathMetrics(points).total;
}

function median(values) {
  if (!values.length) return 1;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function mergeCollinear(points) {
  if (points.length < 3) return points;
  const output = [points[0]];
  for (let index = 1; index < points.length - 1; index += 1) {
    const a = output.at(-1), b = points[index], c = points[index + 1];
    const angle1 = Math.atan2(b[1] - a[1], b[0] - a[0]);
    const angle2 = Math.atan2(c[1] - b[1], c[0] - b[0]);
    const delta = Math.abs(Math.atan2(Math.sin(angle2 - angle1), Math.cos(angle2 - angle1)));
    if (delta > .01) output.push(b);
  }
  output.push(points.at(-1));
  return removeNearDuplicates(output);
}

export function projectPointToPath(points, point) {
  if (points.length < 2) return {progress: 0, point: points[0] || point, distance: 0};
  const { cumulative, total } = pathMetrics(points);
  let bestDistance = Infinity;
  let bestPoint = points[0];
  let bestAlong = 0;
  for (let index = 1; index < points.length; index += 1) {
    const start = points[index - 1], end = points[index];
    const vx = end[0] - start[0], vy = end[1] - start[1];
    const denominator = vx * vx + vy * vy;
    const ratio = denominator
      ? clamp(((point[0] - start[0]) * vx + (point[1] - start[1]) * vy) / denominator, 0, 1)
      : 0;
    const projected = [start[0] + ratio * vx, start[1] + ratio * vy];
    const value = distance(projected, point);
    if (value < bestDistance) {
      bestDistance = value;
      bestPoint = projected;
      const span = cumulative[index] - cumulative[index - 1];
      bestAlong = cumulative[index - 1] + span * ratio;
    }
  }
  return {progress: total ? bestAlong / total : 0, point: bestPoint, distance: bestDistance};
}

function buildSchematic(route, balanced) {
  const sourcePath = (route.path || []).map(point => [Number(point[0]), Number(point[1])]);
  const stops = route.stops || [];
  if (sourcePath.length < 2 || stops.length < 2) {
    return buildGeographic(route);
  }

  const progresses = stops.map((stop, index) => {
    const fallback = index / Math.max(1, stops.length - 1);
    return clamp(Number.isFinite(Number(stop.progress)) ? Number(stop.progress) : fallback, 0, 1);
  });
  for (let index = 1; index < progresses.length; index += 1) {
    progresses[index] = Math.max(progresses[index], progresses[index - 1] + 1e-7);
  }
  progresses[progresses.length - 1] = Math.max(progresses.at(-1), 1);

  const intervals = [];
  for (let index = 0; index < stops.length - 1; index += 1) {
    const source = slicePath(sourcePath, progresses[index], progresses[index + 1]);
    intervals.push({source, length: Math.max(1, segmentLength(source))});
  }
  const typical = median(intervals.map(interval => interval.length));

  const path = [[0, 0]];
  const stationPoints = [[0, 0]];
  for (let intervalIndex = 0; intervalIndex < intervals.length; intervalIndex += 1) {
    const interval = intervals[intervalIndex];
    const simplified = simplifyInterval(interval.source);
    const vectors = [];
    for (let index = 1; index < simplified.length; index += 1) {
      const dx = simplified[index][0] - simplified[index - 1][0];
      const dy = simplified[index][1] - simplified[index - 1][1];
      const rawLength = Math.hypot(dx, dy);
      if (rawLength > 0) vectors.push({angle: snapAngle(dx, dy), rawLength});
    }
    if (!vectors.length) vectors.push({angle: 0, rawLength: 1});

    const desired = balanced
      ? 112
      : clamp(88 * Math.sqrt(interval.length / Math.max(1, typical)), 66, 190);
    const rawTotal = vectors.reduce((sum, vector) => sum + vector.rawLength, 0) || 1;
    let current = path.at(-1).slice();
    vectors.forEach(vector => {
      const part = Math.max(18, desired * vector.rawLength / rawTotal);
      current = [current[0] + Math.cos(vector.angle) * part, current[1] + Math.sin(vector.angle) * part];
      path.push(current);
    });
    stationPoints.push(current.slice());
  }

  const mergedPath = mergeCollinear(path);
  const stationProgresses = stationPoints.map(point => projectPointToPath(mergedPath, point).progress);
  const correctedStationPoints = stationProgresses.map(progress => pointAtProgress(mergedPath, progress));
  return {
    mode: 'schematic',
    path: mergedPath,
    stationPoints: correctedStationPoints,
    stationProgresses,
    bbox: bboxOf(mergedPath),
  };
}

function buildGeographic(route) {
  const path = (route.path || []).map(point => [Number(point[0]), Number(point[1])]);
  const stationProgresses = (route.stops || []).map((stop, index) => {
    const fallback = index / Math.max(1, route.stops.length - 1);
    return clamp(Number.isFinite(Number(stop.progress)) ? Number(stop.progress) : fallback, 0, 1);
  });
  return {
    mode: 'geographic',
    path,
    stationProgresses,
    stationPoints: stationProgresses.map(progress => pointAtProgress(path, progress)),
    bbox: bboxOf(path),
  };
}

function buildPublishedFocus(route) {
  const focus = route.geometry?.focus;
  const path = (focus?.path || []).map(point => [Number(point[0]), Number(point[1])]);
  if (path.length < 2 || focus?.stationProgresses?.length !== route.stops?.length) return null;
  const stationProgresses = focus.stationProgresses.map(value => clamp(Number(value), 0, 1));
  const stationPoints = focus.stationPoints?.length === route.stops.length
    ? focus.stationPoints.map(point => [Number(point[0]), Number(point[1])])
    : stationProgresses.map(progress => pointAtProgress(path, progress));
  return {
    mode: 'focus',
    path,
    stationProgresses,
    stationPoints,
    bbox: focus.bbox?.length === 4 ? focus.bbox.map(Number) : bboxOf(path),
  };
}

export function buildRouteGeometry(route, {schematic = true, balanced = true} = {}) {
  if (!schematic) return buildGeographic(route);
  return buildPublishedFocus(route) || buildSchematic(route, balanced);
}

export function computeFocusView(box, stageWidth, stageHeight, practiceVisible = false, bottomInsetPx = 0) {
  let [minX, minY, maxX, maxY] = box;
  const routeWidth = Math.max(90, maxX - minX);
  const routeHeight = Math.max(90, maxY - minY);
  const padX = Math.max(70, routeWidth * .14);
  const padTop = Math.max(60, routeHeight * .13);
  const padBottom = Math.max(practiceVisible ? 90 : 85, routeHeight * (practiceVisible ? .24 : .2));
  minX -= padX; maxX += padX; minY -= padTop; maxY += padBottom;
  let width = maxX - minX;
  let height = maxY - minY;
  const safeInset = clamp(bottomInsetPx, 0, Math.max(0, stageHeight - 120));
  const visibleHeight = Math.max(120, stageHeight - safeInset);
  const aspect = Math.max(.2, stageWidth / visibleHeight);
  if (width / height < aspect) {
    const target = height * aspect;
    minX -= (target - width) / 2;
    width = target;
  } else {
    const target = width / aspect;
    minY -= (target - height) * .35;
    height = target;
  }
  if (safeInset > 0) height *= stageHeight / visibleHeight;
  return {x: minX, y: minY, w: width, h: height};
}

function rectanglesOverlap(a, b, margin = 4) {
  return !(a.x + a.w + margin < b.x || b.x + b.w + margin < a.x || a.y + a.h + margin < b.y || b.y + b.h + margin < a.y);
}

function labelBox(name, x, y, anchor, size = 11) {
  const width = Math.max(18, [...String(name)].length * size * .95);
  const height = size * 1.45;
  let left = x;
  if (anchor === 'middle') left -= width / 2;
  if (anchor === 'end') left -= width;
  return {x: left, y: y - height * .78, w: width, h: height};
}

export function layoutStationLabels({stops, geometry, currentOriginalIndex, nextOriginalIndex, allLabels = false, unitPerPixel = 1}) {
  const count = stops.length;
  const priorities = stops.map((stop, index) => {
    let priority = 0;
    if (index === currentOriginalIndex) priority = 100;
    else if (index === nextOriginalIndex) priority = 95;
    else if (index === 0 || index === count - 1) priority = 85;
    else if (stop.majorTransfer || Number(stop.lineCount || 0) >= 5) priority = 70;
    else if (allLabels) priority = 50;
    return {stop, index, priority};
  }).filter(item => item.priority > 0).sort((a, b) => b.priority - a.priority || a.index - b.index);

  const occupied = [];
  const placements = [];
  priorities.forEach(item => {
    const point = geometry.stationPoints[item.index];
    const progress = geometry.stationProgresses[item.index];
    const before = pointAtProgress(geometry.path, clamp(progress - .004, 0, 1));
    const after = pointAtProgress(geometry.path, clamp(progress + .004, 0, 1));
    const tangent = [after[0] - before[0], after[1] - before[1]];
    const tangentLength = Math.hypot(tangent[0], tangent[1]) || 1;
    const normal = [-tangent[1] / tangentLength, tangent[0] / tangentLength];
    const sign = item.index % 2 ? -1 : 1;
    const offset = (item.priority >= 90 ? 19 : 14) * unitPerPixel;
    const candidates = [
      {x: point[0] + normal[0] * offset * sign, y: point[1] + normal[1] * offset * sign, anchor: Math.abs(normal[0]) < .35 ? 'middle' : normal[0] * sign > 0 ? 'start' : 'end'},
      {x: point[0] - normal[0] * offset * sign, y: point[1] - normal[1] * offset * sign, anchor: Math.abs(normal[0]) < .35 ? 'middle' : -normal[0] * sign > 0 ? 'start' : 'end'},
      {x: point[0] + 15, y: point[1] - 10, anchor: 'start'},
      {x: point[0] - 15, y: point[1] + 16, anchor: 'end'},
    ];
    let chosen = null;
    for (const candidate of candidates) {
      const box = labelBox(item.stop.name, candidate.x, candidate.y, candidate.anchor, (item.priority >= 90 ? 13 : 11) * unitPerPixel);
      if (!occupied.some(other => rectanglesOverlap(box, other))) {
        chosen = {...candidate, box};
        break;
      }
    }
    if (!chosen && item.priority >= 70) {
      const candidate = candidates[0];
      chosen = {...candidate, box: labelBox(item.stop.name, candidate.x, candidate.y, candidate.anchor, 11 * unitPerPixel)};
    }
    if (chosen) {
      occupied.push(chosen.box);
      placements.push({...item, ...chosen});
    }
  });
  return placements.sort((a, b) => a.index - b.index);
}
