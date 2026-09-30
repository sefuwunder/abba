// sw.js — Abba service worker: app-shell cache for instant loads and
// installability. Only static assets are cached; every /api/* request
// (notes, sync, mesh) always hits the network so the app never serves
// stale circle data. The CACHE name below is version-stamped by the
// server on every serve, so a new deploy busts the cache automatically.
const CACHE = "abba-shell-__V__";
const SHELL = [
  "/", "/index.html",
  "/styles.css", "/app.js", "/favicon.svg",
  "/manifest.webmanifest",
  "/icon-192.png", "/icon-512.png", "/icon-maskable-512.png",
  "/apple-touch-icon.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(SHELL))
      .catch(() => {})
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  const url = new URL(e.request.url);
  if (url.pathname.startsWith("/api/")) return; // app data: network only
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then((hit) => {
      if (hit) return hit;
      return fetch(e.request).then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        }
        return res;
      });
    })
  );
});
