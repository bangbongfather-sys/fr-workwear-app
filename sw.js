// NJ SAFETY — Service Worker v2 (오프라인 지원)
//
// 캐싱 전략:
//  - 같은 출처(앱 셸: index.html, 아이콘, 폰트 등): network-first → 실패 시 캐시
//    (배포 즉시 반영되면서 오프라인에서도 동작)
//  - CDN 자산(React/Babel/Chart.js/jsPDF/xlsx/html2canvas/Pretendard): cache-first
//    (버전 고정 URL이라 불변 — 한 번 받으면 재다운로드 불필요. 이게 없으면 오프라인에서 앱이 아예 안 뜸)
//  - /api/* (Notion·입찰·동기화 프록시): 캐시 안 함 — 오프라인이면 실패하고 앱이 자체 처리
//  - Firebase·Google 인증 등 그 외 외부 도메인: 개입하지 않음 (조용히 실패하도록)
const VERSION = 'nj-safety-v4'; // v4: React 프로덕션 빌드 전환 + JSX 컴파일 캐시 도입

const SHELL = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-192-maskable.png',
  '/icon-512-maskable.png',
];

// index.html <head>의 CDN <script>/<link>와 반드시 일치시킬 것 (URL 바뀌면 여기도 갱신)
const CDN_ASSETS = [
  'https://unpkg.com/react@18/umd/react.development.js',
  'https://unpkg.com/react-dom@18/umd/react-dom.development.js',
  'https://unpkg.com/@babel/standalone@7/babel.min.js',
  'https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js',
  'https://cdn.jsdelivr.net/npm/xlsx-js-style@1.2.0/dist/xlsx.bundle.js',
  'https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js',
  'https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js',
  'https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable.min.css',
];

// cache-first 적용 호스트 (폰트 woff2 등 CSS가 끌어오는 파일도 런타임에 여기로 캐싱됨)
const CDN_HOSTS = ['unpkg.com', 'cdn.jsdelivr.net'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION).then(async (cache) => {
      await cache.addAll(SHELL);
      // CDN은 개별 처리 — 하나 실패해도 설치는 진행 (런타임 캐싱이 메꿔줌)
      await Promise.allSettled(
        CDN_ASSETS.map(async (url) => {
          const res = await fetch(new Request(url, { mode: 'cors', credentials: 'omit' }));
          if (res.ok) await cache.put(url, res);
        })
      );
    }).then(() => self.skipWaiting())
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
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.origin === self.location.origin) {
    // 동기화/입찰/노션 프록시 — 절대 캐시하지 않음 (네트워크 전용)
    if (url.pathname.startsWith('/api/')) return;
    // 앱 셸: network-first → 캐시 폴백 → 내비게이션이면 index.html 폴백
    event.respondWith(
      fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(VERSION).then((cache) => cache.put(req, copy)).catch(() => {});
        return res;
      }).catch(() =>
        caches.match(req).then((m) => m || (req.mode === 'navigate' ? caches.match('/index.html') : Response.error()))
      )
    );
    return;
  }

  if (CDN_HOSTS.includes(url.hostname)) {
    // CDN: cache-first (버전 고정 URL = 불변)
    event.respondWith(
      caches.match(req).then((m) => m || fetch(req).then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(VERSION).then((cache) => cache.put(req, copy)).catch(() => {});
        }
        return res;
      }))
    );
    return;
  }

  // 그 외 외부 도메인 (Firebase, accounts.google.com, googleapis 등) — 개입하지 않음
});
