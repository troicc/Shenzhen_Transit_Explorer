import {BUS_IMMERSIVE_LIMITS, CameraFollowController} from './camera-follow.js';
import {
  experienceCapabilities,
  fallbackExperienceProfile,
  normalizeExperienceProfile,
} from './experience-profile.js';
import {completionSpring} from './route-stretch.js';

const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

export class LearnExperience {
  constructor({
    profile,
    network,
    appElement,
    flipScene,
    focusRenderer,
    overviewRenderer,
    realMapRenderer,
    stretchController,
    reducedMotion = false,
  } = {}) {
    this.network = network;
    this.appElement = appElement;
    this.flipScene = flipScene;
    this.focusRenderer = focusRenderer;
    this.overviewRenderer = overviewRenderer;
    this.realMapRenderer = realMapRenderer;
    this.stretchController = stretchController;
    this.reducedMotion = Boolean(reducedMotion);
    this.profile = null;
    this.camera = null;
    this.lastJourneyProgress = null;
    this.returnToken = 0;
    this.coverFlipped = false;
    this.lineState = 'overview';
    this.setProfile(profile);
    this.setCoverFlipped(this.network === 'metro' && this.capabilities.coverFlip);
  }

  setProfile(profile) {
    const next = normalizeExperienceProfile(profile, this.network) || fallbackExperienceProfile(this.network);
    this.camera?.destroy();
    this.camera = null;
    this.lastJourneyProgress = null;
    this.profile = next;
    this.capabilities = experienceCapabilities(next, this.network);
    if (this.capabilities.cameraFollow) {
      const pathCount = this.focusRenderer?.geometry?.path?.length || 0;
      const options = this.network === 'bus' && pathCount > BUS_IMMERSIVE_LIMITS.maxPathPointsForLiveFollow
        ? {lookAheadMix: .16, stiffnessMax: 92}
        : {};
      this.camera = new CameraFollowController({renderer: this.focusRenderer, reducedMotion: this.reducedMotion, options});
    }
    if (this.appElement) this.appElement.dataset.experience = next;
    if (!this.focusRenderer?.route && !this.capabilities.coverFlip) this.setCoverFlipped(false);
    return next;
  }

  has(capability) { return Boolean(this.capabilities?.[capability]); }

  setFace(face) {
    if (this.flipScene) this.flipScene.dataset.face = face;
  }

  setCoverFlipped(flipped) {
    this.coverFlipped = Boolean(flipped);
    if (this.appElement) this.appElement.dataset.coverFlipped = String(this.coverFlipped);
    this.overviewRenderer?.setFlipped?.(this.coverFlipped);
  }

  setLineState(value) {
    this.lineState = value;
    if (this.appElement) this.appElement.dataset.lineState = value;
  }

  async enterRoute(frame) {
    const token = ++this.returnToken;
    const wasFlipped = this.coverFlipped;
    this.setLineState('entering');
    this.setFace('route');
    this.overviewRenderer?.setFocused?.(true, frame?.routeId);
    this.stretchController?.setRoute?.(frame?.route, this.focusRenderer?.sourceGeometry || this.focusRenderer?.geometry);
    if (this.capabilities.coverFlip) {
      this.setCoverFlipped(false);
      if (wasFlipped && !this.reducedMotion) await wait(420);
    }
    if (token !== this.returnToken) return false;
    if (this.capabilities.routeStretch) {
      const strong = this.network !== 'bus' || (frame?.route?.stops?.length || 0) <= BUS_IMMERSIVE_LIMITS.maxStationsForStrongZoom;
      const targetGeometry = this.stretchController?.geometryAt?.(1) || this.focusRenderer.geometry;
      this.appElement?.classList.add('route-stretching');
      await Promise.all([
        this.stretchController?.animateTo?.(1, {duration: 920}) || Promise.resolve(),
        this.focusRenderer.fitImmersive(frame?.routeProgress || 0, {
          reverse: frame?.direction === 'reverse', strong, geometry: targetGeometry, animate: true, duration: 920,
        }),
      ]);
      this.appElement?.classList.remove('route-stretching');
    } else {
      await this.stretchController?.reset?.({duration: 0});
      await this.focusRenderer.fitFullRoute({practiceVisible: false, animate: true, duration: 430});
    }
    this.setLineState('selected');
    return token === this.returnToken;
  }

