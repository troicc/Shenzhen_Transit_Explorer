import test from 'node:test';
import assert from 'node:assert/strict';

import {MetroSchematicOverviewRenderer} from '../web/js/learn/metro-overview.js';
import {NavigationController} from '../web/js/learn/navigation-controller.js';

class FakeNode {
  constructor() {
    this.attributes = new Map();
    this.setCounts = new Map();
    this.removeCounts = new Map();
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    this.setCounts.set(name, (this.setCounts.get(name) || 0) + 1);
  }

  removeAttribute(name) {
    this.attributes.delete(name);
    this.removeCounts.set(name, (this.removeCounts.get(name) || 0) + 1);
  }
}

class FakeTarget {
  constructor(isNavigating) {
    this.isNavigating = isNavigating;
    this.layoutReads = 0;
    this.layoutReadsWhileNavigating = 0;
    this.listeners = new Map();
  }

  get clientHeight() { throw new Error('wheel handling must not read clientHeight'); }
  addEventListener(type, handler) { this.listeners.set(type, handler); }
  removeEventListener(type) { this.listeners.delete(type); }
  getBoundingClientRect() {
    this.layoutReads += 1;
    if (this.isNavigating()) this.layoutReadsWhileNavigating += 1;
    return {left: 10, top: 20, width: 800, height: 500};
  }
}

function scheduler() {
  let clock = 0;
  let nextFrame = 1;
  let nextTimer = 1;
  const frames = new Map();
  const timers = new Map();
  const counts = {setTimer: 0, clearTimer: 0};
  return {
    counts,
    now: () => clock,
    requestFrame(callback) {
      const id = nextFrame++;
      frames.set(id, callback);
      return id;
    },
    cancelFrame(id) { frames.delete(id); },
    setTimer(callback, delay) {
      counts.setTimer += 1;
      const id = nextTimer++;
      timers.set(id, {callback, due: clock + delay});
      return id;
    },
    clearTimer(id) {
      counts.clearTimer += 1;
      timers.delete(id);
    },
    flushFrames() {
      const pending = [...frames.values()];
      frames.clear();
      pending.forEach(callback => callback(clock));
    },
    advance(milliseconds) {
      clock += milliseconds;
      let due = [...timers.entries()].filter(([, timer]) => timer.due <= clock);
      while (due.length) {
        due.forEach(([id, timer]) => {
          timers.delete(id);
          timer.callback();
        });
        due = [...timers.entries()].filter(([, timer]) => timer.due <= clock);
      }
    },
  };
}

function emptyLayer() {
  return {replaceChildren() {}, querySelectorAll: () => []};
}

test('a Chromium pinch previews one group matrix and commits viewBox once at its deadline', () => {
  let navigating = false;
  const target = new FakeTarget(() => navigating);
  const mapFlipStage = new FakeNode();
  const grid = new FakeNode();
  const svg = new FakeNode();
  svg.querySelector = selector => selector === '#mapFlipStage' ? mapFlipStage : selector === '#gridRect' ? grid : null;
  svg.classList = {toggle() {}};
  svg.dataset = {};
  const renderer = new MetroSchematicOverviewRenderer({
    svg,
    stage: target,
    routeLayer: emptyLayer(),
    districtLayer: emptyLayer(),
    stationLayer: emptyLayer(),
    transferLayer: emptyLayer(),
    onViewChange() {},
  });
  renderer.presentation = {world: {width: 1000, height: 500}};
  renderer.view = {x: 0, y: 0, w: 1000, h: 500};
  renderer.homeView = {...renderer.view};
  renderer.committedView = {...renderer.view};

  const timing = scheduler();
  const controller = new NavigationController({
    target,
    renderer,
    onInteractionStart() { navigating = true; },
    onInteractionEnd() { navigating = false; },
    requestFrame: callback => timing.requestFrame(callback),
    cancelFrame: id => timing.cancelFrame(id),
    setTimer: (callback, delay) => timing.setTimer(callback, delay),
    clearTimer: id => timing.clearTimer(id),
    now: () => timing.now(),
  });

  for (let index = 0; index < 120; index += 1) {
    controller.handleWheel({
      deltaX: 0,
      deltaY: -1,
      deltaMode: 0,
      ctrlKey: true,
      clientX: 240,
      clientY: 190,
      preventDefault() {},
    });
  }
  timing.flushFrames();

  assert.equal(target.layoutReads, 1);
  assert.equal(target.layoutReadsWhileNavigating, 0);
  assert.equal(timing.counts.setTimer, 1);
  assert.equal(timing.counts.clearTimer, 0);
  assert.equal(svg.setCounts.get('viewBox') || 0, 0);
  assert.equal(grid.setCounts.size, 0);
  assert.equal(mapFlipStage.setCounts.get('transform'), 1);
  assert.match(mapFlipStage.attributes.get('transform'), /^matrix\(/);

  timing.advance(149);
  assert.equal(svg.setCounts.get('viewBox') || 0, 0);
  timing.advance(1);

  assert.equal(svg.setCounts.get('viewBox'), 1);
  assert.equal(mapFlipStage.attributes.has('transform'), false);
  assert.equal(renderer.navigationActive, false);
  assert.equal(navigating, false);
  assert.ok(timing.counts.clearTimer <= 1);
});
