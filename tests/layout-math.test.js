import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

import {
  monotonizeProgress,
  nearestVertex,
  reflowStationProgress,
} from '../web/js/authoring/layout-math.js';

const fixture = JSON.parse(readFileSync(
  new URL('./fixtures/zhanyue-v3/layout-math.json', import.meta.url),
  'utf8',
));

test('authoring alpha preview follows the shared fixture without mutating inputs', () => {
  const stops = structuredClone(fixture.stops);
  const result = reflowStationProgress(fixture);
  assert.deepEqual(result, fixture.expectedProgress);
  assert.deepEqual(fixture.stops, stops);
});

test('authoring progress is monotonic with exact endpoints', () => {
  assert.deepEqual(monotonizeProgress([.2, -1, .7]), [0, 1e-9, 1]);
  assert.deepEqual(monotonizeProgress([0, 1, 1]), [0, 1 - 1e-9, 1]);
  assert.deepEqual(nearestVertex([[0, 0], [10, 0], [20, 0]], [12, 1]), {index: 1, dist: Math.sqrt(5)});
});
