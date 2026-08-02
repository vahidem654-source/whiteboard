// ============================================================
// Shared tool state (read by every drawing surface)
// ============================================================
window.ToolState = {
  tool: 'pen',        // pen | line | rect | circle | triangle | eraser
  color: '#5B5FEF',
  size: 4,
  panMode: false
};

// Palette shown as quick swatches
window.PALETTE = ['#171923', '#5B5FEF', '#17C3B2', '#FF4757', '#FFB020', '#FFFFFF'];

// ============================================================
// DrawSurface: binds one <canvas> to one "page" (a plain object
// holding a strokes array). Handles rendering + input + undo/redo.
// ============================================================
class DrawSurface {
  constructor(canvas, page, opts = {}) {
    this.canvas = canvas;
    this.page = page; // { strokes: [], undo: [], redo: [] }
    this.ctx = canvas.getContext('2d', { willReadFrequently: false });
    this.opts = opts; // { getSize: () => ({w,h}), panTarget: scrollableElement, onChange }
    this.drawing = false;
    this.current = null;
    this.onChange = opts.onChange || (() => {});
    this.touchState = 'idle'; // 'idle' | 'draw' | 'pan' (touch-only state machine)
    this.panLast = null;
    this._bind();
  }

  destroy() {
    const c = this.canvas;
    c.removeEventListener('pointerdown', this._down);
    c.removeEventListener('pointermove', this._move);
    window.removeEventListener('pointerup', this._up);
    window.removeEventListener('pointercancel', this._up);
    c.removeEventListener('touchstart', this._touchStart);
    c.removeEventListener('touchmove', this._touchMove);
    c.removeEventListener('touchend', this._touchEnd);
    c.removeEventListener('touchcancel', this._touchEnd);
  }

  _bind() {
    // Mouse + pen (stylus) go through Pointer Events - simple single-contact input.
    this._down = this._onDown.bind(this);
    this._move = this._onMove.bind(this);
    this._up = this._onUp.bind(this);
    this.canvas.addEventListener('pointerdown', this._down);
    this.canvas.addEventListener('pointermove', this._move);
    window.addEventListener('pointerup', this._up);
    window.addEventListener('pointercancel', this._up);

    // Fingers go through native Touch events, using e.touches.length fresh on every
    // event (no manually-tracked counters that could ever get stuck/stale).
    this._touchStart = this._onTouchStart.bind(this);
    this._touchMove = this._onTouchMove.bind(this);
    this._touchEnd = this._onTouchEnd.bind(this);
    this.canvas.addEventListener('touchstart', this._touchStart, { passive: false });
    this.canvas.addEventListener('touchmove', this._touchMove, { passive: false });
    this.canvas.addEventListener('touchend', this._touchEnd, { passive: false });
    this.canvas.addEventListener('touchcancel', this._touchEnd, { passive: false });
  }

  size() {
    if (this.opts.getSize) return this.opts.getSize();
    const r = this.canvas.getBoundingClientRect();
    return { w: r.width, h: r.height };
  }

  resize() {
    const dpr = Math.max(window.devicePixelRatio || 1, 1);
    const { w, h } = this.size();
    if (w <= 0 || h <= 0) return;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.redraw();
  }

  _localXY(clientX, clientY) {
    const r = this.canvas.getBoundingClientRect();
    const w = r.width, h = r.height;
    return { x: (clientX - r.left) / w, y: (clientY - r.top) / h, w, h };
  }

  _beginStrokeAt(clientX, clientY) {
    const p = this._localXY(clientX, clientY);
    this.drawing = true;
    const tool = ToolState.tool;
    if (tool === 'pen' || tool === 'eraser') {
      this.current = { type: tool, color: ToolState.color, size: ToolState.size, points: [[p.x, p.y]] };
    } else {
      this.current = { type: tool, color: ToolState.color, size: ToolState.size, x0: p.x, y0: p.y, x1: p.x, y1: p.y };
    }
    this._renderPreview();
  }

  _moveStrokeTo(clientX, clientY) {
    if (!this.drawing || !this.current) return;
    const p = this._localXY(clientX, clientY);
    const tool = this.current.type;
    if (tool === 'pen' || tool === 'eraser') this.current.points.push([p.x, p.y]);
    else { this.current.x1 = p.x; this.current.y1 = p.y; }
    this._renderPreview();
  }

