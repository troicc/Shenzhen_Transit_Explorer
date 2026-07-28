export const EXPERIENCE_PROFILES = Object.freeze(['standard', 'immersive']);
export const VALID_PROFILES = new Set(EXPERIENCE_PROFILES);

export function fallbackExperienceProfile(network) {
  return network === 'metro' ? 'immersive' : 'standard';
}

function safeStorageRead(storage, key) {
  try { return storage?.getItem?.(key); } catch (_) { return null; }
}

export function resolveExperienceProfile({
  network,
  runtime,
  search = typeof window === 'undefined' ? '' : window.location.search,
  storage = typeof window === 'undefined' ? null : window.localStorage,
} = {}) {
  const params = new URLSearchParams(search || '');
  const storageKey = `transit.learn.experience.${network}`;
  const candidates = [
    params.get('experience'),
    safeStorageRead(storage, storageKey),
    runtime?.learnExperience?.defaults?.[network],
    fallbackExperienceProfile(network),
  ];
  return candidates.find(value => VALID_PROFILES.has(value)) || fallbackExperienceProfile(network);
}

export function saveExperienceProfile(network, profile, storage = typeof window === 'undefined' ? null : window.localStorage) {
  if (!VALID_PROFILES.has(profile)) return false;
  try {
    storage?.setItem?.(`transit.learn.experience.${network}`, profile);
    return true;
  } catch (_) {
    return false;
  }
}

export function userExperienceOverrideAllowed(runtime) {
  return runtime?.learnExperience?.allowUserOverride !== false;
}
