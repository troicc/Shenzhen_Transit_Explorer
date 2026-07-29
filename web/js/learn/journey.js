const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));

export const JOURNEY_PHASES = Object.freeze(['idle', 'typing', 'arriving', 'completed']);

export class JourneyState {
  constructor() {
    this.reset();
  }

  reset(stopCount = 0) {
    this.stopCount = Math.max(0, Number(stopCount) || 0);
    this.arrivedIndex = this.stopCount ? 0 : null;
    this.targetIndex = this.stopCount > 1 ? 1 : null;
    this.typingRatio = 0;
    this.phase = this.targetIndex == null ? 'completed' : 'idle';
    return this.snapshot();
  }

  setTypingRatio(value) {
    if (this.targetIndex == null || this.phase === 'completed') return this.snapshot();
    this.typingRatio = clamp(Number(value) || 0, 0, 1);
    this.phase = this.typingRatio > 0 ? 'typing' : 'idle';
    return this.snapshot();
  }

  beginArrival() {
    if (this.targetIndex == null || this.phase === 'completed') return false;
    this.typingRatio = 1;
    this.phase = 'arriving';
    return true;
  }

  completeArrival() {
    if (this.targetIndex == null) return this.snapshot();
    this.arrivedIndex = this.targetIndex;
    this.targetIndex = this.arrivedIndex + 1 < this.stopCount ? this.arrivedIndex + 1 : null;
    this.typingRatio = 0;
    this.phase = this.targetIndex == null ? 'completed' : 'idle';
    return this.snapshot();
  }

  finish({completed = false} = {}) {
    this.typingRatio = completed ? 1 : this.typingRatio;
    this.phase = completed ? 'completed' : 'idle';
    return this.snapshot();
  }

  snapshot() {
    return Object.freeze({
      arrivedIndex: this.arrivedIndex,
      targetIndex: this.targetIndex,
      typingRatio: this.typingRatio,
      phase: this.phase,
      stopCount: this.stopCount,
    });
  }
}

export function createJourneyFrame({
  network,
  route,
  direction = 'forward',
  arrivedIndex = 0,
  targetIndex = null,
  challengeIndex = null,
  typingRatio = 0,
  geometry,
  allLabels = false,
  journeyActive = false,
  practiceMode = 'overview',
  mapMode = 'flat',
  phase = 'idle',
  overrides = {},
} = {}) {
  if (!route || !geometry) throw new TypeError('route 与 geometry 是 JourneyFrame 的必填项');
  const reverse = direction === 'reverse';
  const count = route.stops?.length || 0;
  const safeArrived = clamp(Number(arrivedIndex) || 0, 0, Math.max(0, count - 1));
  const safeTarget = Number.isInteger(targetIndex) && targetIndex >= 0 && targetIndex < count
    ? targetIndex
    : null;
  const safeChallenge = Number.isInteger(challengeIndex) && challengeIndex >= 0 && challengeIndex < count
    ? challengeIndex
    : null;
  const toOriginal = index => reverse ? count - 1 - index : index;
  const arrivedOriginalIndex = toOriginal(safeArrived);
  const targetOriginalIndex = safeTarget == null ? null : toOriginal(safeTarget);
  const challengeOriginalIndex = safeChallenge == null ? null : toOriginal(safeChallenge);
  const segmentStart = Number(geometry.stationProgresses?.[arrivedOriginalIndex]) || 0;
  const segmentEnd = targetOriginalIndex == null
    ? segmentStart
    : Number(geometry.stationProgresses?.[targetOriginalIndex]) || segmentStart;
  const ratio = clamp(Number(typingRatio) || 0, 0, 1);
  const routeProgress = segmentStart + (segmentEnd - segmentStart) * ratio;
  return Object.freeze({
    ...overrides,
    network,
    routeId: route.id,
    route,
    direction,
    reverse,
    arrivedIndex: safeArrived,
    targetIndex: safeTarget,
    challengeIndex: safeChallenge,
    arrivedOriginalIndex,
    targetOriginalIndex,
    challengeOriginalIndex,
    segmentStart,
    segmentEnd,
    typingRatio: ratio,
    routeProgress,
    phase: JOURNEY_PHASES.includes(phase) ? phase : 'idle',
    allLabels: Boolean(allLabels),
    journeyActive: Boolean(journeyActive),
    practiceMode,
    mapMode,
    // Renderer compatibility aliases. Business logic must use arrived/target.
    currentDisplayIndex: safeArrived,
    nextDisplayIndex: safeTarget,
    currentOriginalIndex: arrivedOriginalIndex,
    nextOriginalIndex: targetOriginalIndex,
  });
}
