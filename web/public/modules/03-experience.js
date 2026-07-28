(() => {
  const Z = window.TransitPublic;
  const profiles = new Set(['standard', 'immersive']);
  const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

  function fallback(network) { return network === 'metro' ? 'immersive' : 'standard'; }

  function storageValue(key) {
    try { return localStorage.getItem(key); } catch (_) { return null; }
  }

  function resolveExperience(network, runtime) {
    const params = new URLSearchParams(location.search);
    const values = [
      params.get('experience'),
      storageValue(`transit.learn.experience.${network}`),
      runtime?.learnExperience?.defaults?.[network],
      fallback(network),
    ];
    return values.find(value => profiles.has(value)) || fallback(network);
  }

  function saveExperience(network, profile) {
    if (!profiles.has(profile)) return false;
    try {
      localStorage.setItem(`transit.learn.experience.${network}`, profile);
      return true;
    } catch (_) {
      return false;
    }
  }

  class PublicLearnExperience {
    constructor({app, renderer, realMapRenderer, network}) {
      this.app = app;
      this.renderer = renderer;
      this.realMapRenderer = realMapRenderer;
      this.network = network;
      this.profile = fallback(network);
      this.suspended = false;
      this.lastJourneyProgress = null;
      this.token = 0;
      this.setProfile(this.profile);
      this.setFace('overview');
    }

    setProfile(profile) {
      this.profile = profiles.has(profile) ? profile : fallback(this.network);
      this.lastJourneyProgress = null;
      this.app.dataset.experience = this.profile;
      return this.profile;
    }

    setFace(face) { this.app.dataset.face = face; }

    async enterRoute(frame) {
      this.setFace('route');
      if (this.profile === 'immersive') this.renderer.fitImmersive(frame?.routeProgress || 0, {reverse: frame?.direction === 'reverse', strong: false});
      else this.renderer.fitFullRoute({practiceVisible: false});
    }

    async enterPractice(frame) {
      this.lastJourneyProgress = Number(frame?.routeProgress) || 0;
      if (this.profile === 'immersive') this.renderer.fitImmersive(frame?.routeProgress || 0, {reverse: frame?.direction === 'reverse', strong: true, practiceVisible: true});
      else this.renderer.fitFullRoute({practiceVisible: true});
    }

    updateJourney(frame) {
      if (this.profile !== 'immersive' || frame?.mapMode !== 'flat' || !frame?.journeyActive) return;
      const progress = Number(frame.routeProgress) || 0;
      const moved = this.lastJourneyProgress == null || Math.abs(progress - this.lastJourneyProgress) > 1e-7;
      this.lastJourneyProgress = progress;
      if (!moved) return;
      this.suspended = false;
      this.renderer.followJourney(progress, frame.direction === 'reverse');
    }

    async arrive(frame) {
      if (this.profile !== 'immersive') return;
      this.renderer.showArrivalPulse(frame?.arrivedOriginalIndex ?? frame?.currentOriginalIndex);
      await delay(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 40 : 140);
    }

    leavePractice() {
      this.lastJourneyProgress = null;
      this.renderer.fitFullRoute({practiceVisible: false});
    }

    async returnOverview() {
      const token = ++this.token;
      this.realMapRenderer?.hide?.();
      this.lastJourneyProgress = null;
      this.renderer.fitFullRoute({practiceVisible: false});
      if (this.profile === 'immersive') await delay(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 0 : 360);
      if (token !== this.token) return false;
      this.setFace('overview');
      if (this.profile === 'immersive') await delay(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 0 : 520);
      return token === this.token;
    }

    suspendForManualNavigation() { this.suspended = true; }
    resumeOnJourneyMotion() { this.suspended = false; }
    destroy() { this.token += 1; }
  }

  Z.EXPERIENCE_PROFILES = ['standard', 'immersive'];
  Z.resolveExperienceProfile = resolveExperience;
  Z.saveExperienceProfile = saveExperience;
  Z.PublicLearnExperience = PublicLearnExperience;
})();
