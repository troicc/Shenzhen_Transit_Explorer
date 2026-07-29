import {normalizePinyin} from './core.js?v=3';
import {JourneyState} from './journey.js';

export class PracticeEngine {
  constructor({onChange = () => {}, onFinish = () => {}, targetForStation = station => station?.pinyin || ''} = {}) {
    this.onChange = onChange;
    this.onFinish = onFinish;
    this.targetForStation = targetForStation;
    this.journey = new JourneyState();
    this.timer = null;
    this.reset();
  }

  reset() {
    this.stopTimer();
    this.mode = 'overview';
    this.stops = [];
    this.journey.reset();
    this.value = '';
    this.lastValid = '';
    this.acceptedCharacters = 0;
    this.errors = 0;
    this.completedStations = 0;
    this.timeLeft = 30;
    this.startedAt = null;
    this.running = false;
    this.locked = false;
    this.finished = false;
  }

  start(stops, mode) {
    this.reset();
    this.stops = stops;
    this.journey.reset(stops.length);
    this.mode = mode;
    this.running = true;
    this.timeLeft = 30;
    this.emit();
  }

  currentStation() {
    return this.stops[this.journey.arrivedIndex] || null;
  }

  nextStation() {
    return this.stops[this.journey.targetIndex] || null;
  }

  targetStation() {
    return this.nextStation();
  }

  targetDisplay() {
    return String(this.targetForStation?.(this.targetStation()) || '').trim();
  }

  target() {
    return normalizePinyin(this.targetDisplay());
  }

  setTargetResolver(resolver) {
    if (typeof resolver !== 'function') return false;
    this.targetForStation = resolver;
    if (!this.locked) {
      this.value = '';
      this.lastValid = '';
      this.journey.setTypingRatio(0);
    }
    this.emit();
    return true;
  }

  startClockIfNeeded() {
    if (this.startedAt) return;
    this.startedAt = performance.now();
    if (this.mode === 'timed') {
      this.stopTimer();
      this.timer = setInterval(() => {
        this.timeLeft = Math.max(0, this.timeLeft - 1);
        this.emit();
        if (this.timeLeft <= 0) this.finish('timeout');
      }, 1000);
    }
  }

  input(rawValue) {
    if (!this.running || this.locked || this.finished) return {type: 'ignored', value: this.lastValid};
    const normalized = normalizePinyin(rawValue);
    const target = this.target();
    if (!target) return {type: 'missing-target', value: ''};
    this.startClockIfNeeded();

    if (!target.startsWith(normalized)) {
      this.errors += 1;
      this.emit();
      return {type: 'invalid', value: this.lastValid};
    }

    const added = Math.max(0, normalized.length - this.lastValid.length);
    this.acceptedCharacters += added;
    this.value = normalized;
    this.lastValid = normalized;
    this.journey.setTypingRatio(this.typingRatio());
    if (normalized === target) {
      this.locked = true;
      this.completedStations += 1;
      this.journey.beginArrival();
      this.emit();
      return {type: 'complete', value: normalized};
    }
    this.emit();
    return {type: 'valid', value: normalized};
  }

  advance() {
    if (!this.locked || this.finished) return {finished: false};
    this.journey.completeArrival();
    if (this.journey.targetIndex == null) {
      this.finish('complete');
      return {finished: true};
    }
    this.value = '';
    this.lastValid = '';
    this.locked = false;
    this.emit();
    return {finished: false};
  }

  finish(reason) {
    if (this.finished) return;
    this.finished = true;
    this.running = false;
    this.locked = true;
    this.stopTimer();
    this.journey.finish({completed: reason === 'complete'});
    this.emit();
    this.onFinish({...this.snapshot(), reason});
  }

  stopTimer() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  elapsedSeconds() {
    if (!this.startedAt) return 0;
    return Math.max(.001, (performance.now() - this.startedAt) / 1000);
  }

  accuracy() {
    const total = this.acceptedCharacters + this.errors;
    return total ? this.acceptedCharacters / total : 1;
  }

  cpm() {
    const minutes = Math.max(1, this.elapsedSeconds()) / 60;
    return this.startedAt ? Math.round(this.acceptedCharacters / minutes) : 0;
  }

  typingRatio() {
    const target = this.target();
    return target ? Math.min(1, this.value.length / target.length) : 0;
  }

  snapshot() {
    return {
      mode: this.mode,
      index: this.journey.arrivedIndex,
      arrivedIndex: this.journey.arrivedIndex,
      targetIndex: this.journey.targetIndex,
      phase: this.journey.phase,
      value: this.value,
      target: this.target(),
      targetDisplay: this.targetDisplay(),
      currentStation: this.currentStation(),
      nextStation: this.nextStation(),
      targetStation: this.targetStation(),
      acceptedCharacters: this.acceptedCharacters,
      errors: this.errors,
      completedStations: this.completedStations,
      timeLeft: this.timeLeft,
      elapsedSeconds: this.elapsedSeconds(),
      accuracy: this.accuracy(),
      cpm: this.cpm(),
      typingRatio: this.journey.typingRatio,
      running: this.running,
      locked: this.locked,
      finished: this.finished,
      totalStations: this.stops.length,
    };
  }

  emit() {
    this.onChange(this.snapshot());
  }

  destroy() {
    this.stopTimer();
  }
}
