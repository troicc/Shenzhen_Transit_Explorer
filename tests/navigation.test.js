import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

import {NAV_ITEMS, activeNavigationId, normalizeNavigationPath} from '../web/js/navigation.js';

const expected = [
  ['公交全线', '/bus'],
  ['地铁全线', '/metro'],
  ['公交练习', '/bus/learn'],
  ['地铁练习', '/metro/learn'],
  ['公交收集', '/bus/collector'],
  ['地铁收集', '/metro/collector'],
  ['地铁微调工作站', '/studio'],
];

test('global navigation exposes the exact seven entries in fixed order', () => {
  assert.deepEqual(NAV_ITEMS.map(item => [item.label, item.href]), expected);
  assert.equal(new Set(NAV_ITEMS.map(item => item.id)).size, 7);
});

test('global navigation normalizes trailing slashes and selects exact pages', () => {
  assert.equal(normalizeNavigationPath('/metro/learn///?experience=standard'), '/metro/learn');
  assert.equal(activeNavigationId('/bus/collector/'), 'bus-collector');
  assert.equal(activeNavigationId('/metro/learn'), 'metro-learn');
  assert.equal(activeNavigationId('/'), null);
});

test('every internal page type mounts the shared navigation without deleting entries on small screens', () => {
  for (const name of ['network', 'collector', 'learn', 'studio']) {
    const html = readFileSync(new URL(`../web/pages/${name}.html`, import.meta.url), 'utf8');
    assert.match(html, /data-global-nav/);
    assert.match(html, /\/static\/js\/navigation\.js/);
    assert.match(html, /\/static\/css\/navigation\.css/);
  }
  const css = readFileSync(new URL('../web/css/navigation.css', import.meta.url), 'utf8');
  assert.match(css, /overflow-x:\s*auto/);
  const rootRule = css.match(/\.global-nav\s*\{([^}]*)\}/s)?.[1] || '';
  assert.doesNotMatch(rootRule, /display:\s*none/);
});
