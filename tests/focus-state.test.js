import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

import {
  damp,
  pathSlice,
  routeColor,
  stationTravelPhase,
  stationVisualState,
  travelIndex,
} from '../web/js/learn/core.js';
import {computeFocusView} from '../web/js/learn/geometry.js';
import {routeGeometryCacheKey} from '../web/js/learn/geometry.js';
import {focusStaticSceneKey, visualScaleBucket} from '../web/js/learn/renderers.js';
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

test('geometry cache keys include presentation revision and every display dimension', () => {
  const route = {id: 'metro-1:reverse', direction: 'reverse', built_at: 'old'};
  const first = routeGeometryCacheKey(route, {revision: 'revision-a', schematic: true, balanced: true});
  const revised = routeGeometryCacheKey(route, {revision: 'revision-b', schematic: true, balanced: true});
  const geographic = routeGeometryCacheKey(route, {revision: 'revision-a', schematic: false, balanced: true});
  const distance = routeGeometryCacheKey(route, {revision: 'revision-a', schematic: true, balanced: false});
  assert.notEqual(first, revised);
  assert.notEqual(first, geographic);
  assert.notEqual(first, distance);
  assert.match(first, /metro-1:reverse:reverse:schematic:balanced$/);
});

test('typing, camera pan and small zooms do not rebuild static stations and labels', () => {
  const base = {
    currentOriginalIndex: 2,
    nextOriginalIndex: 3,
    challengeOriginalIndex: 3,
    reverse: false,
    allLabels: false,
    journeyActive: true,
    unitPerPixel: 1.25,
  };
  const first = focusStaticSceneKey({...base, typingRatio: .1});
  const typed = focusStaticSceneKey({...base, typingRatio: .8});
  const sameBucket = focusStaticSceneKey({...base, unitPerPixel: 1.26});
  const arrived = focusStaticSceneKey({...base, currentOriginalIndex: 3, nextOriginalIndex: 4});
  const nextChallenge = focusStaticSceneKey({...base, challengeOriginalIndex: 4});
  const zoomed = focusStaticSceneKey({...base, unitPerPixel: 1.4});
  assert.equal(first, typed);
  assert.equal(first, sameBucket);
  assert.notEqual(first, arrived);
  assert.notEqual(first, nextChallenge);
  assert.notEqual(first, zoomed);
  assert.equal(visualScaleBucket(1.25), visualScaleBucket(1.26));
  assert.notEqual(visualScaleBucket(1.25), visualScaleBucket(1.4));
});

test('challenge beacon follows the typing challenge without changing its visual layers', () => {
  const source = readFileSync(new URL('../web/js/learn/renderers.js', import.meta.url), 'utf8');
  assert.match(source, /Number\.isInteger\(challengeOriginalIndex\)/);
  assert.match(source, /'data-target-role': 'challenge-station'/);
  assert.match(source, /class: 'target-ring secondary'/);
  assert.match(source, /class: 'target-ring'/);
  assert.match(source, /class: 'target-dot'/);
});