  _commitStroke() {
    this.drawing = false;
    if (this.current) {
      const isDegenerate = (this.current.type !== 'pen' && this.current.type !== 'eraser') &&
        Math.abs(this.current.x1 - this.current.x0) < 0.002 && Math.abs(this.current.y1 - this.current.y0) < 0.002;
      if (!isDegenerate) {
        this.page.strokes.push(this.current);
        this.page.redo = [];
        this.onChange();
      }
    }
    this.current = null;
    this.redraw();
  }

  _cancelStroke() {
    this.drawing = false;
    this.current = null;
    this.redraw();
  }

  static _avg(touchList) {
    let x = 0, y = 0;
    for (let i = 0; i < touchList.length; i++) { x += touchList[i].clientX; y += touchList[i].clientY; }
    return { x: x / touchList.length, y: y / touchList.length };
  }

  // ---------- Mouse / pen (Pointer Events) ----------
  _onDown(e) {
    if (e.pointerType === 'touch') return; // handled by native touch events instead
    if (e.pointerType === 'mouse' && e.button !== undefined && e.button !== 0) return;
    this.canvas.setPointerCapture(e.pointerId);
    if (ToolState.panMode) return;
    this._penPointerId = e.pointerId;
    this._beginStrokeAt(e.clientX, e.clientY);
  }
  _onMove(e) {
    if (e.pointerType === 'touch') return;
    if (!this.drawing || e.pointerId !== this._penPointerId) return;
    this._moveStrokeTo(e.clientX, e.clientY);
  }
  _onUp(e) {
    if (e.pointerType === 'touch') return;
    if (!this.drawing || e.pointerId !== this._penPointerId) return;
    this._penPointerId = null;
    this._commitStroke();
  }

  // ---------- Fingers (native Touch Events) ----------
  // One finger draws. A second finger appearing anywhere on screen switches
  // to panning the given panTarget and abandons any in-progress mark - mirrors
  // "mouse draws / wheel scrolls" independence, but for touch, using finger count.
  _onTouchStart(e) {
    if (ToolState.panMode) return; // forced scroll-only: let native touch-action:pan handle it
    const n = e.touches.length;
    if (n === 1) {
      this.touchState = 'draw';
      const t = e.touches[0];
      this._beginStrokeAt(t.clientX, t.clientY);
      e.preventDefault();
    } else if (n >= 2) {
      if (this.touchState === 'draw') this._cancelStroke();
      this.touchState = 'pan';
      this.panLast = DrawSurface._avg(e.touches);
      e.preventDefault();
    }
  }
  _onTouchMove(e) {
    if (ToolState.panMode) return;
    const n = e.touches.length;
    if (n >= 2) {
      if (this.touchState !== 'pan') {
        if (this.touchState === 'draw') this._cancelStroke();
        this.touchState = 'pan';
        this.panLast = DrawSurface._avg(e.touches);
      } else {
        const cur = DrawSurface._avg(e.touches);
        const dx = cur.x - this.panLast.x, dy = cur.y - this.panLast.y;
        this.panLast = cur;
        const target = this.opts.panTarget;
        if (target) { target.scrollTop -= dy; target.scrollLeft -= dx; }
      }
      e.preventDefault();
    } else if (n === 1 && this.touchState === 'draw') {
      this._moveStrokeTo(e.touches[0].clientX, e.touches[0].clientY);
      e.preventDefault();
    }
  }
  _onTouchEnd(e) {
    if (ToolState.panMode) return;
    const n = e.touches.length;
    if (this.touchState === 'draw' && n === 0) {
      this._commitStroke();
      this.touchState = 'idle';
    } else if (this.touchState === 'pan') {
      if (n < 2) this.touchState = n === 0 ? 'idle' : 'pan-wait'; // wait for full release before allowing a new draw
      if (n === 0) this.touchState = 'idle';
    } else if (n === 0) {
      this.touchState = 'idle';
    }
  }

  _renderPreview() {
    this.redraw();
    if (this.current) this._paintStroke(this.ctx, this.current, this.size());
  }

