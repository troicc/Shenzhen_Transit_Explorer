import test from 'node:test';
import assert from 'node:assert/strict';

import {LearnExperience} from '../web/js/learn/experience.js';

function fixture(profile = 'metroFinal', cameraMode = 'follow', {
  reducedMotion = true,
  recordTransitions = false,
  waitForAnimation,
  stretchController,
} = {}) {
  const events = [];
  const classes = new Set();
  const appElement = {
    dataset: {},
    classList: {
      add: (...values) => values.forEach(value => classes.add(value)),
      remove: (...values) => values.forEach(value => classes.delete(value)),
    },
  };
  const flipScene = {dataset: {face: 'overview'}};
  const overviewRenderer = recordTransitions ? {
    homeView: {x: 0, y: 0, w: 100, h: 80},
    setFlipped: value => events.push(['flip', value]),
    setFocused: value => events.push(['focused', value]),
    setView: () => events.push(['overview-view']),
  } : {};
  const focusRenderer = {
    geometry: {path: [[0, 0], [1, 1]]},
    fitImmersive: async (_progress, options) => { events.push(['immersive-fit', options.strong]); },
    fitFullRoute: async options => { events.push(['full-fit', options.duration]); },
    cancelViewAnimation: recordTransitions ? () => events.push(['cancel-view']) : () => {},
    resetDisplayGeometry: recordTransitions ? () => events.push(['reset-geometry']) : () => {},
    showArrivalPulse: index => events.push(['arrival', index]),
    pointAtProgress: progress => [progress * 100, 40],
    pointAhead: progress => [progress * 100 + 5, 40],
    getView: () => ({x: 0, y: 0, w: 100, h: 80}),
    setView: () => events.push(['camera-view']),
  };
  const experience = new LearnExperience({
    profile,
    network: 'metro',
    appElement,
    flipScene,
    focusRenderer,
    overviewRenderer,
    realMapRenderer: {hide: () => events.push(['hide-real'])},
    stretchController,
    cameraMode,
    reducedMotion,
    waitForAnimation,
  });
  return {experience, events, appElement, flipScene};
}

const frame = {
  route: {stops: Array.from({length: 12}, () => ({}))},
  routeProgress: .35,
  direction: 'forward',
  mapMode: 'flat',
  journeyActive: true,
  arrivedOriginalIndex: 4,
  targetOriginalIndex: 5,
  arrivalOriginalIndex: 5,
  phase: 'arriving',
};

test('Metro Final route entry flips to the route face and uses immersive fit', async () => {
  const {experience, events, appElement, flipScene} = fixture();
  await experience.enterRoute(frame);
  assert.equal(appElement.dataset.experience, 'metroFinal');
  assert.equal(flipScene.dataset.face, 'route');
  assert.deepEqual(events[0], ['immersive-fit', true]);
  experience.destroy();
});

test('Metro Final waits for the wrapper flip before starting route geometry and camera work', async () => {
  const {experience, events} = fixture('metroFinal', 'follow', {
    reducedMotion: false,
    recordTransitions: true,
    waitForAnimation: async milliseconds => events.push(['wait', milliseconds]),
    stretchController: {
      geometryAt: () => ({path: [[0, 0], [1, 1]]}),
      setRoute: () => events.push(['set-route']),
      animateTo: async (target, options) => events.push(['stretch', target, options.duration]),
    },
  });
  events.length = 0;

  await experience.enterRoute(frame);

  const waitIndex = events.findIndex(event => event[0] === 'wait');
  assert.equal(events[waitIndex][1], 780);
  assert.deepEqual(events[waitIndex - 1], ['flip', false]);
  assert.ok(events.findIndex(event => event[0] === 'stretch') > waitIndex);
  assert.ok(events.findIndex(event => event[0] === 'immersive-fit') > waitIndex);
  experience.destroy();
});

