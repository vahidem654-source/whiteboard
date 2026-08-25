(() => {
'use strict';

// ============================================================
// DOM refs
// ============================================================
const $ = (id) => document.getElementById(id);
const els = {
  app: $('app'), stage: $('stage'),
  fileLayer: $('fileLayer'), fileScroll: $('fileScroll'), filePages: $('filePages'),
  drawLayer: $('drawLayer'), drawCanvas: $('drawCanvas'), composeCanvas: $('composeCanvas'),
  emptyHint: $('emptyHint'), pageJump: $('pageJump'), pageJumpInput: $('pageJumpInput'),
  pageJumpTotal: $('pageJumpTotal'), pageJumpPrev: $('pageJumpPrev'), pageJumpNext: $('pageJumpNext'),
  dockWrap: $('dockWrap'), dockHandle: $('dockHandle'), dock: $('dock'),
  navbarWrap: $('navbarWrap'), navbarHandle: $('navbarHandle'), navbar: $('navbar'),
  film: $('film'), btnAddBoard: $('btnAddBoard'),
  swatches: $('swatches'), colorPicker: $('colorPicker'),
  thicknessRange: $('thicknessRange'), thicknessValue: $('thicknessValue'),
  btnUndo: $('btnUndo'), btnRedo: $('btnRedo'), btnClear: $('btnClear'),
  btnMenu: $('btnMenu'), btnTheme: $('btnTheme'), btnPanZoom: $('btnPanZoom'), btnUpload: $('btnUpload'),
  fileInput: $('fileInput'),
  btnWebcam: $('btnWebcam'), webcamPreview: $('webcamPreview'), webcamVideo: $('webcamVideo'), webcamClose: $('webcamClose'),
  sidePanel: $('sidePanel'), scrim: $('scrim'), btnCloseSide: $('btnCloseSide'), sidePages: $('sidePages'),
  optNoise: $('optNoiseSuppression'), optAGC: $('optAutoGain'), optEcho: $('optEchoCancel'), optQuality: $('optVideoQuality'),
  btnSaveProject: $('btnSaveProject'), btnExportPNG: $('btnExportPNG'), btnResetProject: $('btnResetProject'),
  recordWrap: $('recordWrap'), btnRecord: $('btnRecord'), recRing: $('recRing'), recCore: $('recCore'),
  recTimer: $('recTimer'), micMeter: $('micMeter'), micFill: $('micFill'),
  downloadLink: $('downloadLink'), toast: $('toast')
};

// ============================================================
// State
// ============================================================
let docs = [];
let activeDocId = null;
let mode = 'board'; // 'board' | 'file'
let boardSurface = null;
let fileSurfaces = []; // { surface, page, el }
let lastActiveSurface = null;
let saveTimer = null;
let pageObserver = null;
let mountObserver = null;
let webcamOn = false;
let webcamStream = null;

function uid(p) { return p + '_' + Math.random().toString(36).slice(2, 9); }

function newBoardDoc(name) {
  return { id: uid('b'), kind: 'board', name: name || nextBoardName(), strokes: [], redo: [] };
}
function nextBoardName() {
  const n = docs.filter(d => d.kind === 'board').length + 1;
  return 'تخته ' + n;
}

// ============================================================
// Toast
// ============================================================
let toastTimer = null;
window.showToast = function (msg, ms = 2400) {
  els.toast.textContent = msg;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { els.toast.hidden = true; }, ms);
};

// ============================================================
// Theme
// ============================================================
function setTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  localStorage.setItem('bc_theme', t);
  els.themeIcon = $('themeIcon');
  if (t === 'dark') {
    els.themeIcon.innerHTML = '<path d="M21 12.6A9 9 0 1 1 11.4 3a7 7 0 0 0 9.6 9.6z"/>';
  } else {
    els.themeIcon.innerHTML = '<circle cx="12" cy="12" r="4.5"/><path d="M12 2v2.5M12 19.5V22M4.2 4.2l1.8 1.8M18 18l1.8 1.8M2 12h2.5M19.5 12H22M4.2 19.8L6 18M18 6l1.8-1.8"/>';
  }
}
function initTheme() {
  const saved = localStorage.getItem('bc_theme');
  const preferDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  setTheme(saved || (preferDark ? 'dark' : 'light'));
}
els.btnTheme.addEventListener('click', () => {
  const cur = document.documentElement.getAttribute('data-theme');
  setTheme(cur === 'dark' ? 'light' : 'dark');
});

