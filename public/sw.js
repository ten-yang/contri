// Contri service worker: keeps the app's own files on the phone so it opens fast.
// Never touches /api (money data always comes fresh) or other websites (fonts).
const CACHE = "contri-v13";
const CORE = ["/", "/app.js?v=13", "/manifest.webmanifest?v=2", "/icon-192.png", "/favicon-32.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(CORE)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/api/")) return;
  if (req.mode === "navigate"){
    // Page loads: try the network first so updates show up; use the saved copy if offline or very slow.
    e.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const net = fetch(req).then(res => { if (res.ok) cache.put("/", res.clone()); return res; });
      const saved = await cache.match("/");
      if (!saved) return net;
      const slow = new Promise(r => setTimeout(() => r(saved), 2500));
      return Promise.race([net.catch(() => saved), slow]);
    })());
    return;
  }
  // App files: versioned or rarely changed, so use the saved copy and fetch it once if missing.
  e.respondWith(caches.open(CACHE).then(async cache => {
    const hit = await cache.match(req);
    if (hit) return hit;
    const res = await fetch(req);
    if (res.ok && res.type === "basic") cache.put(req, res.clone());
    return res;
  }));
});
