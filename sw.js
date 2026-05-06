// NJ SAFETY — Service Worker (network-first with offline fallback)
const VERSION = 'nj-safety-v1';
const PRECACHE = ['/', '/index.html', '/manifest.json', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION).then((cache) => cache.addAll(PRECACHE)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  // 외부 도메인 (Firebase, CDN, Google APIs 등) — 그냥 통과
  if (new URL(req.url).origin !== self.location.origin) return;
  // GET만 캐싱
  if (req.method !== 'GET') return;
  // 네트워크 우선 → 실패 시 캐시
  event.respondWith(
    fetch(req).then((res) => {
      const copy = res.clone();
      caches.open(VERSION).then((cache) => cache.put(req, copy)).catch(() => {});
      return res;
    }).catch(() => caches.match(req).then((m) => m || caches.match('/index.html')))
  );
});
