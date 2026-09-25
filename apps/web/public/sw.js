/**
 * App-shell service worker.
 *
 * Scope is deliberately narrow: cache the static shell (HTML/CSS/JS/icons) so the app opens
 * offline, and never touch `/api/*`. Authenticated responses never enter the Cache Storage —
 * caching them would mean sharing them across whoever next opens this browser profile, which
 * PHASE 11 explicitly rules out. Offline data (checklist edits, photos, drafts) is handled by
 * the app's own IndexedDB queue (`src/offline`), not by this worker.
 */

const SHELL_CACHE = 'gsi-shell-v1';
const SHELL_URLS = ['/', '/index.html', '/manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_URLS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

function isApiRequest(url) {
  return url.pathname.startsWith('/api/');
}

function isStaticAsset(url) {
  return (
    url.pathname.startsWith('/assets/') ||
    url.pathname.startsWith('/icons/') ||
    /\.(?:js|css|woff2?|png|svg|ico|webmanifest)$/.test(url.pathname)
  );
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return; // mutations always go straight to the network (or the offline queue)

  const url = new URL(req.url);
  if (url.origin !== self.location.origin || isApiRequest(url)) return; // never intercept the API

  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).catch(() => caches.match('/index.html').then((res) => res ?? Response.error())),
    );
    return;
  }

  if (isStaticAsset(url)) {
    event.respondWith(
      caches.open(SHELL_CACHE).then(async (cache) => {
        const cached = await cache.match(req);
        const network = fetch(req)
          .then((res) => {
            if (res.ok) cache.put(req, res.clone());
            return res;
          })
          .catch(() => undefined);
        // Stale-while-revalidate: instant from cache when we have one, refreshed in the background.
        return cached ?? (await network) ?? Response.error();
      }),
    );
  }
});
