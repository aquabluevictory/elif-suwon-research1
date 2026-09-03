// api/posts.js — Vercel Node.js Serverless Function
//
// 글 정본(正本)을 서버에 둔다. 지금까지 발행은 "HTML을 새로 구워서 다시 올리는
// 일"이었다. 이 엔드포인트를 붙이면 발행이 POST 한 번으로 끝나고, 이미 열려 있는
// 리더 창들도 몇 초 안에 스스로 따라온다.
//
// ── 계약 ────────────────────────────────────────────────────────────────
//   GET    /api/posts              → { ok, v, ts, posts:[...] }
//   GET    /api/posts?v=12         → 버전 그대로면 { ok, v:12, changed:false }  (수십 바이트)
//   GET    /api/posts?whoami=1     → 발행 키가 유효한지만 확인 (본문 안 내려줌)
//   GET    /api/posts?diag=1       → 어떤 저장소가 붙어 있는지 (키는 절대 안 보여줌)
//   POST   /api/posts              → { post:{...} }              한 건 등록/수정
//                                    { posts:[...], replace:true } 전체 교체
//   DELETE /api/posts?id=abc       → 한 건 삭제
//
// 읽기는 공개, 쓰기는 전부 `Authorization: Bearer <ADMIN_TOKEN>`을 요구한다.
// ADMIN_TOKEN이 설정돼 있지 않으면 쓰기는 전부 막힌다(열린 채로 죽지 않는다).
//
// ── 저장소 ──────────────────────────────────────────────────────────────
// Redis REST(Vercel KV / Upstash) 한 종류만 본다. 둘 다 REST 프로토콜이 같아서
// 환경변수 이름만 다르고, Vercel 마켓플레이스에서 Upstash를 붙이면 둘 중 하나가
// 자동으로 주입된다.
//   KV_REST_API_URL      / KV_REST_API_TOKEN
//   UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN
//
// 아무것도 없으면 인스턴스 메모리로 떨어진다. 로컬 `vercel dev`에서 흐름을 확인할
// 때는 쓸 만하지만 영구 저장이 아니다 — 콜드스타트마다 날아가고 인스턴스마다 따로
// 논다. 응답의 `persistent:false`가 그 사실을 계속 알려 준다.
//
// ── 한계 ────────────────────────────────────────────────────────────────
// 쓰기는 read-modify-write다. 저자가 한 명이면 문제가 없지만, 두 사람이 정확히
// 같은 순간에 쓰면 뒤에 쓴 쪽이 이긴다. 그래서 클라이언트가 `ifV`(내가 본 버전)를
// 같이 보내면 어긋날 때 409를 돌려준다. 클라이언트는 받아서 다시 읽고 재시도한다.
// 완전한 원자성이 필요하면 Redis Lua(EVAL)로 옮겨야 한다.

import crypto from 'node:crypto';

const KEY = 'news:posts:v1';

const MAX_POSTS = 500;
const MAX_POST_BYTES = 512 * 1024;        // 글 한 건(첨부 data URI 포함)
const MAX_TOTAL_BYTES = 4 * 1024 * 1024;  // 저장소 전체
const MAX_BODY_BYTES = 4 * 1024 * 1024;   // 요청 본문

const REDIS_URL =
  process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '';
const REDIS_TOKEN =
  process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';

const HAS_REDIS = !!(REDIS_URL && REDIS_TOKEN);

/* ── 저장소 어댑터 ───────────────────────────────────────────────────── */

let memState = null; // Redis가 없을 때만 쓰는 임시 보관함

async function redis(cmd) {
  const r = await fetch(REDIS_URL, {
    method: 'POST',
    headers: {
      authorization: 'Bearer ' + REDIS_TOKEN,
      'content-type': 'application/json',
    },
    body: JSON.stringify(cmd),
  });
  const text = await r.text();
  if (!r.ok) throw new Error('redis ' + r.status + ' ' + text.slice(0, 200));
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    throw new Error('redis: 응답을 해석하지 못했어요');
  }
  if (j.error) throw new Error('redis: ' + j.error);
  return j.result;
}

