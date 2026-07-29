import {clamp} from '../learn/core.js';
import {projectPointToPath} from '../learn/geometry.js';

export function nearestVertex(path, position) {
  let index = 0;
  let distance = Infinity;
  for (let candidate = 0; candidate < path.length; candidate += 1) {
    const value = (path[candidate][0] - position[0]) ** 2 + (path[candidate][1] - position[1]) ** 2;
    if (value < distance) {
      distance = value;
      index = candidate;
    }
  }
  return {index, dist: Math.sqrt(distance)};
}

export function monotonizeProgress(values) {
  const progress = values.map(value => clamp(Number(value) || 0, 0, 1));
  if (!progress.length) return progress;
  progress[0] = 0;
  const minimumGap = 1e-9;
  for (let index = 1; index < progress.length - 1; index += 1) {
    const ceiling = 1 - (progress.length - 1 - index) * minimumGap;
    progress[index] = Math.min(ceiling, Math.max(progress[index], progress[index - 1] + minimumGap));
  }
  progress[progress.length - 1] = 1;
  return progress;
}

export function reflowStationProgress({path, stops, anchors, alpha}) {
  const count = stops.length;
  if (count < 2 || path.length < 2) return [];
  const ratio = clamp(Number(alpha) || 0, 0, 1);
  const output = new Array(count).fill(0);
  const anchorIndexes = [];
  for (let index = 0; index < count; index += 1) {
    const key = stops[index].anchorKey;
    if (index === 0 || index === count - 1 || (key && anchors[key])) anchorIndexes.push(index);
  }
  const arcProgress = anchorIndexes.map(index => {
    const key = stops[index].anchorKey;
    const position = key && anchors[key]
      ? [anchors[key].x, anchors[key].y]
      : index === 0 ? path[0] : path.at(-1);
    return projectPointToPath(path, position).progress;
  });
  for (let span = 0; span < anchorIndexes.length - 1; span += 1) {
    const startIndex = anchorIndexes[span];
    const endIndex = anchorIndexes[span + 1];
    const startReal = Number(stops[startIndex].progress ?? startIndex / (count - 1));
    const endReal = Number(stops[endIndex].progress ?? endIndex / (count - 1));
    const startArc = arcProgress[span];
    const endArc = arcProgress[span + 1];
    const spanLength = endIndex - startIndex + 1;
    for (let offset = 0; offset < spanLength; offset += 1) {
      const stationIndex = startIndex + offset;
      const stationReal = Number(stops[stationIndex].progress ?? stationIndex / (count - 1));
      const realRelative = endReal > startReal
        ? clamp((stationReal - startReal) / (endReal - startReal), 0, 1)
        : 0;
      const evenRelative = spanLength > 1 ? offset / (spanLength - 1) : 0;
      output[stationIndex] = startArc
        + (ratio * realRelative + (1 - ratio) * evenRelative) * (endArc - startArc);
    }
  }
  return monotonizeProgress(output);
}