  redraw() {
    const { w, h } = this.size();
    this.ctx.clearRect(0, 0, w, h);
    for (const s of this.page.strokes) this._paintStroke(this.ctx, s, { w, h });
  }

  _paintStroke(ctx, s, { w, h }) {
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = s.size;
    if (s.type === 'eraser') {
      ctx.globalCompositeOperation = 'destination-out';
      ctx.strokeStyle = 'rgba(0,0,0,1)';
    } else {
      ctx.globalCompositeOperation = 'source-over';
      ctx.strokeStyle = s.color;
      ctx.fillStyle = s.color;
    }

    if (s.type === 'pen' || s.type === 'eraser') {
      const pts = s.points;
      if (pts.length < 2) {
        ctx.beginPath();
        ctx.arc(pts[0][0] * w, pts[0][1] * h, s.size / 2, 0, Math.PI * 2);
        ctx.fillStyle = s.type === 'eraser' ? 'rgba(0,0,0,1)' : s.color;
        if (s.type === 'eraser') ctx.globalCompositeOperation = 'destination-out';
        ctx.fill();
      } else {
        ctx.beginPath();
        ctx.moveTo(pts[0][0] * w, pts[0][1] * h);
        for (let i = 1; i < pts.length - 1; i++) {
          const xc = (pts[i][0] + pts[i + 1][0]) / 2 * w;
          const yc = (pts[i][1] + pts[i + 1][1]) / 2 * h;
          ctx.quadraticCurveTo(pts[i][0] * w, pts[i][1] * h, xc, yc);
        }
        const last = pts[pts.length - 1];
        ctx.lineTo(last[0] * w, last[1] * h);
        ctx.stroke();
      }
    } else if (s.type === 'line') {
      ctx.beginPath();
      ctx.moveTo(s.x0 * w, s.y0 * h);
      ctx.lineTo(s.x1 * w, s.y1 * h);
      ctx.stroke();
    } else if (s.type === 'rect') {
      ctx.strokeRect(Math.min(s.x0, s.x1) * w, Math.min(s.y0, s.y1) * h, Math.abs(s.x1 - s.x0) * w, Math.abs(s.y1 - s.y0) * h);
    } else if (s.type === 'circle') {
      const cx = (s.x0 + s.x1) / 2 * w, cy = (s.y0 + s.y1) / 2 * h;
      const rx = Math.abs(s.x1 - s.x0) / 2 * w, ry = Math.abs(s.y1 - s.y0) / 2 * h;
      ctx.beginPath();
      ctx.ellipse(cx, cy, Math.max(rx, 0.1), Math.max(ry, 0.1), 0, 0, Math.PI * 2);
      ctx.stroke();
    } else if (s.type === 'triangle') {
      const x0 = s.x0 * w, y0 = s.y0 * h, x1 = s.x1 * w, y1 = s.y1 * h;
      ctx.beginPath();
      ctx.moveTo((x0 + x1) / 2, y0);
      ctx.lineTo(x0, y1);
      ctx.lineTo(x1, y1);
      ctx.closePath();
      ctx.stroke();
    }
    ctx.restore();
  }

  undo() {
    if (!this.page.strokes.length) return;
    this.page.redo.push(this.page.strokes.pop());
    this.redraw();
    this.onChange();
  }
  redo() {
    if (!this.page.redo.length) return;
    this.page.strokes.push(this.page.redo.pop());
    this.redraw();
    this.onChange();
  }
  clear() {
    if (!this.page.strokes.length) return;
    this.page.undoAllBackup = this.page.strokes;
    this.page.strokes = [];
    this.page.redo = [];
    this.redraw();
    this.onChange();
  }

  // Renders the page's strokes onto an arbitrary target canvas at its own size (used for thumbnails / composing)
  paintOnto(targetCtx, w, h) {
    for (const s of this.page.strokes) this._paintStroke(targetCtx, s, { w, h });
  }
}

function makeEmptyPage(kind = 'blank', extra = {}) {
  return Object.assign({
    id: 'p_' + Math.random().toString(36).slice(2, 10),
    kind, // 'blank' | 'file'
    strokes: [],
    redo: []
  }, extra);
}
