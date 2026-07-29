import {BUS_IMMERSIVE_LIMITS, CameraFollowController} from './camera-follow.js';
import {
  experienceCapabilities,
  fallbackExperienceProfile,
  normalizeExperienceProfile,
} from './experience-profile.js';
import {completionSpring} from './route-stretch.js';

const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const clamp01 = value => Math.max(0, Math.min(1, Number(value) || 0));
const frameNow = () => globalThis.performance?.now?.() ?? Date.now();
const requestFrame = callback => globalThis.requestAnimationFrame?.(callback)
  ?? setTimeout(() => callback(frameNow()), 16);
const cancelFrame = frame => {
  if (globalThis.cancelAnimationFrame) globalThis.cancelAnimationFrame(frame);
  else clearTimeout(frame);
};
const lerp = (start, end, ratio) => start + (end - start) * ratio;
const COVER_FLIP_SETTLE_MS = 780;
const METRO_RETURN_CARDS_MS = 300;
const METRO_RETURN_MERGE_MS = 1040;
const METRO_RETURN_DISSOLVE_MS = 300;
const METRO_RETURN_FLIP_PREPARE_MS = 80;
const METRO_RETURN_CARD_EASING = 'cubic-bezier(.2,.78,.2,1)';

// Acknowledge the double click immediately, then decelerate gently into the network.
export function returnMergeEase(value) {
  const ratio = clamp01(value);
  return 1 - Math.pow(1 - ratio, 4);
}

