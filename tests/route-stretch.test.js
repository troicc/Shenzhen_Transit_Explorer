import test from 'node:test';
import assert from 'node:assert/strict';

import {
  bakedScale,
  completionSpring,
  RouteStretchController,
  stretchedGeometry,
} from '../web/js/learn/route-stretch.js';

const source = {
  path: [[0, 0], [50, 0], [100, 0]],
  stationPoints: [[0, 0], [50, 0], [100, 0]],
  stationProgresses: [0, .5, 1],
  bbox: [0, 0, 100, 0],
};

test('route stretch bakes coordinates around the route center without mutating source data', () => {
  const result = stretchedGeometry(source, 1, 2.7);
  assert.equal(bakedScale(1, 2.7), 2.7);
  assert.deepEqual(result.path, [[-85, 0], [50, 0], [185, 0]]);
  assert.deepEqual(result.stationPoints, [[-85, 0], [50, 0], [185, 0]]);
  assert.deepEqual(source.path, [[0, 0], [50, 0], [100, 0]]);
  assert.equal(result.displayCenter[0], 50);
});

test('forward and reverse traveled paths end exactly at the vehicle progress', async () => {
  const rendered = [];
  const stretched = [];
  const controller = new RouteStretchController({
    renderer: {setDisplayGeometry: geometry => rendered.push(geometry)},
    overviewRenderer: {setStretch: (_id, value) => stretched.push(value)},
    maximumScale: 2,
    reducedMotion: true,
  });
  controller.setRoute({id: 'metro-1:forward'}, source);
  await controller.animateTo(1);
  const forward = controller.partialPath(.5, false);
  const reverse = controller.partialPath(.5, true);
  assert.deepEqual(forward.at(-1), controller.pointAtProgress(.5));
  assert.deepEqual(reverse.at(-1), controller.pointAtProgress(.5));
  assert.deepEqual(reverse[0], controller.geometry.path.at(-1));
  assert.equal(rendered.at(-1).displayScale, 2);
  assert.equal(stretched.at(-1), 1);
  await controller.reset();
  assert.deepEqual(controller.geometry.path, source.path);
});

test('completion spring settles exactly at one while allowing a restrained overshoot', () => {
  const samples = Array.from({length: 101}, (_, index) => completionSpring(index / 100));
  assert.equal(samples[0], 0);
  assert.equal(samples.at(-1), 1);
  assert.ok(Math.max(...samples) > 1);
  assert.ok(Math.max(...samples) <= 1.055);
});
