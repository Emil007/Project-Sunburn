/* Service worker + loader.
   1. Cross-origin isolation (needed for SharedArrayBuffer) on plain static hosts: same-origin
      responses are re-served with COOP/COEP headers.
   2. Offline web app: responses are cached; the network is tried first (so updates arrive at
      once), the cache is used when offline. The large SoundFont is served from the cache first. */
const CACHE = 'holiday-island-v1';
if (typeof window === 'undefined') {
  self.addEventListener('install', () => self.skipWaiting());
  self.addEventListener('activate', (e) => e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })()));
  const isolate = (res) => {
    if (!res || res.status === 0) return res;
    const h = new Headers(res.headers);
    h.set('Cross-Origin-Embedder-Policy', 'require-corp');
    h.set('Cross-Origin-Opener-Policy', 'same-origin');
    h.set('Cross-Origin-Resource-Policy', 'same-origin');
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
  };
  self.addEventListener('fetch', (e) => {
    const r = e.request;
    if (r.cache === 'only-if-cached' && r.mode !== 'same-origin') return;
    const url = new URL(r.url);
    if (url.origin !== self.location.origin) return;
    if (r.method !== 'GET' || r.headers.has('range')) { e.respondWith(fetch(r).then(isolate)); return; }
    e.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const cacheFirst = url.pathname.includes('/soundfont/');
      if (cacheFirst) { const hit = await cache.match(r, { ignoreSearch: true }); if (hit) return isolate(hit); }
      try {
        const res = await fetch(r);
        if (res.ok && res.type === 'basic') cache.put(r, res.clone()).catch(() => {});
        return isolate(res);
      } catch (err) {
        const hit = await cache.match(r, { ignoreSearch: true }) || (r.mode === 'navigate' ? await cache.match('./index.html') : null);
        if (hit) return isolate(hit);
        throw err;
      }
    })());
  });
} else if ('serviceWorker' in navigator && window.isSecureContext && !/electron/i.test(navigator.userAgent)) {
  const key = 'coi-reloaded';
  navigator.serviceWorker.register(document.currentScript.src).then((reg) => {
    if (window.crossOriginIsolated) { try { sessionStorage.removeItem(key); } catch (e) { /* ignore */ } return; }
    const reload = () => { if (!sessionStorage.getItem(key)) { sessionStorage.setItem(key, '1'); location.reload(); } };
    if (reg.active && !navigator.serviceWorker.controller) reload();
    navigator.serviceWorker.addEventListener('controllerchange', reload);
  }).catch((e) => console.warn('service worker failed', e));
}
