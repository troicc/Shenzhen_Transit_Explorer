import test from 'node:test';
import assert from 'node:assert/strict';

import {
  fallbackExperienceProfile,
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

test('experience resolution follows URL, storage, runtime, then network fallback', () => {
  const runtime = {learnExperience: {defaults: {bus: 'immersive', metro: 'standard'}}};
  const local = storage({'transit.learn.experience.bus': 'standard'});
  assert.equal(resolveExperienceProfile({network: 'bus', runtime, storage: local, search: '?experience=immersive'}), 'immersive');
  assert.equal(resolveExperienceProfile({network: 'bus', runtime, storage: local, search: ''}), 'standard');
  assert.equal(resolveExperienceProfile({network: 'bus', runtime, storage: storage(), search: ''}), 'immersive');
  assert.equal(resolveExperienceProfile({network: 'bus', runtime: {}, storage: storage(), search: ''}), 'standard');
  assert.equal(resolveExperienceProfile({network: 'metro', runtime: {}, storage: storage(), search: ''}), 'immersive');
});

test('invalid profile values are ignored and explicit saves are network scoped', () => {
  const local = storage({'transit.learn.experience.metro': 'broken'});
  const runtime = {learnExperience: {defaults: {metro: 'broken'}}};
  assert.equal(resolveExperienceProfile({network: 'metro', runtime, storage: local, search: '?experience=nope'}), 'immersive');
  assert.equal(saveExperienceProfile('metro', 'standard', local), true);
  assert.equal(local.values.get('transit.learn.experience.metro'), 'standard');
  assert.equal(saveExperienceProfile('bus', 'invalid', local), false);
  assert.equal(fallbackExperienceProfile('bus'), 'standard');
});

test('runtime can hide user-facing experience controls', () => {
  assert.equal(userExperienceOverrideAllowed({learnExperience: {allowUserOverride: false}}), false);
  assert.equal(userExperienceOverrideAllowed({}), true);
});