// ============================================================
// Tool dock wiring
// ============================================================
document.querySelectorAll('.tool-btn[data-tool]').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tool-btn[data-tool]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    ToolState.tool = btn.dataset.tool;
  });
});

PALETTE.forEach((c, i) => {
  const sw = document.createElement('button');
  sw.className = 'swatch' + (i === 1 ? ' active' : '');
  sw.style.background = c;
  sw.addEventListener('click', () => {
    ToolState.color = c;
    document.querySelectorAll('.swatch').forEach(s => s.classList.remove('active'));
    sw.classList.add('active');
    els.colorPicker.value = c.length === 7 ? c : '#5B5FEF';
  });
  els.swatches.appendChild(sw);
});
els.colorPicker.addEventListener('input', (e) => {
  ToolState.color = e.target.value;
  document.querySelectorAll('.swatch').forEach(s => s.classList.remove('active'));
});

els.thicknessRange.addEventListener('input', (e) => {
  ToolState.size = Number(e.target.value);
  els.thicknessValue.textContent = e.target.value;
});

els.btnUndo.addEventListener('click', () => { (lastActiveSurface || boardSurface)?.undo(); scheduleSave(); refreshFilmThumb(); });
els.btnRedo.addEventListener('click', () => { (lastActiveSurface || boardSurface)?.redo(); scheduleSave(); refreshFilmThumb(); });
els.btnClear.addEventListener('click', () => {
  const s = lastActiveSurface || boardSurface;
  if (!s) return;
  if (confirm('این صفحه کامل پاک شود؟')) { s.clear(); scheduleSave(); refreshFilmThumb(); }
});

// Pan / scroll-lock toggle (disables pen so you can scroll freely)
els.btnPanZoom.addEventListener('click', () => {
  ToolState.panMode = !ToolState.panMode;
  els.btnPanZoom.classList.toggle('on', ToolState.panMode);
  document.querySelectorAll('#drawCanvas, .file-page canvas').forEach(c => c.classList.toggle('pan-mode', ToolState.panMode));
  showToast(ToolState.panMode ? 'حالت اسکرول: قلم غیرفعال شد 🖐️' : 'حالت قلم فعال شد ✏️');
});

// ============================================================
// Teacher webcam bubble - optional. When on, a small round live preview sits over
// the stage; the recorder composites this same circle into the recorded clip. When
// off, nothing camera-related is requested or drawn at all.
// ============================================================
async function enableWebcam() {
  if (webcamOn) return;
  if (!window.isSecureContext) { showToast('برای وبکم نیاز به HTTPS دارید'); return; }
  try {
    webcamStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' } });
  } catch (err) {
    console.error(err);
    showToast('دسترسی به دوربین داده نشد ❌');
    return;
  }
  els.webcamVideo.srcObject = webcamStream;
  webcamOn = true;
  els.webcamPreview.classList.remove('hidden');
  els.btnWebcam.classList.add('on');
  if (!els.webcamPreview.style.left) {
    const stageRect = els.stage.getBoundingClientRect();
    const size = els.webcamPreview.offsetWidth || 112;
    els.webcamPreview.style.left = Math.max(8, stageRect.width - size - 16) + 'px';
    els.webcamPreview.style.top = Math.max(8, stageRect.height - size - 140) + 'px';
  }
  showToast('وبکم فعال شد؛ تصویر شما در کلیپ ضبط می‌شود 🎥');
}

function disableWebcam() {
  if (webcamStream) { webcamStream.getTracks().forEach(t => t.stop()); webcamStream = null; }
  els.webcamVideo.srcObject = null;
  webcamOn = false;
  els.webcamPreview.classList.add('hidden');
  els.btnWebcam.classList.remove('on');
}

els.btnWebcam.addEventListener('click', () => { webcamOn ? disableWebcam() : enableWebcam(); });
els.webcamClose.addEventListener('click', (e) => { e.stopPropagation(); disableWebcam(); });

