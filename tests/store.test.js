import test from 'node:test';
import assert from 'node:assert/strict';

import {LearnStore} from '../web/js/learn/store.js';

test('LearnStore keeps route session state immutable and action driven', () => {
  const store = new LearnStore();
  const initial = store.getState();
  assert.equal(Object.isFrozen(initial), true);
  store.dispatch({type: 'PRESENTATION_LOADED', revision: 'metro-presentation-a'});
  const route = {id: 'metro-1:forward'};
  store.dispatch({type: 'ROUTE_SELECTED', route});
  store.dispatch({type: 'DIRECTION_CHANGED', direction: 'reverse', browseIndex: 2});
  store.dispatch({type: 'PRACTICE_STARTED', mode: 'full'});
  const practice = store.getState();
  assert.equal(practice.route, route);
  assert.equal(practice.direction, 'reverse');
  assert.equal(practice.practiceMode, 'full');
  assert.equal(practice.browseIndex, 0);
  assert.equal(practice.presentationRevision, 'metro-presentation-a');
  assert.equal(Object.isFrozen(practice), true);
});

test('switching map mode changes no route, direction or practice fields', () => {
  const route = {id: 'metro-1:forward'};
  const store = new LearnStore();
  store.dispatch({type: 'ROUTE_SELECTED', route});
  store.dispatch({type: 'DIRECTION_CHANGED', direction: 'reverse', browseIndex: 3});
  store.dispatch({type: 'PRACTICE_STARTED', mode: 'timed'});
  const before = store.getState();
  store.dispatch({type: 'VIEW_CHANGED', mode: 'real'});
  const after = store.getState();
  assert.equal(after.viewMode, 'real');
  assert.equal(after.route, before.route);
  assert.equal(after.direction, before.direction);
  assert.equal(after.practiceMode, before.practiceMode);
  assert.equal(after.browseIndex, before.browseIndex);
});

test('clearing a route preserves the loaded presentation revision only', () => {
  const store = new LearnStore();
  store.dispatch({type: 'PRESENTATION_LOADED', revision: 'metro-presentation-b'});
  store.dispatch({type: 'ROUTE_SELECTED', route: {id: 'metro-2:forward'}});
  store.dispatch({type: 'BROADCAST_CHANGED', broadcasting: true});
  store.dispatch({type: 'ROUTE_CLEARED'});
  assert.deepEqual(store.getState(), {
    route: null,
    direction: 'forward',
    browseIndex: 0,
    practiceMode: 'overview',
    viewMode: 'flat',
    broadcasting: false,
    presentationRevision: 'metro-presentation-b',
  });
});
