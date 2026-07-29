export const EXPERIENCE_PRESETS = Object.freeze({
  metroFinal: Object.freeze({
    schematicOverview: true,
    coverFlip: true,
    routeIsolation: true,
    routeStretch: true,
    cameraFollow: true,
    arrivalPulse: true,
    completionRebound: true,
  }),
  standard: Object.freeze({
    schematicOverview: false,
    coverFlip: false,
    routeIsolation: true,
    routeStretch: false,
    cameraFollow: false,
    arrivalPulse: true,
    completionRebound: false,
  }),
  busExperimental: Object.freeze({
    schematicOverview: false,
    coverFlip: false,
    routeIsolation: true,
    routeStretch: true,
    cameraFollow: true,
    arrivalPulse: true,
    completionRebound: true,
  }),
});
export const EXPERIENCE_PROFILES = Object.freeze(Object.keys(EXPERIENCE_PRESETS));
export const VALID_PROFILES = new Set(EXPERIENCE_PROFILES);

export function fallbackExperienceProfile(network) {
  return network === 'metro' ? 'metroFinal' : 'standard';
}

export function normalizeExperienceProfile(profile, network) {
  if (VALID_PROFILES.has(profile)) return profile;
  const folded = String(profile || '').toLowerCase();
  if (folded === 'metrofinal') return 'metroFinal';
  if (folded === 'busexperimental') return 'busExperimental';
  if (folded === 'immersive') return network === 'metro' ? 'metroFinal' : 'busExperimental';
  return null;
}

export function experienceCapabilities(profile, network) {
  const normalized = normalizeExperienceProfile(profile, network) || fallbackExperienceProfile(network);
  return EXPERIENCE_PRESETS[normalized];
}

export function resolveExperienceProfile({
  network,
  runtime,
  search = typeof window === 'undefined' ? '' : window.location.search,
} = {}) {
  const params = new URLSearchParams(search || '');
  const candidates = [
    params.get('experience'),
    runtime?.learnExperience?.defaults?.[network],
    fallbackExperienceProfile(network),
  ];
  for (const value of candidates) {
    const normalized = normalizeExperienceProfile(value, network);
    if (normalized) return normalized;
  }
  return fallbackExperienceProfile(network);
}

export function saveExperienceProfile(network, profile, storage = typeof window === 'undefined' ? null : window.localStorage) {
  const normalized = normalizeExperienceProfile(profile, network);
  if (!normalized) return false;
  try {
    storage?.setItem?.(`transit.learn.experience.${network}`, normalized);
    return true;
  } catch (_) {
    return false;
  }
}

export function userExperienceOverrideAllowed(runtime) {
  return runtime?.learnExperience?.allowUserOverride !== false;
}