// Drag the bubble anywhere within the stage (mouse, pen, or finger - Pointer Events
// cover all three here since it's just repositioning, not freehand drawing).
let camDrag = null;
els.webcamPreview.addEventListener('pointerdown', (e) => {
  if (e.target === els.webcamClose) return;
  els.webcamPreview.setPointerCapture(e.pointerId);
  const r = els.webcamPreview.getBoundingClientRect();
  camDrag = { id: e.pointerId, offX: e.clientX - r.left, offY: e.clientY - r.top };
  els.webcamPreview.style.cursor = 'grabbing';
});
els.webcamPreview.addEventListener('pointermove', (e) => {
  if (!camDrag || e.pointerId !== camDrag.id) return;
  const stageRect = els.stage.getBoundingClientRect();
  const size = els.webcamPreview.offsetWidth;
  let x = e.clientX - stageRect.left - camDrag.offX;
  let y = e.clientY - stageRect.top - camDrag.offY;
  x = Math.max(4, Math.min(stageRect.width - size - 4, x));
  y = Math.max(4, Math.min(stageRect.height - size - 4, y));
  els.webcamPreview.style.left = x + 'px';
  els.webcamPreview.style.top = y + 'px';
});
function endCamDrag(e) {
  if (!camDrag || e.pointerId !== camDrag.id) return;
  camDrag = null;
  els.webcamPreview.style.cursor = 'grab';
}
els.webcamPreview.addEventListener('pointerup', endCamDrag);
els.webcamPreview.addEventListener('pointercancel', endCamDrag);

// ============================================================
// Unified two-finger scroll for book pages. This lives in exactly ONE place
// (the scroll container itself, not per-page) - each page's own canvas only ever
// handles single-finger drawing and immediately backs off as soon as a second
// finger appears anywhere. Doing panning per-page too caused real bugs whenever
// the two fingers happened to land on different page elements.
// ============================================================
let filePanState = 'idle';
let filePanLast = null;
function avgTouches(list) {
  let x = 0, y = 0;
  for (let i = 0; i < list.length; i++) { x += list[i].clientX; y += list[i].clientY; }
  return { x: x / list.length, y: y / list.length };
}
els.fileScroll.addEventListener('touchstart', (e) => {
  if (ToolState.panMode) return;
  if (e.touches.length >= 2) { filePanState = 'pan'; filePanLast = avgTouches(e.touches); e.preventDefault(); }
}, { passive: false });
els.fileScroll.addEventListener('touchmove', (e) => {
  if (ToolState.panMode) return;
  if (e.touches.length >= 2) {
    if (filePanState !== 'pan') { filePanState = 'pan'; filePanLast = avgTouches(e.touches); }
    const cur = avgTouches(e.touches);
    els.fileScroll.scrollTop -= (cur.y - filePanLast.y);
    els.fileScroll.scrollLeft -= (cur.x - filePanLast.x);
    filePanLast = cur;
    e.preventDefault();
  }
}, { passive: false });
els.fileScroll.addEventListener('touchend', (e) => { if (e.touches.length === 0) filePanState = 'idle'; }, { passive: false });
els.fileScroll.addEventListener('touchcancel', (e) => { if (e.touches.length === 0) filePanState = 'idle'; }, { passive: false });

// ============================================================
// Dock / navbar auto-hide while drawing
// ============================================================
let revealTimer = null;
function hideChrome() {
  if (!isRecording) els.dockWrap.classList.add('collapsed');
  els.navbarWrap.classList.add('collapsed');
}
function revealChromeSoon(delay = 1600) {
  clearTimeout(revealTimer);
  revealTimer = setTimeout(() => {
    els.navbarWrap.classList.remove('collapsed'); // only the page navigator auto-reveals
    // the tools drawer stays closed until the user deliberately taps its handle -
    // auto-popping a full-height drawer back open every few seconds was intrusive.
  }, delay);
}
els.stage.addEventListener('pointerdown', (e) => {
  if (ToolState.panMode) return;
  if (e.target.closest('.dock-wrap') || e.target.closest('.page-jump')) return;
  clearTimeout(revealTimer);
  hideChrome();
});
els.stage.addEventListener('pointerup', () => { if (!ToolState.panMode) revealChromeSoon(); });