  async enterPractice(frame) {
    this.lastJourneyProgress = Number(frame?.routeProgress) || 0;
    if (!this.capabilities.cameraFollow) {
      await this.focusRenderer.fitFullRoute({practiceVisible: true, animate: true, duration: 430});
      return;
    }
    const targetGeometry = this.capabilities.routeStretch
      ? this.stretchController?.geometryAt?.(1) || this.focusRenderer.geometry
      : this.focusRenderer.geometry;
    if (this.capabilities.routeStretch && this.stretchController?.progress < .999) {
      await this.stretchController.animateTo(1, {duration: 620});
    }
    await this.focusRenderer.fitImmersive(frame?.routeProgress || 0, {
      reverse: frame?.direction === 'reverse', strong: true, practiceVisible: true,
      geometry: targetGeometry, animate: true, duration: 720,
    });
    this.camera?.resume();
    this.camera?.update({progress: frame?.routeProgress || 0, reverse: frame?.direction === 'reverse', force: true});
  }

  updateJourney(frame) {
    if (!this.capabilities.cameraFollow || frame?.mapMode !== 'flat' || !frame?.journeyActive) return;
    const progress = Number(frame.routeProgress) || 0;
    const moved = this.lastJourneyProgress == null
      || Math.abs(progress - this.lastJourneyProgress) > 1e-7
      || Boolean(frame.forceCamera);
    this.lastJourneyProgress = progress;
    if (!moved) return;
    this.resumeOnJourneyMotion();
    this.camera?.update({
      progress,
      reverse: frame.direction === 'reverse',
      force: Boolean(frame.forceCamera),
      distanceHint: frame.route?.stops?.length,
    });
  }

  async arrive(frame) {
    if (!this.capabilities.arrivalPulse) return;
    const index = frame?.targetOriginalIndex
      ?? frame?.arrivedOriginalIndex
      ?? frame?.currentOriginalIndex;
    this.focusRenderer.showArrivalPulse(index);
    if (frame?.mapMode === 'flat') {
      this.camera?.update({progress: frame.routeProgress, reverse: frame.direction === 'reverse', force: true});
    }
    await wait(this.reducedMotion ? 60 : 170);
  }

  leavePractice() {
    this.lastJourneyProgress = null;
    this.camera?.stop();
    return this.focusRenderer.fitFullRoute({practiceVisible: false, animate: true, duration: 560});
  }

  async completeLine(frame) {
    this.camera?.stop();
    this.lastJourneyProgress = null;
    this.setLineState('completing');
    if (!this.capabilities.completionRebound) {
      await this.focusRenderer.fitFullRoute({practiceVisible: true, animate: true, duration: 560});
      this.setLineState('completed');
      return true;
    }
    this.appElement?.classList.add('line-completing');
    const source = this.stretchController?.source || this.focusRenderer.sourceGeometry || this.focusRenderer.geometry;
    await Promise.all([
      this.stretchController?.animateTo?.(0, {duration: 1180, easing: value => 1 - Math.pow(1 - value, 4)}) || Promise.resolve(),
      this.focusRenderer.fitFullRoute({
        practiceVisible: true,
        geometry: source,
        animate: true,
        duration: 1180,
        easing: completionSpring,
      }),
    ]);
    this.appElement?.classList.remove('line-completing');
    this.camera?.stop();
    this.setLineState('completed');
    return true;
  }

  async returnOverview() {
    const token = ++this.returnToken;
    this.camera?.stop();
    this.lastJourneyProgress = null;
    this.realMapRenderer?.hide?.();
    this.setLineState('returning');
    this.appElement?.classList.add('route-returning');
    const source = this.stretchController?.source || this.focusRenderer.sourceGeometry || this.focusRenderer.geometry;
    await Promise.all([
      this.stretchController?.animateTo?.(0, {duration: this.capabilities.routeStretch ? 860 : 0}) || Promise.resolve(),
      this.focusRenderer.fitFullRoute({
        practiceVisible: false,
        geometry: source,
        animate: true,
        duration: this.capabilities.routeStretch ? 860 : 360,
      }),
    ]);
    if (token !== this.returnToken) return false;
    this.overviewRenderer?.setFocused?.(false, null);
    this.focusRenderer?.resetDisplayGeometry?.();
    if (this.overviewRenderer?.homeView) this.overviewRenderer.setView?.(this.overviewRenderer.homeView);
    this.setFace('overview');
    if (this.capabilities.coverFlip) {
      if (!this.reducedMotion) await wait(80);
      this.setCoverFlipped(true);
      if (!this.reducedMotion) await wait(560);
    }
    this.appElement?.classList.remove('route-returning');
    this.setLineState('overview');
    return token === this.returnToken;
  }

  suspendForManualNavigation() { this.camera?.suspend(); }

  resumeOnJourneyMotion() { this.camera?.resume(); }

  destroy() {
    ++this.returnToken;
    this.camera?.destroy();
    this.camera = null;
    this.stretchController?.destroy?.();
  }
}
