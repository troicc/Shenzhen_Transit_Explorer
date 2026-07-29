import test from 'node:test';
import assert from 'node:assert/strict';

import {LearnExperience} from '../web/js/learn/experience.js';

function classList() {
  const values = new Set();
  return {
    add: (...items) => items.forEach(item => values.add(item)),
    remove: (...items) => items.forEach(item => values.delete(item)),
    contains: item => values.has(item),
  };
}

test('the information cards finish closing before route merge and cover flip begin', async () => {
  const events = [];
  let finishCards;
  const cardFinished = new Promise(resolve => { finishCards = resolve; });
  const style = {
    setProperty(name, value) { events.push(['card-style', name, value]); },
    removeProperty(name) { events.push(['card-reset', name]); },
  };
  const dock = {
    style,
    animate(_keyframes, options) {
      events.push(['cards-close', options.duration, options.easing]);
      return {finished: cardFinished, cancel() { events.push(['cards-cancel']); }};
    },
  };
  const appElement = {
    dataset: {},
    classList: classList(),
    querySelector: selector => selector === '.line-info-dock' ? dock : null,
  };
  const overviewRenderer = {
    homeView: {x: 0, y: 0, w: 1000, h: 600},
    setFlipped(value) { events.push(['flip', value]); },
    setFocused(value) { events.push(['focused', value]); },
    setView() { events.push(['overview-view']); },
  };
  const focusRenderer = {
    geometry: {path: [[0, 0], [1, 1]], bbox: [0, 0, 1, 1]},
    sourceGeometry: {path: [[0, 0], [1, 1]], bbox: [0, 0, 1, 1]},
    svg: {querySelector: () => null},
    cancelViewAnimation() { events.push(['cancel-view']); },
    setView(_view, options) {
      events.push(['camera-merge', options.duration]);
      return Promise.resolve(true);
    },
    fitFullRoute(options) {
      events.push(['full-fit', options.duration]);
      return Promise.resolve(true);
    },
    resetDisplayGeometry() { events.push(['reset-geometry']); },
  };
  const stretchController = {
    source: {path: [[0, 0], [1, 1]], bbox: [0, 0, 1, 1]},
    cancel() { events.push(['cancel-stretch']); },
    animateTo(_target, options) {
      events.push(['stretch-merge', options.duration]);
      return Promise.resolve(true);
    },
    destroy() {},
  };
  const experience = new LearnExperience({
    profile: 'metroFinal',
    network: 'metro',
    appElement,
    flipScene: {dataset: {}},
    focusRenderer,
    overviewRenderer,
    realMapRenderer: {hide() { events.push(['hide-real']); }},
    stretchController,
    reducedMotion: false,
    waitForAnimation: async milliseconds => events.push(['wait', milliseconds]),
  });
  events.length = 0;

  const returning = experience.returnOverview();
  await Promise.resolve();

  assert.equal(appElement.dataset.lineState, 'closing');
  assert.equal(events.some(event => event[0] === 'cards-close'), true);
  assert.equal(events.some(event => event[0] === 'stretch-merge'), false);
  assert.equal(events.some(event => event[0] === 'camera-merge'), false);
  assert.equal(events.some(event => event[0] === 'flip' && event[1] === true), false);

  finishCards();
  await returning;

  const cardsIndex = events.findIndex(event => event[0] === 'cards-close');
  const stretchIndex = events.findIndex(event => event[0] === 'stretch-merge');
  const cameraIndex = events.findIndex(event => event[0] === 'camera-merge');
  const networkIndex = events.findIndex(event => event[0] === 'focused' && event[1] === false);
  const flipIndex = events.findIndex(event => event[0] === 'flip' && event[1] === true);

  assert.ok(cardsIndex >= 0);
  assert.ok(stretchIndex > cardsIndex);
  assert.ok(cameraIndex > cardsIndex);
  assert.ok(networkIndex > stretchIndex);
  assert.ok(networkIndex > cameraIndex);
  assert.ok(flipIndex > networkIndex);
  assert.equal(appElement.dataset.lineState, 'overview');

  experience.destroy();
});
