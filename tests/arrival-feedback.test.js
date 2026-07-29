import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

import {resolveArrivalPulseIndex} from '../web/js/learn/experience.js';

test('arrival feedback resolves only an explicit arriving target', () => {
  assert.equal(resolveArrivalPulseIndex({phase: 'arriving', targetOriginalIndex: 7}), 7);
  assert.equal(resolveArrivalPulseIndex({phase: 'arriving', targetOriginalIndex: 2, reverse: true}), 2);
  assert.equal(resolveArrivalPulseIndex({
    phase: 'arriving',
    targetOriginalIndex: null,
    arrivedOriginalIndex: 4,
    currentOriginalIndex: 4,
  }), null);
  assert.equal(resolveArrivalPulseIndex({phase: 'idle', targetOriginalIndex: 5}), null);
  assert.equal(resolveArrivalPulseIndex({phase: 'completed', targetOriginalIndex: 5}), null);
});

test('focus renderer has no duplicate target caption or persistent station ripple', () => {
  const source = readFileSync(new URL('../web/js/learn/renderers.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /current-target-label|station-ring/);
  assert.match(source, /target-station-beacon/);
});
