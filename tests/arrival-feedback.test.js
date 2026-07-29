import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

import {travelIndex} from '../web/js/learn/core.js';
import {resolveArrivalPulseIndex} from '../web/js/learn/experience.js';

test('arrival feedback resolves only an explicit feedback index', () => {
  assert.equal(resolveArrivalPulseIndex({phase: 'arriving', arrivalOriginalIndex: 7}), 7);
  assert.equal(resolveArrivalPulseIndex({phase: 'arriving', arrivalOriginalIndex: 2, reverse: true}), 2);
  assert.equal(resolveArrivalPulseIndex({
    phase: 'arriving',
    arrivalOriginalIndex: null,
    targetOriginalIndex: 7,
    arrivedOriginalIndex: 4,
    currentOriginalIndex: 4,
  }), null);
  assert.equal(resolveArrivalPulseIndex({phase: 'idle', arrivalOriginalIndex: 5}), null);
  assert.equal(resolveArrivalPulseIndex({phase: 'completed', arrivalOriginalIndex: 5}), null);
});

test('a reverse origin pulse maps the display origin to the source terminus', () => {
  const arrivalOriginalIndex = travelIndex(0, 3, true);
  assert.equal(arrivalOriginalIndex, 2);
  assert.equal(resolveArrivalPulseIndex({
    phase: 'arriving',
    arrivalOriginalIndex,
    targetOriginalIndex: 1,
  }), 2);
});

test('focus renderer has no duplicate target caption or persistent station ripple', () => {
  const source = readFileSync(new URL('../web/js/learn/renderers.js', import.meta.url), 'utf8');
  const styles = readFileSync(new URL('../web/css/learn.css', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /current-target-label|station-ring/);
  assert.match(source, /target-station-beacon/);
  assert.match(source, /class: 'arrival-halo'/);
  assert.match(source, /r: 11 \* unitPerPixel/);
  assert.match(styles, /arrivalHalo/);
  assert.match(styles, /scale\(5\.4\)/);
});

test('Learn app keeps input progress out of vehicle motion and supplies the pulse index', () => {
  const source = readFileSync(new URL('../web/js/learn/app.js', import.meta.url), 'utf8');
  assert.match(source, /syncJourneyMotion\(snapshot\.motionRatio\)/);
  assert.doesNotMatch(source, /syncJourneyMotion\(snapshot\.typingRatio\)/);
  assert.match(source, /originalIndexFromDisplay\(snapshot\.challengeIndex\)/);
  assert.match(source, /stationaryArrival: result\.stationary/);
});
