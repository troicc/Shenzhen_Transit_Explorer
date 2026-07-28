import test from 'node:test';
import assert from 'node:assert/strict';

import {
  doublePinyinSyllable,
  doublePinyinText,
  spellingLabel,
  spellingTarget,
} from '../web/js/learn/spelling.js';

test('spelling targets support full pinyin, Jyutping and named double-pinyin schemes', () => {
  const station = {pinyin: 'shen zhen bei', jyutping: 'sam1 zan3 bak1'};
  assert.equal(spellingTarget(station, 'pinyin'), 'shen zhen bei');
  assert.equal(spellingTarget(station, 'jyutping'), 'sam1 zan3 bak1');
  assert.equal(spellingTarget(station, 'zrm'), 'uf vf bz');
  assert.equal(spellingTarget(station, 'flypy'), 'uf vf bw');
  assert.equal(spellingLabel('zrm'), '自然码双拼');
});

test('double-pinyin conversion handles compound initials, zero initials and tone suffixes', () => {
  assert.equal(doublePinyinSyllable('zhuang1', 'zrm'), 'vd');
  assert.equal(doublePinyinSyllable('an', 'zrm'), 'aj');
  assert.equal(doublePinyinText('lü se', 'flypy'), 'lv se');
});

test('missing language data stays missing instead of silently changing the target station', () => {
  assert.equal(spellingTarget({pinyin: 'xia yi zhan'}, 'jyutping'), '');
  assert.equal(spellingTarget(null, 'pinyin'), '');
});
