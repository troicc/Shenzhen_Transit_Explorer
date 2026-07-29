import test from 'node:test';
import assert from 'node:assert/strict';

import {PracticeEngine} from '../web/js/learn/practice.js';

const stops = [
  {name: '起点', pinyin: 'qi dian'},
  {name: '海滨浴场', pinyin: 'hai bin yu chang'},
  {name: '终点', pinyin: 'zhong dian'},
];

test('the first challenge confirms the origin without moving the vehicle', () => {
  const practice = new PracticeEngine();
  practice.start(stops, 'full');

  const initial = practice.snapshot();
  assert.equal(initial.currentStation.name, '起点');
  assert.equal(initial.nextStation.name, '海滨浴场');
  assert.equal(initial.targetStation.name, '起点');
  assert.equal(initial.arrivedIndex, 0);
  assert.equal(initial.targetIndex, 1);
  assert.equal(initial.challengeIndex, 0);
  assert.equal(initial.challengeKind, 'origin');
  assert.equal(initial.originChallenge, true);
  assert.equal(initial.target, 'qidian');
  assert.equal(initial.inputRatio, 0);
  assert.equal(initial.motionRatio, 0);
  assert.equal(initial.progressRatio, 0);

  assert.equal(practice.input('qi').type, 'valid');
  const typing = practice.snapshot();
  assert.ok(typing.inputRatio > 0);
  assert.equal(typing.typingRatio, typing.inputRatio);
  assert.equal(typing.motionRatio, 0);
  assert.equal(typing.phase, 'typing');
  assert.equal(typing.journeyPhase, 'idle');

  const completed = practice.input('qidian');
  assert.deepEqual(
    {
      type: completed.type,
      challengeIndex: completed.challengeIndex,
      challengeKind: completed.challengeKind,
      stationary: completed.stationary,
    },
    {type: 'complete', challengeIndex: 0, challengeKind: 'origin', stationary: true},
  );
  assert.equal(practice.snapshot().phase, 'arriving');
  assert.equal(practice.snapshot().motionRatio, 0);
  assert.equal(practice.snapshot().progressRatio, 1 / stops.length);

  assert.equal(practice.advance().finished, false);
  const advanced = practice.snapshot();
  assert.equal(advanced.currentStation.name, '起点');
  assert.equal(advanced.nextStation.name, '海滨浴场');
  assert.equal(advanced.targetStation.name, '海滨浴场');
  assert.equal(advanced.arrivedIndex, 0);
  assert.equal(advanced.targetIndex, 1);
  assert.equal(advanced.challengeIndex, 1);
  assert.equal(advanced.challengeKind, 'travel');
  assert.equal(advanced.originChallenge, false);
  assert.equal(advanced.progressRatio, 1 / stops.length);
  practice.destroy();
});

test('travel challenges move from the arrived station to the physical target', () => {
  const practice = new PracticeEngine();
  practice.start(stops, 'full');
  practice.input('qidian');
  practice.advance();

  assert.equal(practice.input('hai').type, 'valid');
  const typing = practice.snapshot();
  assert.ok(typing.motionRatio > 0);
  assert.equal(typing.motionRatio, typing.inputRatio);
  assert.equal(typing.journeyPhase, 'typing');

  const completed = practice.input('haibinyuchang');
  assert.equal(completed.type, 'complete');
  assert.equal(completed.stationary, false);
  assert.equal(completed.challengeIndex, 1);
  assert.equal(practice.snapshot().phase, 'arriving');
  assert.equal(practice.snapshot().motionRatio, 1);

  assert.equal(practice.advance().finished, false);
  assert.equal(practice.snapshot().currentStation.name, '海滨浴场');
  assert.equal(practice.snapshot().targetStation.name, '终点');
  assert.equal(practice.snapshot().arrivedIndex, 1);
  assert.equal(practice.snapshot().targetIndex, 2);
  assert.equal(practice.snapshot().challengeIndex, 2);
  practice.destroy();
});

test('finishing the final challenge completes all stations at the terminus', () => {
  let result = null;
  const practice = new PracticeEngine({onFinish: snapshot => { result = snapshot; }});
  practice.start(stops, 'full');
  practice.input('qidian');
  practice.advance();
  practice.input('haibinyuchang');
  practice.advance();
  practice.input('zhongdian');
  const advanced = practice.advance();
  assert.equal(advanced.finished, true);
  assert.equal(result.currentStation.name, '终点');
  assert.equal(result.targetStation, null);
  assert.equal(result.challengeIndex, null);
  assert.equal(result.completedStations, stops.length);
  assert.equal(result.progressRatio, 1);
  practice.destroy();
});

test('a reverse practice starts with the first station in display order', () => {
  const reversedStops = [...stops].reverse();
  const practice = new PracticeEngine();
  practice.start(reversedStops, 'full');
  const initial = practice.snapshot();
  assert.equal(initial.currentStation.name, '终点');
  assert.equal(initial.targetStation.name, '终点');
  assert.equal(initial.nextStation.name, '海滨浴场');
  assert.equal(initial.challengeIndex, 0);
  assert.equal(initial.originChallenge, true);
  practice.destroy();
});

test('a single-station route confirms its origin and completes in place', () => {
  let result = null;
  const practice = new PracticeEngine({onFinish: snapshot => { result = snapshot; }});
  practice.start([stops[0]], 'full');
  const initial = practice.snapshot();
  assert.equal(initial.arrivedIndex, 0);
  assert.equal(initial.targetIndex, null);
  assert.equal(initial.challengeIndex, 0);
  assert.equal(initial.originChallenge, true);
  assert.equal(initial.targetStation.name, '起点');

  const completed = practice.input('qidian');
  assert.equal(completed.stationary, true);
  assert.equal(practice.snapshot().motionRatio, 0);
  assert.equal(practice.advance().finished, true);
  assert.equal(result.currentStation.name, '起点');
  assert.equal(result.completedStations, 1);
  assert.equal(result.progressRatio, 1);
  practice.destroy();
});
