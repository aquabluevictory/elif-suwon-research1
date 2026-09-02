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
  res.setHeader('access-control-allow-origin', '*');

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
