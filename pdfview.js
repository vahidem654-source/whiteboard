// ============================================================
// File loading: turns uploaded PDFs / images into "file docs"
// { id, kind:'file', name, pages:[{ src, w, h, strokes, redo }], activePageIndex }
//
// PDFs render progressively: page 1 is handed back via onFirstPage as soon as
// it's ready so the user can start working immediately, while remaining pages
// stream in one at a time via onPageAdded instead of making them wait for the
// whole book to finish.
// ============================================================

function computeTargetWidth() {
  // Match rendering resolution to the actual screen instead of a fixed high
  // value - much faster on phones without any visible loss of sharpness.
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const w = Math.round((window.innerWidth || 1000) * dpr * 1.05);
  return Math.max(900, Math.min(1500, w));
}

function fileDoc(name, pages) {
  return {
    id: 'd_' + Math.random().toString(36).slice(2, 10),
    kind: 'file',
    name,
    pages,
    activePageIndex: 0
  };
}

async function loadPdfFile(file, callbacks = {}) {
  const { onFirstPage, onPageAdded, onDone } = callbacks;
  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  const targetWidth = computeTargetWidth();
  const doc = fileDoc(file.name.replace(/\.pdf$/i, ''), []);
  doc.totalPages = pdf.numPages;

  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const base = page.getViewport({ scale: 1 });
    const scale = targetWidth / base.width;
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport }).promise;
    const src = canvas.toDataURL('image/jpeg', 0.85);
    const pageObj = { src, w: canvas.width, h: canvas.height, strokes: [], redo: [] };
    doc.pages.push(pageObj);

    if (i === 1 && onFirstPage) onFirstPage(doc);
    else if (onPageAdded) onPageAdded(doc, pageObj, i - 1);

    // Yield back to the browser so the UI (already showing page 1) stays smooth
    // while the rest of the book keeps rendering in the background.
    await new Promise((r) => setTimeout(r, 0));
  }

  if (onDone) onDone(doc);
  return doc;
}

function loadImageFile(file) {
  const targetWidth = computeTargetWidth();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        let w = img.naturalWidth, h = img.naturalHeight;
        if (w > targetWidth * 1.6) {
          const s = (targetWidth * 1.6) / w;
          w = Math.round(w * s);
          h = Math.round(h * s);
          const c = document.createElement('canvas');
          c.width = w; c.height = h;
          c.getContext('2d').drawImage(img, 0, 0, w, h);
          resolve({ src: c.toDataURL('image/jpeg', 0.88), w, h, strokes: [], redo: [] });
        } else {
          resolve({ src: reader.result, w, h, strokes: [], redo: [] });
        }
      };
      img.onerror = reject;
      img.src = reader.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// callbacks: { onFirstPage(doc), onPageAdded(doc, page, index), onDone(doc) }
async function loadUploadedFiles(fileList, callbacks = {}) {
  const files = Array.from(fileList);
  const pdfFiles = files.filter((f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name));
  const imageFiles = files.filter((f) => f.type.startsWith('image/'));

  for (const f of pdfFiles) {
    try { await loadPdfFile(f, callbacks); }
    catch (err) { console.error('PDF load failed', err); showToast('خطا در بازکردن PDF: ' + f.name); }
  }

  if (imageFiles.length) {
    const imageBatch = [];
    for (const f of imageFiles) {
      try { imageBatch.push(await loadImageFile(f)); } catch (err) { console.error('Image load failed', err); }
    }
    if (imageBatch.length) {
      const name = imageBatch.length > 1 ? `تصاویر (${imageBatch.length})` : 'تصویر';
      const doc = fileDoc(name, imageBatch);
      if (callbacks.onFirstPage) callbacks.onFirstPage(doc);
      if (callbacks.onDone) callbacks.onDone(doc);
    }
  }
}