els.dockHandle.addEventListener('click', () => els.dockWrap.classList.toggle('collapsed'));
els.navbarHandle.addEventListener('click', () => els.navbarWrap.classList.toggle('collapsed'));

// ============================================================
// Board <-> File switching, doc lifecycle
// ============================================================
function destroyFileSurfaces() {
  fileSurfaces.forEach(f => f.surface && f.surface.destroy());
  fileSurfaces = [];
  if (pageObserver) { pageObserver.disconnect(); pageObserver = null; }
  if (mountObserver) { mountObserver.disconnect(); mountObserver = null; }
}

function setActiveDoc(id, targetPageIndex) {
  const doc = docs.find(d => d.id === id);
  if (!doc) return;
  activeDocId = id;

  if (doc.kind === 'board') {
    mode = 'board';
    els.fileLayer.style.display = 'none';
    els.drawLayer.style.display = 'block';
    els.pageJump.hidden = true;
    if (!boardSurface) {
      boardSurface = new DrawSurface(els.drawCanvas, doc, { onChange: onSurfaceChange });
    } else {
      boardSurface.page = doc;
    }
    lastActiveSurface = boardSurface;
    requestAnimationFrame(() => { boardSurface.resize(); });
    els.emptyHint.classList.toggle('hide', doc.strokes.length > 0 || docs.length > 1);
  } else {
    mode = 'file';
    els.fileLayer.style.display = 'block';
    els.drawLayer.style.display = 'none';
    els.emptyHint.classList.add('hide');
    renderFileDoc(doc, targetPageIndex ?? doc.activePageIndex ?? 0);
  }
  renderFilm();
  renderSidePages();
}

function onSurfaceChange() { scheduleSave(); refreshFilmThumb(); }

// Creates the page "shell" (image + correctly-sized container) for every page so
// scrolling/layout/page-jump work immediately - but does NOT create a live drawing
// canvas yet. Canvases are expensive (one full-resolution GPU surface each), so for
// long books creating one per page at once is what was crashing the app on phones.
function createFilePageElement(doc, page, idx) {
  const pageEl = document.createElement('div');
  pageEl.className = 'file-page';
  pageEl.dataset.index = idx;
  pageEl.style.aspectRatio = `${page.w} / ${page.h}`;
  const img = document.createElement('img');
  img.src = page.src;
  img.loading = 'lazy';
  img.draggable = false;
  img.alt = doc.name + ' - صفحه ' + (idx + 1);
  pageEl.appendChild(img);
  els.filePages.appendChild(pageEl);

  const rec = { surface: null, canvasEl: null, page, el: pageEl, idx };
  fileSurfaces.push(rec);
  if (pageObserver) pageObserver.observe(pageEl);
  if (mountObserver) mountObserver.observe(pageEl);
  return pageEl;
}

// Attaches a real <canvas> + DrawSurface to a page shell - only called for pages
// near the visible viewport (see mountObserver below).
function mountPageSurface(doc, rec) {
  if (rec.surface) return;
  const canvas = document.createElement('canvas');
  if (ToolState.panMode) canvas.classList.add('pan-mode');
  rec.el.appendChild(canvas);
  rec.canvasEl = canvas;
  rec.surface = new DrawSurface(canvas, rec.page, {
    onChange: () => { lastActiveSurface = rec.surface; onSurfaceChange(); },
    getSize: () => { const r = rec.el.getBoundingClientRect(); return { w: r.width, h: r.height }; },
    onIdle: () => tryUnmountIfOffscreen(rec)
  });
  if (!lastActiveSurface) lastActiveSurface = rec.surface;
  requestAnimationFrame(() => rec.surface && rec.surface.resize());
}

// Detaches the canvas for a page that has scrolled far away. The stroke data lives
// on the page object itself (untouched), so it redraws correctly if remounted later.
// Never removes a canvas that's mid-gesture (mid-draw or mid-pan) - doing that once
// broke two-finger scrolling by yanking away the very canvas receiving the touch.
function unmountPageSurface(rec) {
  if (!rec.surface) return;
  if (rec.surface.drawing || (rec.surface.touchState && rec.surface.touchState !== 'idle')) return;
  rec.surface.destroy();
  rec.canvasEl && rec.canvasEl.remove();
  rec.surface = null;
  rec.canvasEl = null;
}

