import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

import {overviewZoomProgress, preserveOverviewZoom} from '../web/js/learn/view-progress.js';

test('overview title fade follows zoom only and clamps smoothly', () => {
  assert.equal(overviewZoomProgress(1000, 1000), 0);
  assert.equal(overviewZoomProgress(1000, 1000 / 1.02), 0);
  assert.ok(overviewZoomProgress(1000, 1000 / 1.4) > 0);
  assert.ok(overviewZoomProgress(1000, 1000 / 1.4) < 1);
  assert.equal(overviewZoomProgress(1000, 1000 / 1.85), 1);
  assert.equal(overviewZoomProgress(1000, 1000 / 2.5), 1);
});

test('resize preserves a zoomed viewport ratio without redefining it as home', () => {
  const home = {x: 0, y: 0, w: 1000, h: 500};
  const zoomed = {x: 100, y: 50, w: 500, h: 250};
  const nextHome = {x: -100, y: -50, w: 1200, h: 600};
  const next = preserveOverviewZoom(zoomed, home, nextHome, 2);
  assert.equal(nextHome.w / next.w, 2);
  assert.equal(next.x + next.w / 2, zoomed.x + zoomed.w / 2);
  assert.equal(next.y + next.h / 2, zoomed.y + zoomed.h / 2);
  assert.deepEqual(preserveOverviewZoom(home, home, nextHome, 2), nextHome);
});

test('overview navigation scopes title updates and disables expensive compositing layers', () => {
  const app = readFileSync(new URL('../web/js/learn/app.js', import.meta.url), 'utf8');
  const styles = readFileSync(new URL('../web/css/learn.css', import.meta.url), 'utf8');
  assert.match(app, /classList\.add\('overview-navigation-active'\)/);
  assert.match(app, /classList\.remove\('overview-navigation-active'\)/);
  assert.match(app, /commitOverviewIntroEffects\(\)/);
  assert.match(app, /!elements\.app\.classList\.contains\('overview-navigation-active'\)/);
  assert.match(app, /elements\.intro\.style\.setProperty\('--overview-intro-opacity'/);
  assert.doesNotMatch(app, /elements\.app\.style\.setProperty\('--overview-intro-/);
  assert.match(app, /obscured !== state\.overviewIntroObscured/);
  assert.match(styles, /\.app\.overview-navigation-active \.intro\{filter:none!important;transition:none!important\}/);
  assert.match(styles, /\.app\.overview-navigation-active #metroDistrictLayer/);
  assert.match(styles, /\.app\.overview-navigation-active #metroOverviewStationLayer/);
  assert.match(styles, /\.app\.overview-navigation-active #metroOverviewTransferLayer\{visibility:hidden\}/);
  assert.match(styles, /\.app\.overview-navigation-active \.metro-overview-hit\{visibility:hidden;pointer-events:none\}/);
  assert.match(styles, /body\.is-map-navigating \.brand-mark,/);
  assert.match(styles, /body\.is-map-navigating \.metro-line-strip\{-webkit-backdrop-filter:none!important;backdrop-filter:none!important\}/);
  assert.match(styles, /\.app\[data-network="metro"\]\[data-line-state="entering"\] \.learn-flip-card,/);
  assert.match(styles, /\.app\[data-network="metro"\]\[data-line-state="returning"\] \.learn-flip-card\{will-change:transform\}/);
  assert.match(styles, /\.app\[data-network="metro"\]\[data-cover-flipped="true"\] \.learn-flip-card\{transform:rotateX\(180deg\)\}/);
  assert.match(styles, /#focusSvg \*\{transition:none!important;animation:none!important\}/);
  assert.doesNotMatch(styles, /data-cover-flipped="true"\] #focusSvg\{transform:/);
});