const EMPTY = () => ({ v: 0, ts: Date.now(), posts: [] });

async function readState() {
  if (!HAS_REDIS) return memState || (memState = EMPTY());
  const raw = await redis(['GET', KEY]);
  if (!raw) return EMPTY();
  try {
    const s = JSON.parse(raw);
    if (!s || !Array.isArray(s.posts)) return EMPTY();
    s.v = s.v | 0;
    return s;
  } catch {
    return EMPTY();
  }
}

async function writeState(state) {
  const json = JSON.stringify(state);
  if (byteLen(json) > MAX_TOTAL_BYTES) {
    const e = new Error('저장소 상한(4MB)을 넘었어요. 오래된 글을 지우거나 큰 첨부를 URL로 바꿔 주세요');
    e.status = 413;
    throw e;
  }
  if (!HAS_REDIS) {
    memState = state;
    return;
  }
  await redis(['SET', KEY, json]);
}

/* ── 유틸 ────────────────────────────────────────────────────────────── */

const byteLen = (s) => Buffer.byteLength(String(s), 'utf8');

function safeEqual(a, b) {
  const A = Buffer.from(String(a), 'utf8');
  const B = Buffer.from(String(b), 'utf8');
  // 길이가 다르면 timingSafeEqual이 던진다. 길이 자체는 비밀이 아니므로
  // 같은 길이로 패딩해 비교하고 길이 일치 여부를 따로 AND 한다.
  const len = Math.max(A.length, B.length, 1);
  const pa = Buffer.alloc(len);
  const pb = Buffer.alloc(len);
  A.copy(pa);
  B.copy(pb);
  return crypto.timingSafeEqual(pa, pb) && A.length === B.length;
}

function bearer(req) {
  const h = req.headers['authorization'] || req.headers['Authorization'] || '';
  const m = /^Bearer\s+(.+)$/i.exec(String(h).trim());
  return m ? m[1].trim() : '';
}

function authorized(req) {
  if (!ADMIN_TOKEN) return false; // 키가 없으면 쓰기는 통째로 잠긴다
  const t = bearer(req);
  return !!t && safeEqual(t, ADMIN_TOKEN);
}

async function rawBody(req) {
  if (req.body !== undefined && req.body !== null && typeof req.body === 'object') {
    return req.body; // Vercel Node 런타임이 이미 JSON을 파싱해 준 경우
  }
  const chunks = [];
  let total = 0;
  for await (const c of req) {
    total += c.length;
    if (total > MAX_BODY_BYTES) {
      const e = new Error('요청 본문이 너무 커요');
      e.status = 413;
      throw e;
    }
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    const e = new Error('JSON을 해석하지 못했어요');
    e.status = 400;
    throw e;
  }
}

/* ── 들어오는 글 정리 ─────────────────────────────────────────────────
   쓰기에는 토큰이 필요하니 위협 모델은 "적대적 입력"보다 "오타난 페이로드가
   저장소를 망치는 것"에 가깝다. 그래도 구조는 서버에서 확정한다 — 알 수 없는
   키는 버리고, 문자열은 자르고, 첨부는 알려진 필드만 남긴다. */

const CATS = ['tech', 'world', 'econ', 'sci', 'cult', 'sport', 'life', 'health'];
const MEDIA_KEYS = ['kind', 'name', 'url', 'embed', 'data', 'poster', 'code', 'lang', 'h', 'unavailable'];

const str = (v, n) => (v == null ? '' : String(v).slice(0, n));

function cleanMedia(m) {
  if (!m || typeof m !== 'object') return null;
  const out = {};
  for (const k of MEDIA_KEYS) {
    if (m[k] === undefined || m[k] === null) continue;
    if (k === 'unavailable') out[k] = !!m[k];
    else if (k === 'h') out[k] = Number(m[k]) || undefined;
    else if (k === 'code') out[k] = str(m[k], 400 * 1024);
    else if (k === 'data' || k === 'poster') {
      const s = String(m[k]);
      if (/^data:/.test(s)) out[k] = s; // 크기는 아래 글 단위 상한에서 걸린다
    } else out[k] = str(m[k], 2048);
  }
  out.kind = out.kind || 'file';
  return out;
}

