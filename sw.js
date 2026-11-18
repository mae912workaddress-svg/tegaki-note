/* Bump this version whenever deploying changed assets. */
const CACHE = 'tegaki-note-v1.3.2';
importScripts('./precache.js');
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(self.PRECACHE)));
  // An open editor keeps its current version until all tabs close.
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('tegaki-note-') && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  const request = event.request, url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const response = await fetch(request);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      event.waitUntil(cache.put(request, response.clone()).catch(() => {}));
      return response;
    } catch {
      const cached = await cache.match(request, { ignoreSearch: true });
      if (cached) return cached;
      if (request.mode === 'navigate') {
        const shell = await cache.match(new URL('./index.html', self.registration.scope));
        if (shell) return shell;
      }
      return new Response('オフラインです。オンラインで一度開いてからお使いください。', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }
  })());
});
