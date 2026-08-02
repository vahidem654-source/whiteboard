class ClipRecorder {
  constructor({ composeCanvas, stageEl, getMode, drawCanvasEl, fileScrollEl }) {
    this.composeCanvas = composeCanvas;
    this.ctx = composeCanvas.getContext('2d');
    this.stageEl = stageEl;
    this.getMode = getMode; // () => 'board' | 'file'
    this.drawCanvasEl = drawCanvasEl;
    this.fileScrollEl = fileScrollEl;
    this.recording = false;
    this.paused = false;
    this.chunks = [];
    this.rafId = null;
    this.startTime = 0;
    this.elapsedBeforePause = 0;
    this.onTick = null;
    this.onLevel = null;
  }

  async start(opts) {
    const quality = opts.quality || 1.5;
    const rect = this.stageEl.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.round(rect.width * dpr * (quality / 1.5));
    const h = Math.round(rect.height * dpr * (quality / 1.5));
    this.composeCanvas.width = Math.min(w, 2560);
    this.composeCanvas.height = Math.round(this.composeCanvas.width * (rect.height / rect.width));

    // ---- Audio: mic with noise reduction, then leveled via compressor ----
    this.micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: opts.echoCancel !== false,
        noiseSuppression: opts.noiseSuppression !== false,
        autoGainControl: opts.autoGain !== false
      }
    });

    this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const src = this.audioCtx.createMediaStreamSource(this.micStream);

    // Remove sub-100Hz rumble/hum (mic handling noise, AC hum) without touching voice range
    const highpass = this.audioCtx.createBiquadFilter();
    highpass.type = 'highpass';
    highpass.frequency.value = 90;
    highpass.Q.value = 0.7;

    // Gentle safety limiter: only protects against sudden loud peaks (mic bumps, shouting).
    // Kept close to unity gain so it never lifts the noise floor between words -
    // that lift is what caused the audible hiss/static before.
    const limiter = this.audioCtx.createDynamicsCompressor();
    limiter.threshold.value = -10;
    limiter.knee.value = 6;
    limiter.ratio.value = 4;
    limiter.attack.value = 0.01;
    limiter.release.value = 0.35;

    const outGain = this.audioCtx.createGain();
    outGain.gain.value = 1.0; // unity - no artificial boost of quiet/noisy sections

    this.analyser = this.audioCtx.createAnalyser();
    this.analyser.fftSize = 512;
    this._levelBuf = new Uint8Array(this.analyser.frequencyBinCount);

    const dest = this.audioCtx.createMediaStreamDestination();
    src.connect(highpass);
    highpass.connect(limiter);
    limiter.connect(outGain);
    outGain.connect(dest);
    outGain.connect(this.analyser);

    // ---- Video: composited canvas ----
    const videoStream = this.composeCanvas.captureStream(30);
    const combined = new MediaStream([...videoStream.getVideoTracks(), ...dest.stream.getAudioTracks()]);

    const mimeCandidates = [
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm'
    ];
    const mime = mimeCandidates.find(m => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || '';

    this.recorder = new MediaRecorder(combined, mime ? { mimeType: mime, audioBitsPerSecond: 128000 } : {});
    this.chunks = [];
    this.recorder.ondataavailable = (e) => { if (e.data && e.data.size) this.chunks.push(e.data); };

    this.recording = true;
    this.paused = false;
    this.startTime = performance.now();
    this.elapsedBeforePause = 0;
    this.recorder.start(1000);
    this._loop();
    this._levelLoop();
    return true;
  }

  _loop() {
    if (!this.recording) return;
    if (!this.paused) this._drawFrame();
    this.rafId = requestAnimationFrame(() => this._loop());
    if (this.onTick) {
      const elapsed = this.paused ? this.elapsedBeforePause : this.elapsedBeforePause + (performance.now() - this.startTime);
      this.onTick(elapsed);
    }
  }

  _levelLoop() {
    if (!this.recording) return;
    this.analyser.getByteFrequencyData(this._levelBuf);
    let sum = 0;
    for (let i = 0; i < this._levelBuf.length; i++) sum += this._levelBuf[i];
    const avg = sum / this._levelBuf.length / 255;
    if (this.onLevel) this.onLevel(Math.min(1, avg * 1.6));
    requestAnimationFrame(() => this._levelLoop());
  }

  _drawFrame() {
    const ctx = this.ctx;
    const cw = this.composeCanvas.width, ch = this.composeCanvas.height;
    const stageRect = this.stageEl.getBoundingClientRect();
    const scaleX = cw / stageRect.width, scaleY = ch / stageRect.height;

    const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg-app').trim() || '#fff';
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, cw, ch);

    if (this.getMode() === 'board') {
      ctx.drawImage(this.drawCanvasEl, 0, 0, cw, ch);
    } else {
      const pages = this.fileScrollEl.querySelectorAll('.file-page');
      pages.forEach(pageEl => {
        const r = pageEl.getBoundingClientRect();
        if (r.bottom < stageRect.top || r.top > stageRect.bottom) return;
        const rx = (r.left - stageRect.left) * scaleX;
        const ry = (r.top - stageRect.top) * scaleY;
        const rw = r.width * scaleX;
        const rh = r.height * scaleY;
        const img = pageEl.querySelector('img');
        const overlay = pageEl.querySelector('canvas');
        if (img && img.complete) ctx.drawImage(img, rx, ry, rw, rh);
        if (overlay) ctx.drawImage(overlay, rx, ry, rw, rh);
      });
    }
  }

  pause() {
    if (!this.recording || this.paused) return;
    this.paused = true;
    this.elapsedBeforePause += performance.now() - this.startTime;
    this.recorder.pause();
  }

  resume() {
    if (!this.recording || !this.paused) return;
    this.paused = false;
    this.startTime = performance.now();
    this.recorder.resume();
  }

  async stop() {
    if (!this.recording) return null;
    this.recording = false;
    cancelAnimationFrame(this.rafId);
    const blob = await new Promise(resolve => {
      this.recorder.onstop = () => resolve(new Blob(this.chunks, { type: this.recorder.mimeType || 'video/webm' }));
      this.recorder.stop();
    });
    this.micStream.getTracks().forEach(t => t.stop());
    if (this.audioCtx) this.audioCtx.close();
    return blob;
  }
}
