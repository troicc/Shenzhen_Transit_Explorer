import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

function loadPublicRuntime() {
  const context = vm.createContext({
    window: {},
    document: {},
    performance: {now: () => 1000},
    setTimeout,
    clearTimeout,
  });
  for (const file of ['web/public/modules/01-core.js', 'web/public/modules/06-practice.js']) {
    vm.runInContext(readFileSync(file, 'utf8'), context, {filename: file});
  }
  return context.window.TransitPublic;
}

test('public practice always targets the next station and cannot skip ahead', () => {
  const Z = loadPublicRuntime();
  const completed = [];
  const practice = new Z.PracticeEngine(null, snapshot => completed.push(snapshot));
  practice.start([
    {name: '甲站', pinyin: 'jia zhan'},
    {name: '乙站', pinyin: 'yi zhan'},
    {name: '丙站', pinyin: 'bing zhan'},
  ], {mode: 'full'});

  assert.equal(practice.snapshot().index, 1);
  assert.equal(practice.snapshot().station.name, '乙站');
  assert.equal(practice.snapshot().target, 'yizhan');
  assert.equal(practice.advance(), false);
  assert.equal(practice.snapshot().station.name, '乙站');

  assert.equal(practice.input('yizhan').type, 'complete');
  assert.equal(practice.advance(), true);
  assert.equal(practice.snapshot().station.name, '丙站');
  assert.equal(practice.input('bingzhan').type, 'complete');
  assert.equal(practice.advance(), false);
  assert.equal(practice.snapshot().active, false);
  assert.equal(completed.length, 1);
});

test('public progress excludes the active segment until the vehicle arrives', () => {
  const {isCompletedSegment} = loadPublicRuntime();
  const forwardMoving = Array.from({length: 4}, (_, index) => isCompletedSegment(index, 2, true, false));
  const forwardArrived = Array.from({length: 4}, (_, index) => isCompletedSegment(index, 2, false, false));
  assert.deepEqual(forwardMoving, [true, false, false, false]);
  assert.deepEqual(forwardArrived, [true, true, false, false]);

  const reverseMoving = Array.from({length: 4}, (_, index) => isCompletedSegment(index, 2, true, true));
  const reverseArrived = Array.from({length: 4}, (_, index) => isCompletedSegment(index, 2, false, true));
  assert.deepEqual(reverseMoving, [false, false, false, true]);
  assert.deepEqual(reverseArrived, [false, false, true, true]);
});
