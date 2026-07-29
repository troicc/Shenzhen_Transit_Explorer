import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

import {
  experienceCapabilities,
  fallbackExperienceProfile,
  normalizeExperienceProfile,
  resolveExperienceProfile,
  saveExperienceProfile,
  userExperienceOverrideAllowed,
} from '../web/js/learn/experience-profile.js';

function storage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    values,
  };
}

test('experience resolution follows debug URL, runtime, then network fallback', () => {
  const runtime = {learnExperience: {defaults: {bus: 'immersive', metro: 'standard'}}};
  const local = storage({'transit.learn.experience.bus': 'standard'});
  assert.equal(resolveExperienceProfile({network: 'bus', runtime, storage: local, search: '?experience=immersive'}), 'busExperimental');
  assert.equal(resolveExperienceProfile({network: 'bus', runtime, storage: local, search: ''}), 'busExperimental');
  assert.equal(resolveExperienceProfile({network: 'bus', runtime, storage: storage(), search: ''}), 'busExperimental');
  assert.equal(resolveExperienceProfile({network: 'bus', runtime: {}, storage: storage(), search: ''}), 'standard');
  assert.equal(resolveExperienceProfile({network: 'metro', runtime: {}, storage: storage(), search: ''}), 'metroFinal');
});

test('invalid profile values are ignored and explicit saves are network scoped', () => {
  const local = storage({'transit.learn.experience.metro': 'broken'});
  const runtime = {learnExperience: {defaults: {metro: 'broken'}}};
  assert.equal(resolveExperienceProfile({network: 'metro', runtime, storage: local, search: '?experience=nope'}), 'metroFinal');
  assert.equal(saveExperienceProfile('metro', 'standard', local), true);
  assert.equal(local.values.get('transit.learn.experience.metro'), 'standard');
  assert.equal(saveExperienceProfile('bus', 'invalid', local), false);
  assert.equal(fallbackExperienceProfile('bus'), 'standard');
});

test('legacy immersive values migrate to network-specific capability presets', () => {
  assert.equal(normalizeExperienceProfile('immersive', 'metro'), 'metroFinal');
  assert.equal(normalizeExperienceProfile('immersive', 'bus'), 'busExperimental');
  assert.equal(experienceCapabilities('metroFinal', 'metro').coverFlip, true);
  assert.equal(experienceCapabilities('standard', 'metro').routeStretch, false);
  assert.equal(experienceCapabilities('busExperimental', 'bus').cameraFollow, true);
});

test('runtime can hide user-facing experience controls', () => {
  assert.equal(userExperienceOverrideAllowed({learnExperience: {allowUserOverride: false}}), false);
  assert.equal(userExperienceOverrideAllowed({}), true);
});

test('internal Learn exposes camera preference instead of capability profile names', () => {
  const html = readFileSync(new URL('../web/pages/learn.html', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /<button[^>]+data-experience=/);
  assert.match(html, /data-camera-mode="full"[^>]*>全线视角/);
  assert.match(html, /data-camera-mode="follow"[^>]*>跟车镜头/);
});
