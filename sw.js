/* My Assistant service worker — offline app shell.
 * - Precaches every file the app needs; serves them cache-first (so it works fully offline).
 * - Updates: a new version installs in the background and WAITS until the user taps "Update now".
 * - Never touches IndexedDB, so updating can never erase tasks.
 * BUILD is stamped by `node tools/stamp-sw.mjs` from a hash of the shipped files. */
const BUILD = '5e2b87405a';
const CACHE_PREFIX = 'my-assistant-shell-';
const CACHE = CACHE_PREFIX + BUILD;
const ASSETS = [
  './',
  'index.html',
  'manifest.webmanifest',
  'app.css',
  'app.js',
  'dates.js',
  'db.js',
  'icons.js',
  'logic.js',
  'native.js',
  'store.js',
  'ui-kit.js',
  'icon.svg',
  'icon-192.png',
  'icon-512.png',
  'icon-maskable-512.png',
  'apple-touch-icon.png',
  'favicon-32.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // cache: 'reload' bypasses the HTTP cache so we never precache a stale file
    await Promise.all(ASSETS.map(async (url) => {
      const res = await fetch(new Request(url, { cache: 'reload' }));
      if (!res.ok) throw new Error(`Precache failed for ${url}: ${res.status}`);
      await cache.put(url, res);
    }));
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith(CACHE_PREFIX) && key !== CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // never intercept other origins
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    if (req.mode === 'navigate') {
      const shell = await cache.match('index.html');
      if (shell) return shell;
      try { return await fetch(req); } catch { return Response.error(); }
    }
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    return fetch(req);
  })());
});

self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'SKIP_WAITING') self.skipWaiting();
  if (data.type === 'STATUS' && event.ports && event.ports[0]) {
    event.waitUntil((async () => {
      const cache = await caches.open(CACHE);
      let cached = 0;
      for (const url of ASSETS) if (await cache.match(url)) cached++;
      event.ports[0].postMessage({ version: BUILD, cached, expected: ASSETS.length, complete: cached === ASSETS.length });
    })());
  }
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) { if ('focus' in c) return c.focus(); }
    return self.clients.openWindow('./');
  })());
});
