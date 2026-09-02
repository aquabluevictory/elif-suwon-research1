// api/read.js — Vercel Node.js Serverless Function (Edge 아님 — dns 모듈이 필요해서다)
//
// 클라이언트가 고른 기사 URL을 대신 받아와 CORS 문제 없이 돌려준다.
// EP(WebRead 헤지드 요청) 배열의 'self' 항목이 이 엔드포인트를 부른다.
//
// 이건 "열린 프록시"라서, 방어 없이 올리면 누구든 이 서버의 아웃바운드 IP와
// 형님 Vercel 할당량을 빌려 사내망/클라우드 메타데이터 서버를 스캔하는 데 쓸 수
// 있다(SSRF). 그래서 반드시:
//   1) http/https 스킴만 허용
//   2) 호스트를 DNS로 직접 풀어서 사설/루프백/링크로컬 대역이면 차단
//   3) 리다이렉트를 자동으로 따라가지 않고, 매 홉마다 위 검사를 다시 한다
//      (검사 통과 → 사설 IP로 리다이렉트하는 우회를 막는다)
//   4) 응답 크기와 시간에 상한을 둔다
//
// DNS 재바인딩(검사와 실제 연결 사이에 DNS 응답이 바뀌는 공격)까지 완전히 막으려면
// 확인한 IP에 직접 연결(핀닝)해야 하는데, 표준 fetch로는 어렵다. 여기 구현은
// "매 요청·매 리다이렉트마다 새로 검사"까지만 하는 실용적 방어선이다. 더 강한
// 보장이 필요하면 소켓 레벨에서 IP를 고정하는 라이브러리(예: node's http agent에
// lookup 콜백을 꽂는 방식)를 추가로 얹는 걸 권한다.

import dns from 'node:dns';
import net from 'node:net';

const dnsLookup = dns.promises.lookup;

const MAX_BYTES = 6 * 1024 * 1024; // 6MB — 기사 본문 하나로 충분한 상한
const TIMEOUT_MS = 12000;
const MAX_REDIRECTS = 5;

// ── 남용 방지 ────────────────────────────────────────────────────────────
// 이 엔드포인트는 인증이 없다. SSRF는 아래에서 막지만, "누가 얼마나 부를 수
// 있는가"는 별개 문제다. 주소만 알면 누구나 이 함수를 범용 URL 페처로 쓸 수
// 있고 비용은 이 프로젝트 소유자에게 청구된다.
//
// 오리진·리퍼러 검사는 여기서 쓸 수 없다. 클라이언트가 referrerPolicy:'no-referrer'로
// 부르는 데다 같은 도메인 GET이라 Origin도 안 붙는다. 정상 요청에 헤더가 없으니
// 헤더로 거르면 사이트 자신이 막힌다. 게다가 curl로는 위조가 자유롭다.
//
// 그래서 헤더와 무관하게 작동하는 IP 레이트리밋을 쓴다. 다만 이건 인스턴스
// 메모리 기반이라 완전한 방어가 아니다 — 서버리스는 인스턴스가 여러 개 뜨고
// 콜드스타트마다 카운터가 초기화된다. 분산 공격은 못 막는다. 확실히 막으려면
// Vercel KV / Upstash 같은 공유 저장소로 옮겨야 한다. 여기 있는 건 실수와
// 가벼운 남용을 걸러 청구서가 폭주하지 않게 하는 과속방지턱이다.
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_IP = 30;        // IP당 분당
const RATE_MAX_INSTANCE = 300; // 인스턴스 전체 분당 (백스톱)
const RATE_MAX_TRACKED_IPS = 5000;

const ipHits = new Map(); // ip -> 최근 요청 시각 배열
let instanceHits = [];

function recent(arr, now) {
  const cut = now - RATE_WINDOW_MS;
  let i = 0;
  while (i < arr.length && arr[i] <= cut) i++;
  return i ? arr.slice(i) : arr;
}

function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff) return xff.split(',')[0].trim();
  return req.headers['x-real-ip'] || req.socket?.remoteAddress || 'unknown';
}

// 통과하면 null, 막히면 남은 대기 초
function rateLimit(req) {
  const now = Date.now();

  instanceHits = recent(instanceHits, now);
  if (instanceHits.length >= RATE_MAX_INSTANCE) {
    return Math.ceil((instanceHits[0] + RATE_WINDOW_MS - now) / 1000);
  }

  const ip = clientIp(req);
  const hits = recent(ipHits.get(ip) || [], now);
  if (hits.length >= RATE_MAX_IP) {
    ipHits.set(ip, hits);
    return Math.ceil((hits[0] + RATE_WINDOW_MS - now) / 1000);
  }

  hits.push(now);
  ipHits.set(ip, hits);
  instanceHits.push(now);

  // Map이 무한히 커지지 않게 정리한다 (메모리 고갈 자체가 공격 표면이다)
  if (ipHits.size > RATE_MAX_TRACKED_IPS) {
    for (const [k, v] of ipHits) {
      if (recent(v, now).length === 0) ipHits.delete(k);
      if (ipHits.size <= RATE_MAX_TRACKED_IPS) break;
    }
  }
  return null;
}

