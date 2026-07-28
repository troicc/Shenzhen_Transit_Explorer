import {BUS_IMMERSIVE_LIMITS, CameraFollowController} from './camera-follow.js';
import {VALID_PROFILES} from './experience-profile.js';

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
    reducedMotion = false,
  } = {}) {
    this.network = network;
    this.appElement = appElement;
    this.flipScene = flipScene;
    this.focusRenderer = focusRenderer;
    this.overviewRenderer = overviewRenderer;
    this.realMapRenderer = realMapRenderer;
    this.reducedMotion = Boolean(reducedMotion);
    this.profile = null;
    this.camera = null;
    this.lastJourneyProgress = null;
    this.returnToken = 0;
    this.setProfile(profile);
  }

  setProfile(profile) {
    const next = VALID_PROFILES.has(profile) ? profile : (this.network === 'metro' ? 'immersive' : 'standard');
    this.camera?.destroy();
    this.camera = null;
    this.lastJourneyProgress = null;
    this.profile = next;
    if (next === 'immersive') {
      const pathCount = this.focusRenderer?.geometry?.path?.length || 0;
      const options = this.network === 'bus' && pathCount > BUS_IMMERSIVE_LIMITS.maxPathPointsForLiveFollow
        ? {lookAheadMix: .16, stiffnessMax: 92}
        : {};
      this.camera = new CameraFollowController({renderer: this.focusRenderer, reducedMotion: this.reducedMotion, options});
    }
    if (this.appElement) this.appElement.dataset.experience = next;
    return next;
  }

  setFace(face) {
    if (this.flipScene) this.flipScene.dataset.face = face;
  }

  async enterRoute(frame) {
    const token = ++this.returnToken;
    this.setFace('route');
    if (this.profile === 'immersive') {
      const strong = this.network !== 'bus' || (frame?.route?.stops?.length || 0) <= BUS_IMMERSIVE_LIMITS.maxStationsForStrongZoom;
      await this.focusRenderer.fitImmersive(frame?.routeProgress || 0, {reverse: frame?.direction === 'reverse', strong, animate: true, duration: 680});
    } else {
      await this.focusRenderer.fitFullRoute({practiceVisible: false, animate: true, duration: 430});
    }
    return token === this.returnToken;
  }

  async enterPractice(frame) {
    this.lastJourneyProgress = Number(frame?.routeProgress) || 0;
    if (this.profile !== 'immersive') {
      await this.focusRenderer.fitFullRoute({practiceVisible: true, animate: true, duration: 430});
      return;
    }
    await this.focusRenderer.fitImmersive(frame?.routeProgress || 0, {reverse: frame?.direction === 'reverse', strong: true, practiceVisible: true, animate: true, duration: 720});
    this.camera?.resume();
    this.camera?.update({progress: frame?.routeProgress || 0, reverse: frame?.direction === 'reverse', force: true});
  }

  updateJourney(frame) {
    if (this.profile !== 'immersive' || frame?.mapMode !== 'flat' || !frame?.journeyActive) return;
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
    if (this.profile !== 'immersive') return;
    const index = frame?.arrivedOriginalIndex ?? frame?.currentOriginalIndex;
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

  async returnOverview() {
    const token = ++this.returnToken;
    this.camera?.stop();
    this.lastJourneyProgress = null;
    this.realMapRenderer?.hide?.();
    await this.focusRenderer.fitFullRoute({practiceVisible: false, animate: true, duration: this.profile === 'immersive' ? 620 : 360});
    if (token !== this.returnToken) return false;
    this.setFace('overview');
    if (this.profile === 'immersive' && !this.reducedMotion) await wait(560);
    return token === this.returnToken;
  }

  suspendForManualNavigation() { this.camera?.suspend(); }

  resumeOnJourneyMotion() { this.camera?.resume(); }

  destroy() {
    ++this.returnToken;
    this.camera?.destroy();
    this.camera = null;
  }
}