// Called right when a touch gesture on this page finishes - if the page had already
// scrolled out of the mount margin during that gesture, unmount it now instead of
// waiting for the next scroll event.
function tryUnmountIfOffscreen(rec) {
  if (!rec.surface) return;
  const r = rec.el.getBoundingClientRect();
  const root = els.fileScroll.getBoundingClientRect();
  const margin = root.height || 0;
  const offscreen = r.bottom < root.top - margin || r.top > root.bottom + margin;
  if (offscreen) unmountPageSurface(rec);
}

// Called while a PDF is still streaming in, if the user is currently looking at it -
// adds just the newly-rendered page without rebuilding everything already on screen.
function appendFilePage(doc, page, idx) {
  if (activeDocId !== doc.id || mode !== 'file') return; // not being viewed right now, nothing to update live
  createFilePageElement(doc, page, idx);
  els.pageJump.hidden = doc.pages.length <= 1;
  els.pageJumpTotal.textContent = '/ ' + doc.pages.length;
}

function filmLabelText(doc) {
  if (doc.kind === 'board') return doc.name;
  const loaded = doc.pages.length;
  const total = doc.totalPages || loaded;
  return loaded < total ? `${doc.name} · در حال بارگذاری ${loaded}/${total}` : `${doc.name} · ${loaded} صفحه`;
}
function updateFilmLabel(doc) {
  const item = els.film.querySelector(`[data-doc-id="${doc.id}"] .film-label`);
  if (item) item.textContent = filmLabelText(doc);
}

function renderFileDoc(doc, jumpToIndex) {
  destroyFileSurfaces();
  els.filePages.innerHTML = '';

  els.pageJump.hidden = doc.pages.length <= 1;
  els.pageJumpTotal.textContent = '/ ' + doc.pages.length;

  // Track which page is currently in view for the page-jump indicator
  pageObserver = new IntersectionObserver((entries) => {
    let best = null, bestRatio = 0;
    entries.forEach(en => { if (en.intersectionRatio > bestRatio) { bestRatio = en.intersectionRatio; best = en.target; } });
    if (best) {
      const idx = Number(best.dataset.index);
      els.pageJumpInput.value = idx + 1;
      doc.activePageIndex = idx;
    }
  }, { root: els.fileScroll, threshold: [0.25, 0.5, 0.75] });

  // Mounts/unmounts the actual drawing canvas as pages enter/leave a generous buffer
  // zone around the viewport - this is what keeps memory bounded on long books.
  mountObserver = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      const idx = Number(entry.target.dataset.index);
      const rec = fileSurfaces.find(f => f.idx === idx);
      if (!rec) return;
      if (entry.isIntersecting) mountPageSurface(doc, rec);
      else unmountPageSurface(rec);
    });
  }, { root: els.fileScroll, rootMargin: '100% 0px 100% 0px' });

  doc.pages.forEach((page, idx) => createFilePageElement(doc, page, idx));

  requestAnimationFrame(() => {
    lastActiveSurface = fileSurfaces[0]?.surface || lastActiveSurface;
  });

  const goto = jumpToIndex || 0;
  requestAnimationFrame(() => {
    const target = fileSurfaces[goto]?.el;
    if (target) target.scrollIntoView({ block: 'start' });
  });
}

els.pageJumpInput.addEventListener('change', () => {
  const doc = docs.find(d => d.id === activeDocId);
  if (!doc || doc.kind !== 'file') return;
  let n = Math.max(1, Math.min(doc.pages.length, Number(els.pageJumpInput.value) || 1));
  els.pageJumpInput.value = n;
  fileSurfaces[n - 1]?.el.scrollIntoView({ block: 'start', behavior: 'smooth' });
});
els.pageJumpPrev.addEventListener('click', () => {
  els.pageJumpInput.value = Math.max(1, Number(els.pageJumpInput.value) - 1);
  els.pageJumpInput.dispatchEvent(new Event('change'));
});
els.pageJumpNext.addEventListener('click', () => {
  els.pageJumpInput.value = Number(els.pageJumpInput.value) + 1;
  els.pageJumpInput.dispatchEvent(new Event('change'));
});

