import test from 'node:test';
import assert from 'node:assert/strict';

import {PracticeEngine} from '../web/js/learn/practice.js';

const stops = [
  {name: '起点', pinyin: 'qi dian'},
  {name: '海滨浴场', pinyin: 'hai bin yu chang'},
  {name: '终点', pinyin: 'zhong dian'},
];

test('practice types the next station while the vehicle departs the current station', () => {
  const practice = new PracticeEngine();
  practice.start(stops, 'full');
  const start = practice.snapshot();
  assert.equal(start.currentStation.name, '起点');
  assert.equal(start.targetStation.name, '海滨浴场');
  assert.equal(start.arrivedIndex, 0);
  assert.equal(start.targetIndex, 1);
  assert.equal(start.phase, 'idle');
  assert.equal(start.target, 'haibinyuchang');

  assert.equal(practice.input('q').type, 'invalid');
  assert.equal(practice.input('haibinyuchang').type, 'complete');
  assert.equal(practice.snapshot().typingRatio, 1);
  assert.equal(practice.snapshot().phase, 'arriving');
  assert.equal(practice.snapshot().currentStation.name, '起点');

  assert.equal(practice.advance().finished, false);
  assert.equal(practice.snapshot().currentStation.name, '海滨浴场');
  assert.equal(practice.snapshot().targetStation.name, '终点');
  assert.equal(practice.snapshot().arrivedIndex, 1);
  assert.equal(practice.snapshot().targetIndex, 2);
  practice.destroy();
});

test('finishing the final station completes the journey at that station', () => {
  let result = null;
  const practice = new PracticeEngine({onFinish: snapshot => { result = snapshot; }});
  practice.start(stops, 'full');
  practice.input('haibinyuchang');
  practice.advance();
  practice.input('zhongdian');
  const advanced = practice.advance();
  assert.equal(advanced.finished, true);
  assert.equal(result.currentStation.name, '终点');
  assert.equal(result.targetStation, null);
  assert.equal(result.completedStations, 2);
  practice.destroy();
});
