(() => {
  const Z = window.ZhanyuePublic;

  class PracticeEngine {
    constructor(onChange, onComplete) {
      this.onChange = onChange;
      this.onComplete = onComplete;
      this.reset();
    }

    reset() {
      this.stations = [];
      this.index = 0;
      this.value = '';
      this.startedAt = 0;
      this.characters = 0;
      this.errors = 0;
      this.correct = 0;
      this.mode = 'full';
      this.duration = 0;
      this.scheme = 'full';
      this.active = false;
      this.finishedReason = '';
    }

    start(stations, options = {}) {
      this.reset();
      this.stations = stations;
      // The first station is the vehicle's origin.  Typing always targets the
      // next station so every character advances the journey instead of
      // validating a station the vehicle has already reached.
      this.index = stations.length > 1 ? 1 : 0;
      this.mode = options.mode || 'full';
      this.duration = this.mode === 'timed' ? Number(options.duration || 30) : 0;
      this.scheme = options.scheme || 'full';
      this.active = true;
      this.startedAt = performance.now();
      this.emit();
    }

    setScheme(scheme) {
      this.scheme = scheme === 'initials' ? 'initials' : 'full';
      this.value = '';
      this.emit();
    }

    station() { return this.stations[this.index] || null; }

    target() {
      const pinyin = String(this.station()?.pinyin || '');
      if (this.scheme === 'initials') {
        const syllables = pinyin.toLowerCase().replace(/[1-5]/g, '').trim().split(/\s+/).filter(Boolean);
        return Z.normalizePinyin(syllables.map(item => item[0] || '').join(''));
      }
      return Z.normalizePinyin(pinyin);
    }

    input(raw) {
      if (!this.active) return {type: 'ignored', value: ''};
      this.tick();
      if (!this.active) return {type: 'expired', value: this.value};
      const value = Z.normalizePinyin(raw);
      const target = this.target();
      if (!target.startsWith(value)) {
        this.errors += Math.max(1, value.length - this.value.length);
        this.emit();
        return {type: 'invalid', value: this.value};
      }
      this.characters += Math.max(0, value.length - this.value.length);
      this.value = value;
      this.emit();
      return {type: value === target ? 'complete' : 'valid', value};
    }

    advance() {
      if (!this.active) return false;
      this.correct += 1;
      if (this.index >= this.stations.length - 1) {
        this.finish('complete');
        return false;
      }
      this.index += 1;
      this.value = '';
      this.emit();
      return true;
    }

    tick() {
      if (!this.active) return;
      if (this.mode === 'timed' && this.remaining() <= 0) this.finish('time');
      else this.emit();
    }

    finish(reason = 'stopped') {
      if (!this.active) return;
      this.active = false;
      this.finishedReason = reason;
      const snapshot = this.snapshot();
      this.emit();
      this.onComplete?.(snapshot, reason);
    }

    ratio() {
      const target = this.target();
      return target ? this.value.length / target.length : 0;
    }

    elapsedSeconds() {
      return this.startedAt ? Math.max(0, (performance.now() - this.startedAt) / 1000) : 0;
    }

    remaining() {
      return this.mode === 'timed' ? Math.max(0, this.duration - this.elapsedSeconds()) : Infinity;
    }

    speed() {
      const minutes = Math.max(this.elapsedSeconds() / 60, 1 / 120);
      return this.startedAt ? Math.round(this.characters / minutes) : 0;
    }

    accuracy() {
      const total = this.characters + this.errors;
      return total ? Math.round(this.characters / total * 100) : 100;
    }

    snapshot() {
      return {
        station: this.station(), index: this.index, total: this.stations.length,
        value: this.value, target: this.target(), ratio: this.ratio(), speed: this.speed(),
        correct: this.correct, accuracy: this.accuracy(), remaining: this.remaining(),
        mode: this.mode, scheme: this.scheme, active: this.active, reason: this.finishedReason,
      };
    }

    emit() { this.onChange?.(this.snapshot()); }
  }

  Z.PracticeEngine = PracticeEngine;
})();
