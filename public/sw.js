/* sw.js: makes the app work with no signal.
 *
 * Two caches, on purpose:
 *   marchstone-v*  the app itself. Wiped and rebuilt on every version bump.
 *   fb-tiles-v1    map imagery. Survives updates, it is slow to rebuild and
 *                  the user chose to download it. The name predates the app's
 *                  and stays, because renaming it would throw that imagery away.
 */

/* Bump this and APP_VERSION in app.js together, by 0.01: this name is what
 * makes a phone fetch the new files, and that constant is what it then reports
 * in the footer. npm test fails if they differ. */
const CACHE = 'marchstone-v1.00';
const TILE_CACHE = 'fb-tiles-v1';
const TILE_LIMIT = 6000;

const SHELL = [
  // Clean URLs only: Cloudflare redirects index.html to / and privacy.html to
  // /privacy, and a cached redirect cannot answer a navigation.
  './',
  './privacy',
  './privacy.js',
  './app.css',
  './fonts.css',
  './app.js',
  './geo.js',
  './i18n.js',
  './io.js',
  './marks.js',
  './alerts.js',
  './track.js',
  './manifest.webmanifest',
  './icon.svg',
  './icon-192.png',
  './icon-512.png',
  './vendor/leaflet.js',
  './vendor/leaflet.css',
  './vendor/images/marker-icon.png',
  './vendor/images/marker-icon-2x.png',
  './vendor/images/marker-shadow.png',
  './vendor/images/layers.png',
  './vendor/images/layers-2x.png',
  './vendor/fonts/barlow-400-ext.woff2',
  './vendor/fonts/barlow-400.woff2',
  './vendor/fonts/barlow-500-ext.woff2',
  './vendor/fonts/barlow-500.woff2',
  './vendor/fonts/barlow-600-ext.woff2',
  './vendor/fonts/barlow-600.woff2',
  './vendor/fonts/barlowcond-600-ext.woff2',
  './vendor/fonts/barlowcond-600.woff2',
  './vendor/fonts/barlowcond-700-ext.woff2',
  './vendor/fonts/barlowcond-700.woff2',
];

const TILE_HOSTS = ['server.arcgisonline.com', 'tile.openstreetmap.org'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names
      .filter((n) => (n.startsWith('marchstone-v') || n.startsWith('fb-app-')) && n !== CACHE)
      .map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

async function trimTiles() {
  const cache = await caches.open(TILE_CACHE);
  const keys = await cache.keys();
  if (keys.length <= TILE_LIMIT) return;
  // Cache keys come back in insertion order, so the front is the oldest.
  await Promise.all(keys.slice(0, keys.length - TILE_LIMIT).map((k) => cache.delete(k)));
}

/* Tiles: cache first. Imagery for a given place never changes meaningfully,
 * and a cache hit is the difference between a usable map and a grey square. */
async function tileFirst(request) {
  const cache = await caches.open(TILE_CACHE);
  const hit = await cache.match(request, { ignoreVary: true });
  if (hit) return hit;
  try {
    const res = await fetch(request);
    if (res && res.ok) {
      cache.put(request, res.clone()).then(trimTiles).catch(() => {});
    }
    return res;
  } catch (e) {
    return new Response('', { status: 504, statusText: 'Offline, tile not saved' });
  }
}

/* App files: serve from cache at once, refresh in the background. The field
 * never waits on the network; the next launch picks up any update. */
async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(request, { ignoreSearch: true });
  const network = fetch(request).then((res) => {
    if (res && res.ok) cache.put(request, res.clone()).catch(() => {});
    return res;
  }).catch(() => null);
  return hit || network;
}

/* Nothing cached and no network: say so with a response, because handing
 * respondWith() a null throws and the page sees a bare network error. */
const offline = () => new Response('', { status: 504, statusText: 'Offline, not saved' });

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  if (TILE_HOSTS.includes(url.hostname)) {
    event.respondWith(tileFirst(request));
    return;
  }

  if (url.origin === self.location.origin) {
    if (request.mode === 'navigate') {
      event.respondWith(
        staleWhileRevalidate(request)
          .then(async (r) => r || (await caches.match(
            /\/privacy(\.html)?$/.test(url.pathname) ? './privacy' : './')) || offline())
      );
    } else {
      event.respondWith(staleWhileRevalidate(request).then((r) => r || offline()));
    }
  }
});
