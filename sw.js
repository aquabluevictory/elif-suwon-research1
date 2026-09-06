/* ═══════════════════════════════════════════════════════════════
   ELIF 리서치 — 서비스워커

   설계 원칙 하나: 정본은 절대로 낡은 사본을 주지 않는다.

   이 사이트의 진실은 data/posts.json 하나다. 서비스워커가 이 파일이나
   HTML을 캐시에서 먼저 주면 "발행했는데 사이트에 안 뜬다"는 증상이
   재발한다. 그래서 아래 전략은 타협하지 않는다.

     data/posts.json  → network-first  (오프라인일 때만 캐시)
     *.html           → network-first  (오프라인일 때만 캐시)
     img/*            → cache-first    (파일명에 해시가 있어 불변)
     그 외 정적 파일   → stale-while-revalidate

   가로채지 않는 것 (반드시):
     api.github.com          발행 API — 캐시되면 발행이 망가진다
     raw.githubusercontent   정본 읽기 경로
     GET 이외의 모든 요청
   ═══════════════════════════════════════════════════════════════ */

const VERSION    = 'elif-v1';
const CACHE_CORE = VERSION + '-core';
const CACHE_IMG  = VERSION + '-img';

/* 설치 즉시 받아둘 최소 자산. 실패해도 설치를 막지 않는다 —
   한 파일 404 때문에 서비스워커 전체가 죽는 사고를 피한다. */
const PRECACHE = [
  './',
  './index.html',
  './sync-config.js',
  './news-sync.js',
  './manifest.webmanifest',
  './icon-192.png'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_CORE)
      .then(c => Promise.allSettled(PRECACHE.map(u => c.add(u))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k.indexOf(VERSION) !== 0)   // 옛 버전 전부 삭제
            .map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

/* 캐시를 즉시 비우고 싶을 때: 페이지에서
     navigator.serviceWorker.controller.postMessage({type:'PURGE'})   */
self.addEventListener('message', event => {
  const d = event.data || {};
  if (d.type === 'PURGE') {
    event.waitUntil(caches.keys().then(ks => Promise.all(ks.map(k => caches.delete(k)))));
  }
  if (d.type === 'SKIP_WAITING') self.skipWaiting();
});

/* ── 전략 구현 ────────────────────────────────────────────────── */

async function networkFirst(request, cacheName) {
  try {
    const fresh = await fetch(request, { cache: 'no-store' });
    if (fresh && fresh.ok) {
      const c = await caches.open(cacheName);
      c.put(request, fresh.clone());          // 오프라인 대비 사본만 갱신
    }
    return fresh;
  } catch (e) {
    const hit = await caches.match(request);
    if (hit) return hit;                      // 네트워크가 죽었을 때만 캐시
    throw e;
  }
}

async function cacheFirst(request, cacheName) {
  const hit = await caches.match(request);
  if (hit) return hit;
  const fresh = await fetch(request);
  if (fresh && fresh.ok) {
    const c = await caches.open(cacheName);
    c.put(request, fresh.clone());
  }
  return fresh;
}

async function staleWhileRevalidate(request, cacheName) {
  const hit = await caches.match(request);
  const net = fetch(request).then(res => {
    if (res && res.ok) caches.open(cacheName).then(c => c.put(request, res.clone()));
    return res;
  }).catch(() => hit);
  return hit || net;
}

/* ── 라우팅 ───────────────────────────────────────────────────── */

self.addEventListener('fetch', event => {
  const req = event.request;

  // GET 이외는 손대지 않는다 (발행 PUT 등)
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch (e) { return; }

  // 다른 오리진은 통과시킨다 — GitHub API·raw·외부 프록시 전부 해당
  if (url.origin !== self.location.origin) return;

  // 정본 JSON — 절대 stale 금지
  if (url.pathname.indexOf('/data/') !== -1 && url.pathname.endsWith('.json')) {
    event.respondWith(networkFirst(req, CACHE_CORE));
    return;
  }

  // HTML — 항상 최신 코드
  if (req.mode === 'navigate' || url.pathname.endsWith('.html') || url.pathname.endsWith('/')) {
    event.respondWith(networkFirst(req, CACHE_CORE));
    return;
  }

  // 이미지 — 파일명이 불변이므로 캐시 우선
  if (url.pathname.indexOf('/img/') !== -1 || /\.(webp|jpg|jpeg|png|gif|svg)$/i.test(url.pathname)) {
    event.respondWith(cacheFirst(req, CACHE_IMG));
    return;
  }

  // 나머지 정적 자산
  event.respondWith(staleWhileRevalidate(req, CACHE_CORE));
});
