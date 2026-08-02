// ============================================================
// File loading: turns uploaded PDFs / images into "file docs"
// { id, kind:'file', name, pages:[{ src, w, h, strokes, redo }], activePageIndex }
// ============================================================

const TARGET_PAGE_WIDTH = 1600; // render resolution target for crisp zoom/quality

function fileDoc(name, pages) {
  return {
    id: 'd_' + Math.random().toString(36).slice(2, 10),
    kind: 'file',
    name,
    pages,
    activePageIndex: 0
  };
}

async function loadPdfFile(file) {
  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const base = page.getViewport({ scale: 1 });
    const scale = TARGET_PAGE_WIDTH / base.width;
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport }).promise;
    const src = canvas.toDataURL('image/jpeg', 0.9);
    pages.push({ src, w: canvas.width, h: canvas.height, strokes: [], redo: [] });
  }
  return fileDoc(file.name.replace(/\.pdf$/i, ''), pages);
}

function loadImageFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        // Downscale extremely large photos to keep memory sane, upscale small ones not needed
        let w = img.naturalWidth, h = img.naturalHeight;
        if (w > TARGET_PAGE_WIDTH * 1.6) {
          const s = (TARGET_PAGE_WIDTH * 1.6) / w;
          w = Math.round(w * s);
          h = Math.round(h * s);
          const c = document.createElement('canvas');
          c.width = w; c.height = h;
          c.getContext('2d').drawImage(img, 0, 0, w, h);
          resolve({ src: c.toDataURL('image/jpeg', 0.92), w, h, strokes: [], redo: [] });
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

async function loadUploadedFiles(fileList) {
  const files = Array.from(fileList);
  const docs = [];
  const imageBatch = [];
  for (const f of files) {
    if (f.type === 'application/pdf' || /\.pdf$/i.test(f.name)) {
      try { docs.push(await loadPdfFile(f)); }
      catch (err) { console.error('PDF load failed', err); showToast('خطا در بازکردن PDF: ' + f.name); }
    } else if (f.type.startsWith('image/')) {
      try { imageBatch.push(await loadImageFile(f)); }
      catch (err) { console.error('Image load failed', err); }
    }
  }
  if (imageBatch.length) {
    const name = imageBatch.length > 1 ? `تصاویر (${imageBatch.length})` : 'تصویر';
    docs.push(fileDoc(name, imageBatch));
  }
  return docs;
}
