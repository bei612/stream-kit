// Cache only the public offline notice. API, credentials, configuration and
// media always use the network; each deployment prefix owns a separate cache.
const CACHE_PREFIX = `stream-kit-offline:${self.registration.scope}:`;
const CACHE = `${CACHE_PREFIX}v1`;
const OFFLINE = new URL('offline.html', self.registration.scope).href;

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.add(OFFLINE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith(CACHE_PREFIX) && key !== CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.mode !== 'navigate' || event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  event.respondWith(fetch(event.request).catch(async () => {
    const cache = await caches.open(CACHE);
    return await cache.match(OFFLINE) || Response.error();
  }));
});