test('Metro Final flips before the return settle and cancels pending map animation', async () => {
  const {experience, events} = fixture('metroFinal', 'follow', {
    reducedMotion: false,
    recordTransitions: true,
    waitForAnimation: async milliseconds => events.push(['wait', milliseconds]),
    stretchController: {
      source: {path: [[0, 0], [1, 1]]},
      cancel: () => events.push(['cancel-stretch']),
      animateTo: async (target, options) => events.push(['stretch', target, options.duration]),
    },
  });
  events.length = 0;

  await experience.returnOverview();

  const waitIndex = events.findIndex(event => event[0] === 'wait');
  const stretchIndex = events.findIndex(event => event[0] === 'stretch');
  const fitIndex = events.findIndex(event => event[0] === 'full-fit');
  assert.deepEqual(events[waitIndex - 1], ['flip', true]);
  assert.equal(events[waitIndex][1], 780);
  assert.ok(events.indexOf(events.find(event => event[0] === 'cancel-stretch')) < waitIndex);
  assert.ok(stretchIndex > waitIndex);
  assert.ok(fitIndex > waitIndex);
  assert.equal(events[fitIndex][1], 420);
  experience.destroy();
});

test('arrival is one-shot and return fits before flipping to overview', async () => {
  const {experience, events, flipScene} = fixture();
  await experience.enterRoute(frame);
  await experience.arrive(frame);
  assert.deepEqual(events.filter(event => event[0] === 'arrival'), [['arrival', 5]]);
  events.length = 0;
  await experience.returnOverview(frame);
  assert.deepEqual(events.map(event => event[0]), ['hide-real', 'full-fit']);
  assert.equal(flipScene.dataset.face, 'overview');
  experience.destroy();
});

test('a stationary origin arrival pulses without forcing a camera update', async () => {
  const {experience, events} = fixture();
  await experience.enterRoute(frame);
  events.length = 0;
  await experience.arrive({
    ...frame,
    arrivalOriginalIndex: 4,
    stationaryArrival: true,
  });
  assert.deepEqual(events, [['arrival', 4]]);
  experience.destroy();
});

test('switching profile only replaces the controller and keeps caller journey state untouched', async () => {
  const {experience, events, appElement} = fixture('standard');
  const journeyState = {routeId: 'M1', direction: 'reverse', currentDisplayIndex: 6, input: 'sha'};
  experience.setProfile('immersive');
  await experience.enterPractice({...frame, direction: journeyState.direction});
  assert.deepEqual(journeyState, {routeId: 'M1', direction: 'reverse', currentDisplayIndex: 6, input: 'sha'});
  assert.equal(appElement.dataset.experience, 'metroFinal');
  assert.equal(events.some(event => event[0] === 'immersive-fit'), true);
  experience.destroy();
});

test('full-line camera mode keeps Metro Final capabilities while fitting the whole stretched route', async () => {
  const {experience, events, appElement} = fixture('metroFinal', 'full');
  await experience.enterRoute(frame);
  assert.equal(appElement.dataset.experience, 'metroFinal');
  assert.equal(experience.has('routeStretch'), true);
  assert.equal(experience.has('completionRebound'), true);
  assert.deepEqual(events[0], ['full-fit', 920]);
  experience.setCameraMode('follow');
  await experience.reframe(frame, {practiceVisible: true, animate: false});
  assert.equal(events.some(event => event[0] === 'immersive-fit'), true);
  experience.destroy();
});

test('full-line completion rebounds to the whole route without returning to overview', async () => {
  const {experience, events, appElement, flipScene} = fixture();
  await experience.enterRoute(frame);
  events.length = 0;
  await experience.completeLine(frame);
  assert.equal(appElement.dataset.lineState, 'completed');
  assert.equal(flipScene.dataset.face, 'route');
  assert.deepEqual(events.map(event => event[0]), ['full-fit']);
  experience.destroy();
});

test('manual camera suspension survives passive renders until journey progress really moves', async () => {
  const {experience, events} = fixture();
  const cameraEvents = [];
  experience.camera.destroy();
  experience.camera = {
    resume: () => cameraEvents.push('resume'),
    suspend: () => cameraEvents.push('suspend'),
    update: options => cameraEvents.push(['update', options.progress]),
    stop: () => {},
    destroy: () => {},
  };
  await experience.enterPractice(frame);
  cameraEvents.length = 0;
  experience.suspendForManualNavigation();
  experience.updateJourney({...frame});
  assert.deepEqual(cameraEvents, ['suspend']);
  experience.updateJourney({...frame, routeProgress: .36});
  assert.deepEqual(cameraEvents, ['suspend', 'resume', ['update', .36]]);
  assert.equal(events.some(event => event[0] === 'immersive-fit'), true);
  experience.destroy();
});
