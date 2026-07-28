import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CameraFollowController,
  cameraTargetForPoint,
  springCameraStep,
} from '../web/js/learn/camera-follow.js';

const view = {x: 0, y: 0, w: 1000, h: 600};

test('camera dead zone stays still while an edge position creates a look-ahead target', () => {
  assert.equal(cameraTargetForPoint(view, [480, 252], [520, 252]), null);
  const target = cameraTargetForPoint(view, [920, 252], [980, 252]);
  assert.ok(target.x > 0);
  assert.equal(target.w, view.w);
  const reverse = cameraTargetForPoint(view, [80, 252], [20, 252], {force: true});
  assert.ok(reverse.x < 0);
});

test('spring camera converges without changing the viewport size', () => {
  let current = {...view};
  let velocity = {x: 0, y: 0};
  const target = {...view, x: 180, y: -40};
  for (let index = 0; index < 500; index += 1) {
    const result = springCameraStep(current, velocity, target, .016);
    current = result.view;
    velocity = result.velocity;
    if (result.settled) break;
  }
  assert.ok(Math.abs(current.x - target.x) < .2);
  assert.ok(Math.abs(current.y - target.y) < .2);
  assert.equal(current.w, view.w);
  assert.equal(current.h, view.h);
});

test('manual suspension waits for journey resume and reduced motion commits immediately', () => {
  let current = {...view};
  const calls = [];
  const renderer = {
    getView: () => ({...current}),
    pointAtProgress: progress => [progress * 1000, 252],
    pointAhead: (progress, reverse) => [(progress + (reverse ? -.06 : .06)) * 1000, 252],
    setView: next => { current = {...next}; calls.push(next); },
  };
  const camera = new CameraFollowController({renderer, reducedMotion: true});
  camera.suspend();
  assert.equal(camera.update({progress: .92}), false);
  camera.resume();
  assert.equal(camera.update({progress: .92}), true);
  assert.equal(calls.length, 1);
  camera.destroy();
  assert.equal(camera.update({progress: .1, reverse: true, force: true}), false);
});

test('destroy cancels a scheduled spring frame', () => {
  let scheduled = null;
  const cancelled = [];
  const renderer = {
    getView: () => ({...view}),
    pointAtProgress: () => [950, 252],
    pointAhead: () => [990, 252],
    setView: () => {},
  };
  const camera = new CameraFollowController({
    renderer,
    requestFrame: callback => { scheduled = callback; return 41; },
    cancelFrame: frame => cancelled.push(frame),
    now: () => 10,
  });
  camera.update({progress: .95});
  assert.equal(typeof scheduled, 'function');
  camera.destroy();
  assert.deepEqual(cancelled, [41]);
});
