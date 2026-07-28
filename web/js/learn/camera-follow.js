const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));
const mix = (start, end, ratio) => start + (end - start) * ratio;

export const DEFAULT_CAMERA_OPTIONS = Object.freeze({
  anchorX: 0.48,
  anchorY: 0.42,
  lookAheadMix: 0.30,
  deadZoneX: 0.19,
  deadZoneY: 0.16,
  stiffnessMin: 52,
  stiffnessMax: 128,
  dampingRatio: 0.92,
  settlePositionRatio: 0.00012,
  settleVelocity: 0.012,
});

export const BUS_IMMERSIVE_LIMITS = Object.freeze({
  minStations: 2,
  maxStationsForStrongZoom: 80,
  maxPathPointsForLiveFollow: 6000,
});

function smoothstep(value) {
  const ratio = clamp(value, 0, 1);
  return ratio * ratio * (3 - 2 * ratio);
}

export function cameraTargetForPoint(view, point, ahead = point, {force = false, ...overrides} = {}) {
  if (!view || !point || !ahead || view.w <= 0 || view.h <= 0) return null;
  const options = {...DEFAULT_CAMERA_OPTIONS, ...overrides};
  const screenX = (point[0] - view.x) / view.w;
  const screenY = (point[1] - view.y) / view.h;
  const normalizedX = Math.abs(screenX - options.anchorX) / options.deadZoneX;
  const normalizedY = Math.abs(screenY - options.anchorY) / options.deadZoneY;
  const edge = Math.max(normalizedX, normalizedY);
  const strength = force ? 1 : smoothstep((edge - .38) / .72);
  if (strength < .015) return null;
  const lookX = mix(point[0], ahead[0], options.lookAheadMix);
  const lookY = mix(point[1], ahead[1], options.lookAheadMix);
  const idealX = lookX - view.w * options.anchorX;
  const idealY = lookY - view.h * options.anchorY;
  return {
    x: mix(view.x, idealX, .18 + .82 * strength),
    y: mix(view.y, idealY, .18 + .82 * strength),
    w: view.w,
    h: view.h,
    strength,
  };
}

export function springCameraStep(view, velocity, target, deltaSeconds, options = DEFAULT_CAMERA_OPTIONS) {
  const dt = clamp(deltaSeconds, .001, .034);
  const dx = target.x - view.x;
  const dy = target.y - view.y;
  const distance = Math.hypot(dx / Math.max(1, view.w), dy / Math.max(1, view.h));
  const stiffness = mix(options.stiffnessMin, options.stiffnessMax, clamp(distance / .28, 0, 1));
  const damping = 2 * Math.sqrt(stiffness) * options.dampingRatio;
  const nextVelocity = {
    x: velocity.x + (dx * stiffness - velocity.x * damping) * dt,
    y: velocity.y + (dy * stiffness - velocity.y * damping) * dt,
  };
  const nextView = {...view, x: view.x + nextVelocity.x * dt, y: view.y + nextVelocity.y * dt};
  const settled = Math.abs(dx) < view.w * options.settlePositionRatio
    && Math.abs(dy) < view.h * options.settlePositionRatio
    && Math.abs(nextVelocity.x) < options.settleVelocity
    && Math.abs(nextVelocity.y) < options.settleVelocity;
  return {view: settled ? {...target} : nextView, velocity: settled ? {x: 0, y: 0} : nextVelocity, settled};
}

export class CameraFollowController {
  constructor({renderer, reducedMotion = false, options = {}, requestFrame, cancelFrame, now} = {}) {
    this.renderer = renderer;
    this.reducedMotion = Boolean(reducedMotion);
    this.options = {...DEFAULT_CAMERA_OPTIONS, ...options};
    this.requestFrame = requestFrame || (callback => requestAnimationFrame(callback));
    this.cancelFrame = cancelFrame || (frame => cancelAnimationFrame(frame));
    this.now = now || (() => performance.now());
    this.frame = 0;
    this.lastAt = 0;
    this.target = null;
    this.velocity = {x: 0, y: 0};
    this.suspended = false;
    this.destroyed = false;
  }

  update({progress, reverse = false, force = false, distanceHint} = {}) {
    if (this.destroyed || this.suspended || !Number.isFinite(progress)) return false;
    const point = this.renderer?.pointAtProgress?.(progress);
    const ahead = this.renderer?.pointAhead?.(progress, reverse, distanceHint) || point;
    const target = cameraTargetForPoint(this.renderer?.getView?.(), point, ahead, {...this.options, force});
    if (!target) return false;
    this.target = {x: target.x, y: target.y, w: target.w, h: target.h};
    if (this.reducedMotion) {
      this.renderer.setView(this.target, {commit: true, animate: false});
      this.target = null;
      return true;
    }
    if (!this.frame) {
      this.lastAt = this.now();
      this.frame = this.requestFrame(timestamp => this.step(timestamp));
    }
    return true;
  }

  step(timestamp) {
    this.frame = 0;
    if (this.destroyed || this.suspended || !this.target) return;
    const current = this.renderer.getView();
    const elapsed = (timestamp - (this.lastAt || timestamp)) / 1000;
    this.lastAt = timestamp;
    const result = springCameraStep(current, this.velocity, this.target, elapsed, this.options);
    this.velocity = result.velocity;
    this.renderer.setView(result.view, {commit: result.settled, animate: false});
    if (result.settled) {
      this.target = null;
      this.lastAt = 0;
      return;
    }
    this.frame = this.requestFrame(next => this.step(next));
  }

  suspend() {
    this.suspended = true;
    this.stop();
  }

  resume() { this.suspended = false; }

  stop() {
    if (this.frame) this.cancelFrame(this.frame);
    this.frame = 0;
    this.lastAt = 0;
    this.target = null;
    this.velocity = {x: 0, y: 0};
  }

  destroy() {
    this.destroyed = true;
    this.stop();
  }
}