function cleanPost(p) {
  if (!p || typeof p !== 'object') return null;
  const id = str(p.id, 80).replace(/[^\w.:-]/g, '');
  if (!id) return null;
  const post = {
    id,
    title: str(p.title, 300),
    body: str(p.body, 200 * 1024),
    source: str(p.source, 80) || '편집부',
    cat: CATS.indexOf(p.cat) >= 0 ? p.cat : 'tech',
    live: !!p.live,
    feature: !!p.feature,
    edited: !!p.edited,
    ts: Number(p.ts) > 0 ? Number(p.ts) : Date.now(),
    likes: Math.max(0, Number(p.likes) | 0),
    media: cleanMedia(p.media),
    comments: Array.isArray(p.comments)
      ? p.comments.slice(0, 200).map((c) => ({
          id: str(c && c.id, 40) || 'c' + Math.random().toString(36).slice(2, 8),
          name: str(c && c.name, 30) || '독자',
          text: str(c && c.text, 1000),
          ts: Number(c && c.ts) > 0 ? Number(c.ts) : Date.now(),
          likes: Math.max(0, Number(c && c.likes) | 0),
        }))
      : [],
  };
  if (!post.title) return null;
  const size = byteLen(JSON.stringify(post));
  if (size > MAX_POST_BYTES) {
    const e = new Error(
      '글 한 건이 상한(512KB)을 넘었어요 — 큰 이미지는 img/ 경로나 외부 URL로 넣어 주세요'
    );
    e.status = 413;
    throw e;
  }
  return post;
}

const byTsDesc = (a, b) => (b.ts || 0) - (a.ts || 0);

/* ── CORS ────────────────────────────────────────────────────────────
   같은 도메인에 함께 배포했으면 헤더가 아예 필요 없다. api만 따로 올렸다면
   Vercel 환경변수 ALLOWED_ORIGINS에 리더 주소를 쉼표로 넣는다. read.js와 같은
   규칙이다. */
function applyCors(req, res) {
  const allow = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!allow.length) return;
  const origin = req.headers.origin;
  if (origin && allow.indexOf(origin) >= 0) {
    res.setHeader('access-control-allow-origin', origin);
    res.setHeader('vary', 'origin');
    res.setHeader('access-control-allow-methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('access-control-allow-headers', 'content-type, authorization');
    res.setHeader('access-control-max-age', '86400');
  }
}

/* ── 핸들러 ──────────────────────────────────────────────────────────── */

export default async function handler(req, res) {
  applyCors(req, res);
  res.setHeader('x-store', HAS_REDIS ? 'redis' : 'memory');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  try {
    if (req.method === 'GET') return await handleGet(req, res);
    if (req.method === 'POST') return await handleWrite(req, res);
    if (req.method === 'DELETE') return await handleDelete(req, res);
    res.setHeader('allow', 'GET, POST, DELETE, OPTIONS');
    res.status(405).json({ ok: false, error: 'method-not-allowed' });
  } catch (e) {
    const status = e && e.status ? e.status : 500;
    res.status(status).json({ ok: false, error: String((e && e.message) || e) });
  }
}

