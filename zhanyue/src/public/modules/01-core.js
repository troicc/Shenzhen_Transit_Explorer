(() => {
  const Z = window.ZhanyuePublic = window.ZhanyuePublic || {};
  Z.SVG_NS = 'http://www.w3.org/2000/svg';
  Z.clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  Z.lerp = (a, b, t) => a + (b - a) * t;
  Z.travelIndex = (originalIndex, count, reverse = false) => {
    const index = Z.clamp(Math.trunc(Number(originalIndex) || 0), 0, Math.max(0, count - 1));
    return reverse ? count - 1 - index : index;
  };
  Z.stationTravelPhase = (originalIndex, count, currentOriginalIndex, nextOriginalIndex, reverse = false) => {
    if (originalIndex === currentOriginalIndex) return 'current';
    if (nextOriginalIndex != null && originalIndex === nextOriginalIndex) return 'next';
    return Z.travelIndex(originalIndex, count, reverse) < Z.travelIndex(currentOriginalIndex, count, reverse)
      ? 'passed' : 'future';
  };
  Z.stationVisualState = (originalIndex, count, currentOriginalIndex, nextOriginalIndex, reverse = false) => {
    const phase = Z.stationTravelPhase(originalIndex, count, currentOriginalIndex, nextOriginalIndex, reverse);
    if (phase === 'current' || phase === 'next') return phase;
    return originalIndex === 0 || originalIndex === count - 1 ? 'terminal' : phase;
  };
  Z.normalizePinyin = value => String(value || '').toLowerCase()
    .replace(/[üǖǘǚǜ]/g, 'v').replace(/u:/g, 'v').replace(/[1-5]/g, '').replace(/[^a-zv]/g, '');
  Z.svgEl = (tag, attrs = {}) => {
    const node = document.createElementNS(Z.SVG_NS, tag);
    Object.entries(attrs).forEach(([key, value]) => node.setAttribute(key, String(value)));
    return node;
  };
  Z.escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
  Z.showToast = message => {
    const node = document.querySelector('#toast');
    node.textContent = message;
    node.classList.add('show');
    clearTimeout(Z.showToast.timer);
    Z.showToast.timer = setTimeout(() => node.classList.remove('show'), 1800);
  };
})();
