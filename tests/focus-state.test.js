import test from 'node:test';
import assert from 'node:assert/strict';

import {
  damp,
  pathSlice,
  routeColor,
  stationTravelPhase,
  stationVisualState,
  travelIndex,
} from '../web/js/learn/core.js';
import {computeFocusView} from '../web/js/learn/geometry.js';
import {restoreTypingFocus, shouldRestoreTypingFocus} from '../web/js/learn/typing-focus.js';

test('travelIndex follows the selected direction', () => {
  assert.deepEqual(
    Array.from({length: 6}, (_, index) => travelIndex(index, 6, false)),
    [0, 1, 2, 3, 4, 5],
  );
  assert.deepEqual(
    Array.from({length: 6}, (_, index) => travelIndex(index, 6, true)),
    [5, 4, 3, 2, 1, 0],
  );
});

test('routes receive stable, varied, vivid colors', () => {
  assert.equal(routeColor('M191'), routeColor('M191'));
  assert.notEqual(routeColor('M191'), routeColor('M192'));
  assert.match(routeColor('M191'), /^#[\da-f]{6}$/i);
});

test('damped progress approaches input targets without jumping', () => {
  const first = damp(0, .8, 16, 105);
  const second = damp(first, .8, 16, 105);
  assert.ok(first > 0 && first < .8);
  assert.ok(second > first && second < .8);
  assert.ok(damp(.8, .8, 16, 105) === .8);
});

test('practice typing focus is restored after clicking other elements', () => {
  const activePractice = {mode: 'timed', running: true, finished: false, resultVisible: false};
  const focusCalls = [];
  const input = {focus: options => focusCalls.push(options)};

  assert.equal(shouldRestoreTypingFocus(activePractice), true);
  assert.equal(restoreTypingFocus(input, activePractice), true);
  assert.deepEqual(focusCalls, [{preventScroll: true}]);
  assert.equal(shouldRestoreTypingFocus({...activePractice, mode: 'overview'}), false);
  assert.equal(shouldRestoreTypingFocus({...activePractice, finished: true}), false);
  assert.equal(shouldRestoreTypingFocus({...activePractice, resultVisible: true}), false);
});

test('progress geometry ends exactly at the current vehicle position', () => {
  const path = [[0, 0], [100, 0], [100, 100], [200, 100]];
  const forward = pathSlice(path, 0, .5);
  const reverse = pathSlice(path, 1, .5);
  assert.deepEqual(forward.at(-1), [100, 50]);
  assert.deepEqual(reverse.at(-1), [100, 50]);
  assert.deepEqual(forward[0], [0, 0]);
  assert.deepEqual(reverse[0], [200, 100]);
});

test('station states progress correctly in the forward direction', () => {
  const states = Array.from({length: 6}, (_, index) => ({
    state: stationVisualState(index, 6, 2, 3, false),
    phase: stationTravelPhase(index, 6, 2, 3, false),
  }));
  assert.deepEqual(states, [
    {state: 'terminal', phase: 'passed'},
    {state: 'passed', phase: 'passed'},
    {state: 'current', phase: 'current'},
    {state: 'next', phase: 'next'},
    {state: 'future', phase: 'future'},
    {state: 'terminal', phase: 'future'},
  ]);
});

test('station states progress correctly in the reverse direction', () => {
  const states = Array.from({length: 6}, (_, index) => ({
    state: stationVisualState(index, 6, 3, 2, true),
    phase: stationTravelPhase(index, 6, 3, 2, true),
  }));
  assert.deepEqual(states, [
    {state: 'terminal', phase: 'future'},
    {state: 'future', phase: 'future'},
    {state: 'next', phase: 'next'},
    {state: 'current', phase: 'current'},
    {state: 'passed', phase: 'passed'},
    {state: 'terminal', phase: 'passed'},
  ]);
});

test('practice panel inset reserves more vertical map space', () => {
  const full = computeFocusView([0, 0, 1000, 100], 1000, 800, false, 0);
  const inset = computeFocusView([0, 0, 1000, 100], 1000, 800, true, 300);
  const fullRouteBottom = (100 - full.y) / full.h * 800;
  const insetRouteBottom = (100 - inset.y) / inset.h * 800;
  assert.ok(insetRouteBottom < fullRouteBottom);
  assert.ok(insetRouteBottom < 500);
  assert.ok(inset.w >= 1000);
});
