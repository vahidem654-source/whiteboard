const CACHE_NAME = 'boardclip-v3';
const CORE_ASSETS = [
  './',
  './index.html',
  './style.css',
  './storage.js',
  './board.js',
  './pdfview.js',
  './recorder.js',
  './app.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './favicon.png'
];

// PDF rendering depends on this library - precache it explicitly on install so PDF
// upload/viewing works offline right away, instead of only being cached lazily the
// first time someone happens to be online while opening a book.
const THIRDPARTY_ASSETS = [
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      await cache.addAll(CORE_ASSETS).catch(() => {});
      // Fetch third-party assets individually so one failure doesn't block the rest
      await Promise.all(THIRDPARTY_ASSETS.map(async (url) => {
        try {
          const res = await fetch(url, { mode: 'cors' });
          if (res && (res.ok || res.type === 'opaque')) await cache.put(url, res);
        } catch (e) { /* offline during install - will be cached on first successful online visit */ }
      }));
    })()
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

function timeout(ms) {
  return new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms));
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  const isSameOrigin = url.origin === self.location.origin;

  if (isSameOrigin) {
    // Cache-first for our own app shell
    event.respondWith(
      caches.match(req).then((cached) => cached || fetch(req).then((res) => {
        const resClone = res.clone();
        caches.open(CACHE_NAME).then((c) => c.put(req, resClone));
        return res;
      }).catch(() => cached))
    );
  } else {
    // Third-party (pdf.js, fonts): try the network briefly to stay fresh, but don't
    // let a slow/offline connection hang - fall back to cache quickly instead.
    event.respondWith(
      Promise.race([fetch(req), timeout(2500)])
        .then((res) => {
          const resClone = res.clone();
          caches.open(CACHE_NAME).then((c) => c.put(req, resClone));
          return res;
        })
        .catch(() => caches.match(req))
    );
  }
});