async function handleGet(req, res) {
  const q = req.query || {};

  if (q.diag) {
    res.setHeader('cache-control', 'no-store');
    const state = await readState().catch(() => null);
    res.status(200).json({
      ok: true,
      store: HAS_REDIS ? 'redis' : 'memory',
      persistent: HAS_REDIS,
      writable: !!ADMIN_TOKEN,
      posts: state ? state.posts.length : null,
      v: state ? state.v : null,
      hint: HAS_REDIS
        ? null
        : 'Redis가 안 붙어 있어요 — 지금 저장한 글은 함수가 잠들면 사라집니다',
    });
    return;
  }

  if (q.whoami) {
    res.setHeader('cache-control', 'no-store');
    if (!ADMIN_TOKEN) {
      res.status(503).json({ ok: false, error: 'no-admin-token', writable: false });
      return;
    }
    if (!authorized(req)) {
      res.status(401).json({ ok: false, error: 'unauthorized' });
      return;
    }
    res.status(200).json({ ok: true, writable: true, store: HAS_REDIS ? 'redis' : 'memory', persistent: HAS_REDIS });
    return;
  }

  const state = await readState();

  // 버전 확인만 — 바뀐 게 없으면 수십 바이트로 끝낸다.
  // s-maxage를 짧게 줘서 방문자가 몇이든 원본 호출은 몇 초에 한 번으로 눌린다.
  if (q.v !== undefined && String(q.v) !== '' && Number(q.v) === state.v) {
    res.setHeader('cache-control', 'public, s-maxage=3, stale-while-revalidate=10');
    res.status(200).json({ ok: true, v: state.v, changed: false });
    return;
  }

  res.setHeader('cache-control', 'public, s-maxage=3, stale-while-revalidate=10');
  res.status(200).json({
    ok: true,
    v: state.v,
    ts: state.ts,
    changed: true,
    persistent: HAS_REDIS,
    posts: state.posts.slice().sort(byTsDesc),
  });
}

async function handleWrite(req, res) {
  res.setHeader('cache-control', 'no-store');
  if (!ADMIN_TOKEN) {
    res.status(503).json({
      ok: false,
      error: 'ADMIN_TOKEN이 설정되지 않았어요 — Vercel 환경변수에 넣고 다시 배포해 주세요',
    });
    return;
  }
  if (!authorized(req)) {
    res.status(401).json({ ok: false, error: '발행 키가 맞지 않아요' });
    return;
  }

  const body = await rawBody(req);
  const state = await readState();

  // 낙관적 동시성 — 내가 본 버전과 서버 버전이 다르면 덮어쓰지 않고 되돌려준다
  if (body.ifV !== undefined && body.ifV !== null && Number(body.ifV) !== state.v) {
    res.status(409).json({
      ok: false,
      error: 'version-conflict',
      v: state.v,
      posts: state.posts.slice().sort(byTsDesc),
    });
    return;
  }

  if (body.replace) {
    const list = Array.isArray(body.posts) ? body.posts : [];
    const cleaned = list.map(cleanPost).filter(Boolean).slice(0, MAX_POSTS);
    state.posts = cleaned;
  } else {
    const post = cleanPost(body.post);
    if (!post) {
      res.status(400).json({ ok: false, error: '제목과 id가 있는 글이 필요해요' });
      return;
    }
    const idx = state.posts.findIndex((p) => p.id === post.id);
    if (idx >= 0) state.posts[idx] = post;
    else state.posts.unshift(post);
    if (state.posts.length > MAX_POSTS) {
      state.posts = state.posts.sort(byTsDesc).slice(0, MAX_POSTS);
    }
  }

  state.v = (state.v | 0) + 1;
  state.ts = Date.now();
  await writeState(state);

  res.status(200).json({
    ok: true,
    v: state.v,
    ts: state.ts,
    persistent: HAS_REDIS,
    posts: state.posts.slice().sort(byTsDesc),
  });
}

async function handleDelete(req, res) {
  res.setHeader('cache-control', 'no-store');
  if (!ADMIN_TOKEN) {
    res.status(503).json({ ok: false, error: 'ADMIN_TOKEN이 설정되지 않았어요' });
    return;
  }
  if (!authorized(req)) {
    res.status(401).json({ ok: false, error: '발행 키가 맞지 않아요' });
    return;
  }

  const id = String((req.query && req.query.id) || '').trim();
  if (!id) {
    res.status(400).json({ ok: false, error: 'id가 필요해요' });
    return;
  }

  const state = await readState();
  const before = state.posts.length;
  state.posts = state.posts.filter((p) => p.id !== id);

  if (state.posts.length !== before) {
    state.v = (state.v | 0) + 1;
    state.ts = Date.now();
    await writeState(state);
  }

  res.status(200).json({
    ok: true,
    v: state.v,
    ts: state.ts,
    removed: before - state.posts.length,
    posts: state.posts.slice().sort(byTsDesc),
  });
}
