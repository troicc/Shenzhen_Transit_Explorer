import test from 'node:test';
import assert from 'node:assert/strict';

import {
  geoMetrics,
  geoPathSlice,
  geoPointAtProgress,
  normalizeRotation,
  shortestRotationDelta,
  smoothedGeoDirection,
} from '../static/learn/real-map.js';

test('real map vehicle interpolates along the selected route', () => {
  const path = [[114, 22], [114.01, 22], [114.02, 22]];
  const metrics = geoMetrics(path);
  const middle = geoPointAtProgress(path, .5, metrics);
  assert.ok(Math.abs(middle[0] - 114.01) < 1e-9);
  assert.ok(Math.abs(middle[1] - 22) < 1e-9);
});

test('real map progress path respects forward and reverse travel', () => {
  const path = [[114, 22], [114.01, 22], [114.02, 22]];
  const metrics = geoMetrics(path);
  const forward = geoPathSlice(path, 0, .5, metrics);
  const reverse = geoPathSlice(path, 1, .5, metrics);
  assert.deepEqual(forward[0], [114, 22]);
  assert.ok(Math.abs(forward.at(-1)[0] - 114.01) < 1e-9);
  assert.deepEqual(reverse[0], [114.02, 22]);
  assert.ok(Math.abs(reverse.at(-1)[0] - 114.01) < 1e-9);
});

test('camera rotation takes the short way across the angle boundary', () => {
  assert.equal(normalizeRotation(190), -170);
  assert.equal(shortestRotationDelta(179, -179), 2);
  assert.equal(shortestRotationDelta(-179, 179), -2);
});

test('camera direction samples a path window instead of a single sharp segment', () => {
  const path = [[114, 22], [114.01, 22], [114.01, 22.01]];
  const metrics = geoMetrics(path);
  const direction = smoothedGeoDirection(path, .5, 1, metrics, .08);
  assert.ok(direction.dx > 0);
  assert.ok(direction.dy > 0);
});
