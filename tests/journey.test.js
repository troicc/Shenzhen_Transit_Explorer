import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

import {createJourneyFrame, JourneyState} from '../web/js/learn/journey.js';

const behaviorMatrix = JSON.parse(readFileSync(
  new URL('./fixtures/zhanyue-v3/behavior-matrix.json', import.meta.url),
  'utf8',
));

test('JourneyState distinguishes arrived and target stations through every phase', () => {
  const journey = new JourneyState();
  assert.deepEqual(journey.reset(3), {
    arrivedIndex: 0,
    targetIndex: 1,
    typingRatio: 0,
    phase: 'idle',
    stopCount: 3,
  });
  assert.equal(journey.setTypingRatio(.4).phase, 'typing');
  assert.equal(journey.beginArrival(), true);
  assert.equal(journey.snapshot().phase, 'arriving');
  assert.deepEqual(
    {arrivedIndex: journey.completeArrival().arrivedIndex, targetIndex: journey.targetIndex, phase: journey.phase},
    {arrivedIndex: 1, targetIndex: 2, phase: 'idle'},
  );
  journey.beginArrival();
  const completed = journey.completeArrival();
  assert.equal(completed.arrivedIndex, 2);
  assert.equal(completed.targetIndex, null);
  assert.equal(completed.phase, 'completed');
});

test('the target is always the station after the vehicle position', () => {
  const journey = new JourneyState();
  journey.reset(3);
  assert.equal(journey.arrivedIndex, 0);
  assert.equal(journey.targetIndex, 1);
  journey.beginArrival();
  journey.completeArrival();
  assert.equal(journey.arrivedIndex, 1);
  assert.equal(journey.targetIndex, 2);
});

test('JourneyFrame is immutable and uses the same explicit semantics in reverse', () => {
  const route = {id: 'metro-1:reverse', stops: [{name: '甲'}, {name: '乙'}, {name: '丙'}]};
  const geometry = {stationProgresses: [0, .5, 1]};
  const frame = createJourneyFrame({
    network: 'metro',
    route,
    direction: 'reverse',
    arrivedIndex: 0,
    targetIndex: 1,
    typingRatio: .4,
    geometry,
    journeyActive: true,
    phase: 'typing',
  });
  const expected = behaviorMatrix.journey.reverse;
  assert.equal(frame.arrivedOriginalIndex, expected.arrivedOriginalIndex);
  assert.equal(frame.targetOriginalIndex, expected.targetOriginalIndex);
  assert.equal(frame.segmentStart, expected.segmentStart);
  assert.equal(frame.segmentEnd, expected.segmentEnd);
  assert.equal(frame.routeProgress, .8);
  assert.equal(frame.currentOriginalIndex, frame.arrivedOriginalIndex);
  assert.equal(frame.nextOriginalIndex, frame.targetOriginalIndex);
  assert.equal(Object.isFrozen(frame), true);
  assert.throws(() => { frame.arrivedIndex = 2; }, TypeError);
});

test('renderer extras cannot override journey business semantics', () => {
  const route = {id: 'metro-1:forward', stops: [{name: '甲'}, {name: '乙'}, {name: '丙'}]};
  const geometry = {stationProgresses: [0, .5, 1]};
  const frame = createJourneyFrame({
    network: 'metro',
    route,
    direction: 'forward',
    arrivedIndex: 0,
    targetIndex: 1,
    typingRatio: 1,
    geometry,
    overrides: {arrivedOriginalIndex: 2, forceCamera: true},
  });
  assert.equal(frame.arrivedOriginalIndex, 0);
  assert.equal(frame.targetOriginalIndex, 1);
  assert.equal(frame.forceCamera, true);
});

test('arriving frames retain the departure station and target in both directions', () => {
  const route = {id: 'metro-2', stops: [{name: '甲'}, {name: '乙'}, {name: '丙'}, {name: '丁'}]};
  const geometry = {stationProgresses: [0, .3, .7, 1]};
  const forward = createJourneyFrame({
    network: 'metro', route, geometry, direction: 'forward',
    arrivedIndex: 1, targetIndex: 2, typingRatio: 1, journeyActive: true, phase: 'arriving',
  });
  const reverse = createJourneyFrame({
    network: 'metro', route, geometry, direction: 'reverse',
    arrivedIndex: 1, targetIndex: 2, typingRatio: 1, journeyActive: true, phase: 'arriving',
  });
  assert.deepEqual(
    [forward.arrivedOriginalIndex, forward.targetOriginalIndex, forward.phase],
    [1, 2, 'arriving'],
  );
  assert.deepEqual(
    [reverse.arrivedOriginalIndex, reverse.targetOriginalIndex, reverse.phase],
    [2, 1, 'arriving'],
  );
});