// ============================================================
// Filmstrip (bottom navigator) + side panel page list
// ============================================================
function docThumbSrc(doc) {
  if (doc.kind === 'file') return doc.pages[0]?.src;
  return null;
}
function renderFilm() {
  els.film.innerHTML = '';
  docs.forEach(doc => {
    const item = document.createElement('div');
    item.className = 'film-item' + (doc.id === activeDocId ? ' active' : '');
    item.dataset.docId = doc.id;
    const thumbSrc = docThumbSrc(doc);
    if (thumbSrc) {
      const img = document.createElement('img'); img.src = thumbSrc; item.appendChild(img);
    } else {
      const c = document.createElement('canvas'); c.width = 148; c.height = 112;
      const ctx = c.getContext('2d');
      ctx.fillStyle = getCSS('--bg-panel-2'); ctx.fillRect(0, 0, 148, 112);
      if (doc.strokes && doc.strokes.length) {
        const tmpSurface = new DrawSurface(c, doc, { getSize: () => ({ w: c.width, h: c.height }) });
        tmpSurface.redraw();
        tmpSurface.destroy();
      }
      item.appendChild(c);
    }
    const label = document.createElement('div');
    label.className = 'film-label';
    label.textContent = filmLabelText(doc);
    item.appendChild(label);

    const closeBtn = document.createElement('button');
    closeBtn.className = 'film-close'; closeBtn.textContent = '×';
    closeBtn.addEventListener('click', (e) => { e.stopPropagation(); removeDoc(doc.id); });
    item.appendChild(closeBtn);

    item.addEventListener('click', () => setActiveDoc(doc.id));
    els.film.appendChild(item);
  });
}
function refreshFilmThumb() { renderFilm(); }

function renderSidePages() {
  els.sidePages.innerHTML = '';
  docs.forEach(doc => {
    const row = document.createElement('div');
    row.className = 'side-list-item' + (doc.id === activeDocId ? ' active' : '');
    row.textContent = doc.kind === 'board' ? '📝 ' + doc.name : `📄 ${doc.name} (${doc.pages.length} صفحه)`;
    row.addEventListener('click', () => { setActiveDoc(doc.id); closeSidePanel(); });
    els.sidePages.appendChild(row);
  });
}

function getCSS(varName) {
  return getComputedStyle(document.documentElement).getPropertyValue(varName).trim() || '#eee';
}

function removeDoc(id) {
  const idx = docs.findIndex(d => d.id === id);
  if (idx === -1) return;
  if (!confirm('این صفحه حذف شود؟')) return;
  docs.splice(idx, 1);
  if (docs.length === 0) {
    const b = newBoardDoc();
    docs.push(b);
    setActiveDoc(b.id);
  } else if (activeDocId === id) {
    setActiveDoc(docs[Math.max(0, idx - 1)].id);
  } else {
    renderFilm(); renderSidePages();
  }
  scheduleSave();
}

els.btnAddBoard.addEventListener('click', () => {
  const doc = newBoardDoc();
  docs.push(doc);
  setActiveDoc(doc.id);
  scheduleSave();
  showToast('تخته سفید جدید اضافه شد');
});

// ============================================================
// Upload
// ============================================================
els.btnUpload.addEventListener('click', () => els.fileInput.click());
els.fileInput.addEventListener('change', async (e) => {
  const files = e.target.files;
  if (!files || !files.length) return;
  showToast('در حال آماده‌سازی صفحه‌ی اول…');

  await loadUploadedFiles(files, {
    onFirstPage: (doc) => {
      docs.push(doc);
      setActiveDoc(doc.id);
      scheduleSave();
      const willStream = doc.totalPages && doc.totalPages > 1;
      showToast(willStream
        ? `صفحه‌ی ۱ آماده شد؛ بقیه‌ی ${doc.totalPages} صفحه در پس‌زمینه بارگذاری می‌شود…`
        : 'فایل با موفقیت اضافه شد ✅');
    },
    onPageAdded: (doc, page, idx) => {
      appendFilePage(doc, page, idx);
      updateFilmLabel(doc);
      renderSidePages();
      scheduleSave();
    },
    onDone: (doc) => {
      updateFilmLabel(doc);
      scheduleSave();
      if (doc.totalPages && doc.totalPages > 1) showToast('بارگذاری کتاب کامل شد ✅');
    }
  });

  e.target.value = '';
});