// ── CORS ────────────────────────────────────────────────────────────────
// 같은 도메인에 배포했으면(PROXY_BASE='') CORS 헤더 자체가 필요 없다. 그래서
// 기본값은 헤더를 안 붙이는 것이다. api만 별도 프로젝트로 올렸다면 Vercel
// 환경변수 ALLOWED_ORIGINS에 리더 주소를 넣는다. 쉼표로 여러 개 가능.
//   예) ALLOWED_ORIGINS=https://my-reader.vercel.app
//
// 주의 — 이건 남의 웹페이지가 이 프록시를 자기 CORS 백엔드로 쓰는 것만 막는다.
// curl·스크립트 직접 호출은 CORS와 무관하다. 그쪽은 위 레이트리밋 담당이다.
const ALLOWED_ORIGINS = String(process.env.ALLOWED_ORIGINS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);

function applyCors(req, res) {
  const origin = req.headers.origin;
  if (!origin) return; // 같은 도메인 요청 — 브라우저가 Origin을 안 보낸다
  if (ALLOWED_ORIGINS.includes('*')) {
    res.setHeader('access-control-allow-origin', '*');
    return;
  }
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('access-control-allow-origin', origin);
    res.setHeader('vary', 'origin');
  }
}

function isPrivateIPv4(ip) {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return true;
  const [a, b] = p;
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local (클라우드 메타데이터 포함)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 0) return true;
  if (a >= 224) return true; // 멀티캐스트/예약
  return false;
}

function isPrivateIPv6(ip) {
  const low = ip.toLowerCase();
  if (low === '::1') return true; // loopback
  if (low.startsWith('fe80:')) return true; // link-local
  if (low.startsWith('fc') || low.startsWith('fd')) return true; // fc00::/7 ULA
  if (low.startsWith('::ffff:')) return isPrivateIPv4(low.slice(7)); // v4-mapped
  return false;
}

function isPrivateIP(ip) {
  const v = net.isIP(ip);
  if (v === 4) return isPrivateIPv4(ip);
  if (v === 6) return isPrivateIPv6(ip);
  return true; // 형태를 모르겠으면 막는다
}

async function assertPublicHost(hostname) {
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
    throw new Error('blocked-host');
  }
  if (net.isIP(hostname)) {
    if (isPrivateIP(hostname)) throw new Error('blocked-ip');
    return;
  }
  const records = await dnsLookup(hostname, { all: true, verbatim: true });
  if (!records.length) throw new Error('dns-fail');
  for (const r of records) {
    if (isPrivateIP(r.address)) throw new Error('blocked-ip');
  }
}

async function readCapped(body, maxBytes) {
  const reader = body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      try { await reader.cancel(); } catch {}
      throw new Error('too-large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c)));
}

async function safeFetch(rawUrl, redirectsLeft) {
  let u;
  try { u = new URL(rawUrl); } catch { throw new Error('bad-url'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('bad-scheme');
  await assertPublicHost(u.hostname);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(u.href, {
      signal: ctrl.signal,
      redirect: 'manual', // 리다이렉트는 직접 따라가며 매번 재검사한다
      headers: {
        'user-agent': 'Mozilla/5.0 (compatible; ResearchDeskReader/1.0)',
        accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5',
      },
    });

    if ([301, 302, 303, 307, 308].includes(r.status)) {
      const loc = r.headers.get('location');
      if (!loc) throw new Error('redirect-no-location');
      if (redirectsLeft <= 0) throw new Error('too-many-redirects');
      const next = new URL(loc, u.href).href;
      return safeFetch(next, redirectsLeft - 1);
    }

    const body = r.body ? await readCapped(r.body, MAX_BYTES) : Buffer.alloc(0);
    const contentType = r.headers.get('content-type') || 'text/plain; charset=utf-8';
    return { status: r.status, body, contentType, finalUrl: u.href };
  } finally {
    clearTimeout(timer);
  }
}

export default async function handler(req, res) {
  applyCors(req, res);

  if (req.method && req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('allow', 'GET, HEAD');
    res.status(405).json({ error: 'method-not-allowed' });
    return;
  }

  const retryAfter = rateLimit(req);
  if (retryAfter !== null) {
    res.setHeader('retry-after', String(retryAfter));
    res.status(429).json({ error: 'rate-limited', retryAfter });
    return;
  }

  const target = req.query?.url;
  if (!target || typeof target !== 'string') {
    res.status(400).json({ error: 'missing url' });
    return;
  }

  try {
    const out = await safeFetch(target, MAX_REDIRECTS);
    res.setHeader('content-type', out.contentType);
    res.setHeader('cache-control', 'public, s-maxage=120, stale-while-revalidate=600');
    res.status(out.status >= 200 && out.status < 400 ? 200 : 502).send(out.body);
  } catch (e) {
    res.status(502).json({ error: String(e && e.message ? e.message : e) });
  }
}
