import test from 'node:test';
import assert from 'node:assert/strict';

import {wheelDeltaPixels} from '../web/js/learn/input-normalizer.js';
import {NavigationController} from '../web/js/learn/navigation-controller.js';

class FakeTarget {
  constructor() {
    this.clientHeight = 500;
    this.listeners = new Map();
  }

  addEventListener(type, handler) { this.listeners.set(type, handler); }
  removeEventListener(type) { this.listeners.delete(type); }
  setPointerCapture() {}
  getBoundingClientRect() { return {left: 10, top: 20, width: 800, height: 500}; }
}

function harness({flipped = false} = {}) {
  const target = new FakeTarget();
  const calls = {pan: [], zoom: [], begin: 0, end: 0, starts: [], ends: [], doubleClicks: 0};
  const frames = new Map();
  const timers = new Map();
  let nextFrame = 1;
  let nextTimer = 1;
  const renderer = {
    panByPixels: (...args) => calls.pan.push(args),
    zoomAt: (...args) => calls.zoom.push(args),
    beginManualNavigation: () => { calls.begin += 1; },
    endManualNavigation: () => { calls.end += 1; },
  };
  const controller = new NavigationController({
    target,
    renderer,
    isFlipped: () => flipped,
    onBackgroundDoubleClick: () => { calls.doubleClicks += 1; },
    isInteractiveTarget: node => Boolean(node?.closest?.('.route-hit,.station-node,.metro-overview-transfer')),
    onInteractionStart: source => calls.starts.push(source),
    onInteractionEnd: source => calls.ends.push(source),
    requestFrame: callback => { const id = nextFrame++; frames.set(id, callback); return id; },
    cancelFrame: id => frames.delete(id),
    setTimer: callback => { const id = nextTimer++; timers.set(id, callback); return id; },
    clearTimer: id => timers.delete(id),
  });
  return {
    calls,
    controller,
    flushFrames() {
      const pending = [...frames.values()];
      frames.clear();
      pending.forEach(callback => callback(16));
    },
    flushTimers() {
      const pending = [...timers.values()];
      timers.clear();
      pending.forEach(callback => callback());
    },
  };
}

function wheel(overrides = {}) {
  return {
    deltaX: 0,
    deltaY: 0,
    deltaMode: 0,
    clientX: 200,
    clientY: 180,
    preventDefault() {},
    ...overrides,
  };
}

test('wheel deltas normalize pixel, line and page units', () => {
  assert.equal(wheelDeltaPixels(2, 0, 500), 2);
  assert.equal(wheelDeltaPixels(2, 1, 500), 64);
  assert.equal(wheelDeltaPixels(2, 2, 500), 1000);
});

test('trackpad scrolling pans once per animation frame and respects cover flip', () => {
  const normal = harness();
  normal.controller.handleWheel(wheel({deltaX: 3, deltaY: 5}));
  normal.controller.handleWheel(wheel({deltaX: 7, deltaY: 11}));
  assert.equal(normal.calls.pan.length, 0);
  normal.flushFrames();
  assert.deepEqual(normal.calls.pan, [[-10, -16]]);
  assert.deepEqual(normal.calls.starts, ['wheel']);

  const flipped = harness({flipped: true});
  flipped.controller.handleWheel(wheel({deltaX: 3, deltaY: 5}));
  flipped.flushFrames();
  assert.deepEqual(flipped.calls.pan, [[-3, 5]]);
});

test('shift-wheel pans horizontally while Chromium ctrl-wheel zooms at the pointer', () => {
  const shifted = harness();
  shifted.controller.handleWheel(wheel({deltaY: 12, shiftKey: true}));
  shifted.flushFrames();
  assert.deepEqual(shifted.calls.pan, [[-12, 0]]);
  assert.equal(shifted.calls.zoom.length, 0);

  const pinched = harness();
  pinched.controller.handleWheel(wheel({deltaY: -20, ctrlKey: true, clientX: 240, clientY: 190}));
  pinched.flushFrames();
  assert.equal(pinched.calls.pan.length, 0);
  assert.equal(pinched.calls.zoom.length, 1);
  assert.deepEqual(pinched.calls.zoom[0].slice(0, 2), [240, 190]);
  assert.ok(pinched.calls.zoom[0][2] < 1);
});

test('Safari gesture scale is incremental and manual navigation ends after the gesture', () => {
  const value = harness();
  value.controller.handleGestureStart({clientX: 0, clientY: 0, preventDefault() {}});
  value.controller.handleGestureChange({scale: 2, preventDefault() {}});
  value.flushFrames();
  value.controller.handleGestureChange({scale: 2.4, preventDefault() {}});
  value.flushFrames();
  value.controller.handleGestureEnd({preventDefault() {}});
  assert.equal(value.calls.zoom.length, 2);
  assert.deepEqual(value.calls.zoom[0].slice(0, 2), [410, 270]);
  assert.ok(value.calls.zoom[0][2] < 1);
  assert.ok(value.calls.zoom[1][2] < 1);
  value.flushTimers();
  assert.equal(value.calls.begin, 1);
  assert.equal(value.calls.end, 1);
  assert.deepEqual(value.calls.ends, ['gesture']);
});

test('double-clicking blank map background triggers return but route and station targets do not', () => {
  const value = harness();
  const blankEvent = {
    target: {closest: () => null},
    prevented: 0,
    stopped: 0,
    preventDefault() { this.prevented += 1; },
    stopPropagation() { this.stopped += 1; },
  };
  value.controller.handleDoubleClick(blankEvent);
  assert.equal(value.calls.doubleClicks, 1);
  assert.equal(blankEvent.prevented, 1);
  assert.equal(blankEvent.stopped, 1);

  const interactiveEvent = {
    target: {closest: selector => selector.includes('.station-node') ? {} : null},
    preventDefault() { throw new Error('interactive targets must not be consumed'); },
  };
  value.controller.handleDoubleClick(interactiveEvent);
  assert.equal(value.calls.doubleClicks, 1);
});

test('background double-click cancels pending navigation work without a second interaction end', () => {
  const value = harness();
  value.controller.handleWheel(wheel({deltaY: 12}));
  value.controller.handleDoubleClick({target: {closest: () => null}, preventDefault() {}, stopPropagation() {}});
  value.flushFrames();
  value.flushTimers();
  assert.equal(value.calls.doubleClicks, 1);
  assert.equal(value.calls.end, 1);
  assert.deepEqual(value.calls.ends, ['wheel']);
  assert.equal(value.calls.pan.length, 0);
});
