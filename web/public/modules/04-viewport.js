(() => {
  const Z = window.TransitPublic;

  class ViewportController {
    constructor(svg) {
      this.svg = svg;
      this.view = {x: 0, y: 0, w: 1280, h: 720};
      this.dragging = false;
      this.last = null;
      this.manualHandler = null;
      this.bind();
    }

    set(view) { this.view = {...view}; this.commit(); }
    commit() { this.svg.setAttribute('viewBox', `${this.view.x} ${this.view.y} ${this.view.w} ${this.view.h}`); }
    setManualHandler(handler) { this.manualHandler = handler; }

    bind() {
      this.svg.addEventListener('pointerdown', event => {
        if (event.button !== 0) return;
        this.manualHandler?.();
        this.dragging = true;
        this.last = [event.clientX, event.clientY];
        this.svg.setPointerCapture?.(event.pointerId);
      });
      this.svg.addEventListener('pointermove', event => {
        if (!this.dragging) return;
        const rect = this.svg.getBoundingClientRect();
        const dx = (event.clientX - this.last[0]) / Math.max(1, rect.width) * this.view.w;
        const dy = (event.clientY - this.last[1]) / Math.max(1, rect.height) * this.view.h;
        this.view.x -= dx; this.view.y -= dy; this.last = [event.clientX, event.clientY]; this.commit();
      });
      const end = () => { this.dragging = false; this.last = null; };
      this.svg.addEventListener('pointerup', end);
      this.svg.addEventListener('pointercancel', end);
      this.svg.addEventListener('wheel', event => {
        event.preventDefault();
        this.manualHandler?.();
        const rect = this.svg.getBoundingClientRect();
        const ux = Z.clamp((event.clientX - rect.left) / Math.max(1, rect.width), 0, 1);
        const uy = Z.clamp((event.clientY - rect.top) / Math.max(1, rect.height), 0, 1);
        if (!event.ctrlKey && Math.abs(event.deltaX) + Math.abs(event.deltaY) < 180) {
          this.view.x += event.deltaX / Math.max(1, rect.width) * this.view.w;
          this.view.y += event.deltaY / Math.max(1, rect.height) * this.view.h;
        } else {
          const factor = Z.clamp(Math.exp(event.deltaY * .006), .78, 1.28);
          const worldX = this.view.x + ux * this.view.w;
          const worldY = this.view.y + uy * this.view.h;
          const w = Z.clamp(this.view.w * factor, 100, 1800);
          const h = w / Math.max(.4, rect.width / Math.max(1, rect.height));
          this.view = {x: worldX - ux * w, y: worldY - uy * h, w, h};
        }
        this.commit();
      }, {passive: false});
    }
  }

  Z.ViewportController = ViewportController;
})();
