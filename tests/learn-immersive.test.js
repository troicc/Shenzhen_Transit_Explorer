import test from 'node:test';
import assert from 'node:assert/strict';

import {LearnExperience} from '../web/js/learn/experience.js';

function fixture(profile = 'immersive') {
  const events = [];
  const appElement = {dataset: {}};
  const flipScene = {dataset: {face: 'overview'}};
  const focusRenderer = {
    geometry: {path: [[0, 0], [1, 1]]},
    fitImmersive: async (_progress, options) => { events.push(['immersive-fit', options.strong]); },
    fitFullRoute: async options => { events.push(['full-fit', options.duration]); },
    showArrivalPulse: index => events.push(['arrival', index]),
    pointAtProgress: progress => [progress * 100, 40],
    pointAhead: progress => [progress * 100 + 5, 40],
    getView: () => ({x: 0, y: 0, w: 100, h: 80}),
    setView: () => {},
  };
  const experience = new LearnExperience({
    profile,
    network: 'metro',
    appElement,
    flipScene,
    focusRenderer,
    overviewRenderer: {},
    realMapRenderer: {hide: () => events.push(['hide-real'])},
    reducedMotion: true,
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
};

test('immersive route entry flips to the route face and uses immersive fit', async () => {
  const {experience, events, appElement, flipScene} = fixture();
  await experience.enterRoute(frame);
  assert.equal(appElement.dataset.experience, 'immersive');
  assert.equal(flipScene.dataset.face, 'route');
  assert.deepEqual(events[0], ['immersive-fit', true]);
  experience.destroy();
});

test('arrival is one-shot and return fits before flipping to overview', async () => {
  const {experience, events, flipScene} = fixture();
  await experience.enterRoute(frame);
  await experience.arrive(frame);
  assert.deepEqual(events.filter(event => event[0] === 'arrival'), [['arrival', 4]]);
  events.length = 0;
  await experience.returnOverview(frame);
  assert.deepEqual(events.map(event => event[0]), ['hide-real', 'full-fit']);
  assert.equal(flipScene.dataset.face, 'overview');
  experience.destroy();
});

test('switching profile only replaces the controller and keeps caller journey state untouched', async () => {
  const {experience, events, appElement} = fixture('standard');
  const journeyState = {routeId: 'M1', direction: 'reverse', currentDisplayIndex: 6, input: 'sha'};
  experience.setProfile('immersive');
  await experience.enterPractice({...frame, direction: journeyState.direction});
  assert.deepEqual(journeyState, {routeId: 'M1', direction: 'reverse', currentDisplayIndex: 6, input: 'sha'});
  assert.equal(appElement.dataset.experience, 'immersive');
  assert.equal(events.some(event => event[0] === 'immersive-fit'), true);
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