export function resolveArrivalPulseIndex(frame) {
  if (frame?.phase !== 'arriving') return null;
  return Number.isInteger(frame?.arrivalOriginalIndex) ? frame.arrivalOriginalIndex : null;
}

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
    cameraMode = 'follow',
    reducedMotion = false,
    waitForAnimation = wait,
    requestAnimation = requestFrame,
    cancelAnimation = cancelFrame,
    now = frameNow,
  } = {}) {
    this.network = network;
    this.appElement = appElement;
    this.flipScene = flipScene;
    this.focusRenderer = focusRenderer;
    this.overviewRenderer = overviewRenderer;
    this.realMapRenderer = realMapRenderer;
    this.stretchController = stretchController;
    this.reducedMotion = Boolean(reducedMotion);
    this.waitForAnimation = typeof waitForAnimation === 'function' ? waitForAnimation : wait;
    this.requestAnimation = typeof requestAnimation === 'function' ? requestAnimation : requestFrame;
    this.cancelAnimation = typeof cancelAnimation === 'function' ? cancelAnimation : cancelFrame;
    this.now = typeof now === 'function' ? now : frameNow;
    this.profile = null;
    this.camera = null;
    this.lastJourneyProgress = null;
    this.returnToken = 0;
    this.returnFrame = 0;
    this.returnPreviewNodes = null;
    this.returnCardAnimation = null;
    this.returnCardDock = null;
    this.coverFlipped = false;
    this.lineState = 'overview';
    this.cameraMode = cameraMode === 'full' ? 'full' : 'follow';
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

  setCameraMode(mode) {
    this.cameraMode = mode === 'full' ? 'full' : 'follow';
    if (this.cameraMode === 'full') {
      this.camera?.stop();
      this.lastJourneyProgress = null;
    }
    return this.cameraMode;
  }

  usesFollowCamera(frame) {
    return Boolean(
      this.capabilities?.cameraFollow
      && this.cameraMode === 'follow'
      && frame?.mapMode === 'flat'
    );
  }

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

  async waitForCoverFlip() {
    if (this.reducedMotion) return;
    await this.waitForAnimation(COVER_FLIP_SETTLE_MS);
  }

  returnCardDockElement() {
    return this.appElement?.querySelector?.('.line-info-dock') || null;
  }

  cancelReturnCardClose({reset = true} = {}) {
    this.returnCardAnimation?.cancel?.();
    this.returnCardAnimation = null;
    const dock = this.returnCardDock || this.returnCardDockElement();
    if (dock && reset) {
      dock.style?.removeProperty?.('opacity');
      dock.style?.removeProperty?.('transform');
      dock.style?.removeProperty?.('pointer-events');
      dock.style?.removeProperty?.('transition');
    }
    this.returnCardDock = null;
  }

  async closeReturnCards(token) {
    const dock = this.returnCardDockElement();
    if (!dock) return token === this.returnToken;

    this.cancelReturnCardClose();
    this.returnCardDock = dock;
    dock.style?.setProperty?.('pointer-events', 'none');

    const targetTransform = 'translateX(-50%) translateY(18px) scale(.965)';
    if (this.reducedMotion) {
      dock.style?.setProperty?.('opacity', '0');
      dock.style?.setProperty?.('transform', targetTransform);
      return token === this.returnToken;
    }

    if (typeof dock.animate === 'function') {
      const animation = dock.animate([
        {opacity: 1, transform: 'translateX(-50%) translateY(0) scale(1)'},
        {opacity: 0, transform: targetTransform},
      ], {
        duration: METRO_RETURN_CARDS_MS,
        easing: METRO_RETURN_CARD_EASING,
        fill: 'forwards',
      });
      this.returnCardAnimation = animation;
      try {
        await animation.finished;
      } catch (_) {
        return false;
      }
      return token === this.returnToken;
    }

    dock.style?.setProperty?.(
      'transition',
      `opacity ${METRO_RETURN_CARDS_MS}ms ${METRO_RETURN_CARD_EASING}, transform ${METRO_RETURN_CARDS_MS}ms ${METRO_RETURN_CARD_EASING}`,
    );
    dock.style?.setProperty?.('opacity', '0');
    dock.style?.setProperty?.('transform', targetTransform);
    await this.waitForAnimation(METRO_RETURN_CARDS_MS);
    return token === this.returnToken;
  }

  cancelReturnMergePreview() {
    if (this.returnFrame) this.cancelAnimation(this.returnFrame);
    this.returnFrame = 0;
    const nodes = this.returnPreviewNodes;
    nodes?.mapStage?.removeAttribute?.('transform');
    nodes?.focusScene?.removeAttribute?.('transform');
    this.returnPreviewNodes = null;
  }

  metroReturnPreview(homeView) {
    if (this.network !== 'metro' || !this.capabilities?.coverFlip || !homeView) return null;
    const mapStage = this.overviewRenderer?.mapFlipStage;
    const focusScene = this.focusRenderer?.svg?.querySelector?.('#focusSceneLayer');
    const currentView = this.focusRenderer?.getView?.();
    const geometry = this.stretchController?.geometry || this.focusRenderer?.geometry;
    const center = geometry?.displayCenter;
    const displayScale = Number(geometry?.displayScale) || 1;
    if (!mapStage || !focusScene || !currentView || !center || displayScale <= 0) return null;

    const mapScaleX = Number(currentView.w) / Math.max(.0001, Number(homeView.w));
    const mapScaleY = Number(currentView.h) / Math.max(.0001, Number(homeView.h));
    const mapTranslateX = Number(currentView.x) - Number(homeView.x) * mapScaleX;
    const mapTranslateY = Number(currentView.y) - Number(homeView.y) * mapScaleY;
    const focusScale = 1 / displayScale;
    const focusTranslateX = Number(center[0]) * (1 - focusScale);
    const focusTranslateY = Number(center[1]) * (1 - focusScale);

    return {
      mapStage,
      focusScene,
      mapScaleX,
      mapScaleY,
      mapTranslateX,
      mapTranslateY,
      focusScale,
      focusTranslateX,
      focusTranslateY,
    };
  }

  animateMetroReturnMerge(token, preview, duration = METRO_RETURN_MERGE_MS) {
    if (!preview || this.reducedMotion || duration <= 0) return Promise.resolve(Boolean(preview));
    this.cancelReturnMergePreview();
    this.returnPreviewNodes = preview;
    const startedAt = this.now();
    return new Promise(resolve => {
      const step = timestamp => {
        if (token !== this.returnToken) {
          this.cancelReturnMergePreview();
          resolve(false);
          return;
        }
        const raw = clamp01((timestamp - startedAt) / duration);
        const eased = returnMergeEase(raw);
        const mapScaleX = lerp(1, preview.mapScaleX, eased);
        const mapScaleY = lerp(1, preview.mapScaleY, eased);
        const mapTranslateX = preview.mapTranslateX * eased;
        const mapTranslateY = preview.mapTranslateY * eased;
        const focusScale = lerp(1, preview.focusScale, eased);
        const focusTranslateX = preview.focusTranslateX * eased;
        const focusTranslateY = preview.focusTranslateY * eased;
        preview.mapStage.setAttribute(
          'transform',
          `matrix(${mapScaleX} 0 0 ${mapScaleY} ${mapTranslateX} ${mapTranslateY})`,
        );
        preview.focusScene.setAttribute(
          'transform',
          `matrix(${focusScale} 0 0 ${focusScale} ${focusTranslateX} ${focusTranslateY})`,
        );
        if (raw < 1) this.returnFrame = this.requestAnimation(step);
        else {
          this.returnFrame = 0;
          resolve(true);
        }
      };
      this.returnFrame = this.requestAnimation(step);
    });
  }

  commitMetroReturnMerge(homeView) {
    this.stretchController?.apply?.(0);
    this.focusRenderer?.setView?.(homeView, {animate: false});
    this.overviewRenderer?.setView?.(homeView);
    this.returnPreviewNodes?.focusScene?.removeAttribute?.('transform');
    this.returnPreviewNodes = null;
  }

  async enterRoute(frame) {
    const token = ++this.returnToken;
    this.cancelReturnCardClose();
    this.cancelReturnMergePreview();
    const wasFlipped = this.coverFlipped;
    this.appElement?.classList.remove('route-returning');
    this.setLineState('entering');
    this.setFace('route');
    this.overviewRenderer?.setFocused?.(true, frame?.routeId);
    this.stretchController?.setRoute?.(frame?.route, this.focusRenderer?.sourceGeometry || this.focusRenderer?.geometry);
    if (this.capabilities.coverFlip) {
      this.setCoverFlipped(false);
      if (wasFlipped) await this.waitForCoverFlip();
    }
    if (token !== this.returnToken) return false;
    if (this.capabilities.routeStretch) {
      const strong = this.network !== 'bus' || (frame?.route?.stops?.length || 0) <= BUS_IMMERSIVE_LIMITS.maxStationsForStrongZoom;
      const targetGeometry = this.stretchController?.geometryAt?.(1) || this.focusRenderer.geometry;
      this.appElement?.classList.add('route-stretching');
      try {
        await Promise.all([
          this.stretchController?.animateTo?.(1, {duration: 920}) || Promise.resolve(),
          this.usesFollowCamera(frame)
            ? this.focusRenderer.fitImmersive(frame?.routeProgress || 0, {
              reverse: frame?.direction === 'reverse', strong, geometry: targetGeometry, animate: true, duration: 920,
            })
            : this.focusRenderer.fitFullRoute({
              practiceVisible: false, geometry: targetGeometry, animate: true, duration: 920,
            }),
        ]);
      } finally {
        this.appElement?.classList.remove('route-stretching');
      }
    } else {
      await this.stretchController?.reset?.({duration: 0});
      await this.focusRenderer.fitFullRoute({practiceVisible: false, animate: true, duration: 430});
    }
    if (token !== this.returnToken) return false;
    this.setLineState('selected');
    return true;
  }

  async enterPractice(frame) {
    this.lastJourneyProgress = Number(frame?.routeProgress) || 0;
    if (this.capabilities.routeStretch && this.stretchController?.progress < .999) {
      await this.stretchController.animateTo(1, {duration: 620});
    }
    await this.reframe(frame, {practiceVisible: true, animate: true});
  }

  async reframe(frame, {practiceVisible = false, animate = true} = {}) {
    const targetGeometry = this.focusRenderer?.geometry;
    if (this.usesFollowCamera(frame)) {
      await this.focusRenderer.fitImmersive(frame?.routeProgress || 0, {
        reverse: frame?.direction === 'reverse',
        strong: practiceVisible || this.network === 'metro',
        practiceVisible,
        geometry: targetGeometry,
        animate,
        duration: animate ? 720 : 0,
      });
      if (frame?.journeyActive) {
        this.camera?.resume();
        this.camera?.update({
          progress: frame?.routeProgress || 0,
          reverse: frame?.direction === 'reverse',
          force: true,
        });
      }
      return true;
    }
    this.camera?.stop();
    await this.focusRenderer.fitFullRoute({
      practiceVisible,
      geometry: targetGeometry,
      animate,
      duration: animate ? 520 : 0,
    });
    return true;
  }

  updateJourney(frame) {
    if (!this.usesFollowCamera(frame) || !frame?.journeyActive) return;
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
    if (!this.capabilities.arrivalPulse) return false;
    const index = resolveArrivalPulseIndex(frame);
    if (index == null) return false;
    this.focusRenderer.showArrivalPulse(index);
    if (this.usesFollowCamera(frame) && !frame.stationaryArrival) {
      this.camera?.update({progress: frame.routeProgress, reverse: frame.direction === 'reverse', force: true});
    }
    await wait(this.reducedMotion ? 60 : 170);
    return true;
  }

  leavePractice(frame) {
    this.lastJourneyProgress = null;
    this.camera?.stop();
    return this.reframe(frame, {practiceVisible: false, animate: true});
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
    this.cancelReturnCardClose();
    this.cancelReturnMergePreview();
    this.camera?.stop();
    this.lastJourneyProgress = null;
    this.realMapRenderer?.hide?.();

    // Phase 1: close the information dock completely before any map movement.
    // The WAAPI animation deliberately overrides the stronger focused CSS rule.
    this.setLineState('closing');
    this.appElement?.classList.add('route-returning');

    // Freeze any entry/follow animation at its current visual state while the
    // cards leave. No route, camera or flip movement starts in this phase.
    this.stretchController?.cancel?.();
    this.focusRenderer?.cancelViewAnimation?.();
    const cardsClosed = await this.closeReturnCards(token);
    if (!cardsClosed || token !== this.returnToken) return false;

    // Phase 2: transactionally merge the enlarged route into the overview.
    this.setLineState('merging');
    this.appElement?.classList.add('route-stretching');
    const source = this.stretchController?.source || this.focusRenderer.sourceGeometry || this.focusRenderer.geometry;
    const homeView = this.overviewRenderer?.homeView ? {...this.overviewRenderer.homeView} : null;
    const preview = this.metroReturnPreview(homeView);

    try {
      if (preview) {
        const merged = await this.animateMetroReturnMerge(token, preview);
        if (!merged || token !== this.returnToken) return false;
        this.commitMetroReturnMerge(homeView);
      } else {
        const returnDuration = this.capabilities.routeStretch ? 980 : 420;
        await Promise.all([
          this.stretchController?.animateTo?.(0, {
            duration: this.capabilities.routeStretch ? returnDuration : 0,
            easing: returnMergeEase,
          }) || Promise.resolve(),
          homeView
            ? this.focusRenderer.setView(homeView, {
              animate: true,
              duration: returnDuration,
              easing: returnMergeEase,
            })
            : this.focusRenderer.fitFullRoute({
              practiceVisible: false,
              geometry: source,
              animate: true,
              duration: returnDuration,
              easing: returnMergeEase,
            }),
        ]);
      }
    } finally {
      this.appElement?.classList.remove('route-stretching');
    }

    if (token !== this.returnToken) return false;

    // The focus route now lands on the same pixels as its original overview
    // route. Reveal the complete network and dissolve the duplicate focus layer.
    this.overviewRenderer?.setFocused?.(false, null);
    this.focusRenderer?.resetDisplayGeometry?.();
    if (homeView) this.overviewRenderer?.setView?.(homeView);
    this.appElement?.classList.remove('focused');
    this.setFace('overview');

    // Phase 3: only the settled complete network is allowed to flip.
    if (this.capabilities.coverFlip) {
      if (!this.reducedMotion) await this.waitForAnimation(METRO_RETURN_DISSOLVE_MS);
      if (token !== this.returnToken) return false;
      this.setLineState('returning');
      if (!this.reducedMotion) await this.waitForAnimation(METRO_RETURN_FLIP_PREPARE_MS);
      this.setCoverFlipped(true);
      await this.waitForCoverFlip();
    }

    this.appElement?.classList.remove('route-returning');
    this.cancelReturnCardClose();
    this.setLineState('overview');
    return token === this.returnToken;
  }

  suspendForManualNavigation() { this.camera?.suspend(); }

  resumeOnJourneyMotion() { this.camera?.resume(); }

  destroy() {
    ++this.returnToken;
    this.cancelReturnCardClose();
    this.cancelReturnMergePreview();
    this.camera?.destroy();
    this.camera = null;
    this.stretchController?.destroy?.();
  }
}