// ============================================================
// Side panel (menu)
// ============================================================
function openSidePanel() { els.sidePanel.classList.add('open'); els.scrim.classList.add('show'); renderSidePages(); }
function closeSidePanel() { els.sidePanel.classList.remove('open'); els.scrim.classList.remove('show'); }
els.btnMenu.addEventListener('click', openSidePanel);
els.btnCloseSide.addEventListener('click', closeSidePanel);
els.scrim.addEventListener('click', closeSidePanel);

els.btnSaveProject.addEventListener('click', async () => { await saveProject(); showToast('پروژه ذخیره شد ✅'); });
els.btnExportPNG.addEventListener('click', () => exportCurrentPagePNG());
els.btnResetProject.addEventListener('click', async () => {
  if (!confirm('همه صفحات و تخته‌ها برای همیشه پاک می‌شوند. ادامه می‌دهید؟')) return;
  await idbDel('project');
  docs = [newBoardDoc('تخته ۱')];
  setActiveDoc(docs[0].id);
  closeSidePanel();
  showToast('پروژه جدید شروع شد');
});

function exportCurrentPagePNG() {
  let sourceCanvas, w, h;
  if (mode === 'board') {
    sourceCanvas = els.drawCanvas;
    w = sourceCanvas.width; h = sourceCanvas.height;
  } else {
    const f = fileSurfaces.find(f => f.idx === (docs.find(d => d.id === activeDocId)?.activePageIndex || 0)) || fileSurfaces[0];
    if (!f) return;
    const tmp = document.createElement('canvas');
    tmp.width = f.page.w; tmp.height = f.page.h;
    const ctx = tmp.getContext('2d');
    const img = f.el.querySelector('img');
    ctx.drawImage(img, 0, 0, tmp.width, tmp.height);
    const tmpSurface = new DrawSurface(tmp, f.page, { getSize: () => ({ w: tmp.width, h: tmp.height }) });
    tmpSurface.paintOnto(ctx, tmp.width, tmp.height);
    tmpSurface.destroy();
    sourceCanvas = tmp;
  }
  sourceCanvas.toBlob(blob => {
    const url = URL.createObjectURL(blob);
    els.downloadLink.href = url;
    els.downloadLink.download = 'clip-page-' + Date.now() + '.png';
    els.downloadLink.click();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  });
}

// ============================================================
// Persistence
// ============================================================
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveProject, 900);
}
async function saveProject() {
  await idbSet('project', { docs, activeDocId, savedAt: Date.now() });
}
async function loadProject() {
  const data = await idbGet('project');
  if (data && Array.isArray(data.docs) && data.docs.length) {
    docs = data.docs;
    // ensure legacy/missing fields
    docs.forEach(d => {
      if (d.kind === 'board') { d.strokes = d.strokes || []; d.redo = d.redo || []; }
      else { d.pages.forEach(p => { p.strokes = p.strokes || []; p.redo = p.redo || []; }); d.activePageIndex = d.activePageIndex || 0; }
    });
    setActiveDoc(data.activeDocId && docs.find(d => d.id === data.activeDocId) ? data.activeDocId : docs[0].id);
  } else {
    const b = newBoardDoc('تخته ۱');
    docs = [b];
    setActiveDoc(b.id);
  }
}

// ============================================================
// Resize handling
// ============================================================
function handleResize() {
  if (mode === 'board' && boardSurface) boardSurface.resize();
  if (mode === 'file') fileSurfaces.forEach(f => f.surface && f.surface.resize());
}
window.addEventListener('resize', debounce(handleResize, 150));
window.addEventListener('orientationchange', () => setTimeout(handleResize, 300));
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

// ============================================================
// Recording
// ============================================================
const recorder = new ClipRecorder({
  composeCanvas: els.composeCanvas,
  stageEl: els.stage,
  getMode: () => mode,
  drawCanvasEl: els.drawCanvas,
  fileScrollEl: els.fileScroll,
  getWebcamEl: () => (webcamOn ? els.webcamVideo : null),
  getWebcamPreviewEl: () => els.webcamPreview
});

let isRecording = false;
let longPressTimer = null;
let didLongPress = false;

function fmtTime(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const ss = s % 60;
  return String(m).padStart(2, '0') + ':' + String(ss).padStart(2, '0');
}

async function startRecording() {
  try {
    await recorder.start({
      noiseSuppression: els.optNoise.checked,
      autoGain: els.optAGC.checked,
      echoCancel: els.optEcho.checked,
      quality: Number(els.optQuality.value)
    });
  } catch (err) {
    console.error(err);
    showToast('دسترسی به میکروفون داده نشد ❌');
    return;
  }
  isRecording = true;
  els.app.classList.add('immersive');
  els.btnRecord.classList.add('recording');
  els.recTimer.hidden = false;
  els.micMeter.hidden = false;
  if (els.app.requestFullscreen) { els.app.requestFullscreen().catch(() => {}); }
  recorder.onTick = (elapsed) => { els.recTimer.textContent = fmtTime(elapsed); };
  recorder.onLevel = (lvl) => { els.micFill.style.width = Math.round(lvl * 100) + '%'; };
  showToast('ضبط شروع شد 🔴');
}

async function stopRecording() {
  const blob = await recorder.stop();
  isRecording = false;
  els.app.classList.remove('immersive');
  els.btnRecord.classList.remove('recording', 'paused');
  els.recTimer.hidden = true;
  els.micMeter.hidden = true;
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  if (blob && blob.size) {
    const url = URL.createObjectURL(blob);
    const ts = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
    els.downloadLink.href = url;
    els.downloadLink.download = `clip-${ts}.webm`;
    els.downloadLink.click();
    setTimeout(() => URL.revokeObjectURL(url), 6000);
    showToast('کلیپ ذخیره شد ✅ (فایل webm)');
  } else {
    showToast('ضبطی ثبت نشد');
  }
}

els.btnRecord.addEventListener('pointerdown', () => {
  didLongPress = false;
  longPressTimer = setTimeout(() => {
    if (!isRecording) return; // idle long-press: a plain tap on release will still start recording
    didLongPress = true;
    if (recorder.paused) { recorder.resume(); els.btnRecord.classList.remove('paused'); showToast('ضبط ادامه یافت'); }
    else { recorder.pause(); els.btnRecord.classList.add('paused'); showToast('ضبط موقتاً متوقف شد (نگه‌دارید برای ادامه)'); }
  }, 500);
});
els.btnRecord.addEventListener('pointerup', () => {
  clearTimeout(longPressTimer);
  if (didLongPress) return;
  if (isRecording) stopRecording(); else startRecording();
});

// ============================================================
// PWA: service worker + install
// ============================================================
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}

const btnInstall = $('btnInstall');
let deferredInstallPrompt = null;
const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
const isSecure = window.isSecureContext;

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  if (!isStandalone) btnInstall.hidden = false;
});

window.addEventListener('appinstalled', () => {
  btnInstall.hidden = true;
  showToast('اپ با موفقیت نصب شد ✅');
});

btnInstall.addEventListener('click', async () => {
  if (deferredInstallPrompt) {
    deferredInstallPrompt.prompt();
    const { outcome } = await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    if (outcome !== 'accepted') btnInstall.hidden = false;
  } else if (isIOS) {
    showToast('برای نصب: دکمه Share را بزنید ← «Add to Home Screen» را انتخاب کنید', 5000);
  } else {
    showToast('اگر آدرس سایت https باشد، از منوی مرورگر گزینه Install app را بزنید', 4500);
  }
});

if (!isStandalone) {
  if (isIOS) {
    // Safari never fires beforeinstallprompt - always show the button with manual instructions
    btnInstall.hidden = false;
  }
  if (!isSecure) {
    // file:// or plain http:// - install + mic will not work here at all
    setTimeout(() => showToast('این صفحه روی HTTPS باز نشده؛ نصب و ضبط صدا کار نمی‌کنند. فایل README را برای میزبانی رایگان ببینید.', 6000), 800);
  }
}

// ============================================================
// Boot
// ============================================================
initTheme();
loadProject();
})();
