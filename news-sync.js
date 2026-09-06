/* news-sync.js — 정본 ↔ 열려 있는 모든 창
   ═══════════════════════════════════════════════════════════════════════
   지금까지 이 앱의 정본은 "각자의 브라우저"였다. 그래서 글을 쓰면 그 기기에만
   남았고, 남에게 보여 주려면 리더 HTML을 새로 구워 올려야 했다.

   이 파일이 하는 일은 하나다. 정본을 바깥으로 옮기고, 열려 있는 창들이
   그걸 계속 따라오게 한다. 정본을 어디에 두는지는 두 가지 중에 고른다.

   ── backend: 'github' (기본) ───────────────────────────────────────────
   서버가 필요 없다. 저장소의 data/posts.json이 정본이다.
     읽기 — raw.githubusercontent.com에서 그대로 받는다. 누구나, 키 없이.
            커밋하고 몇 초 뒤면 반영된다. GitHub Pages 재빌드를 안 기다린다.
     쓰기 — GitHub Contents API로 그 파일에 커밋한다. 발행 키는
            이 저장소의 Contents 쓰기 권한만 가진 GitHub 토큰이다.
   그래서 GitHub Pages 같은 정적 호스팅에서도 발행이 진짜로 된다.

   ── backend: 'server' ──────────────────────────────────────────────────
   예전 방식. Vercel 등에 배포한 /api/posts가 정본이고 발행 키는 ADMIN_TOKEN이다.

   ── 공통 흐름 ──────────────────────────────────────────────────────────
   읽기 : 화면이 보이는 동안 pollMs마다 정본을 확인한다. 버전이 그대로면
          아무 일도 하지 않는다. 바뀐 순간에만 화면을 새로고침 없이 갱신한다.
   쓰기 : 발행 키를 가진 창에서만. 게시/수정/삭제가 곧바로 정본으로 간다.
          네트워크가 끊겨 있으면 큐에 쌓아 뒀다가 돌아올 때 자동으로 보낸다.
   전파 : 같은 브라우저의 다른 탭에는 BroadcastChannel로 즉시 알린다.

   ── 안 되면 조용히 물러난다 ────────────────────────────────────────────
   정본이 아직 없든, 네트워크가 죽었든, 응답이 이상하든 — 이 파일은 예외를
   밖으로 내보내지 않는다. 그럴 때 앱은 이 파일이 없던 때와 똑같이(내장 데이터
   또는 로컬 IndexedDB로) 동작한다. 연동이 실패해도 사이트는 깨지지 않는다.

   ── 이 파일이 하지 않는 일 ─────────────────────────────────────────────
   독자의 좋아요·북마크·댓글은 정본으로 가지 않는다. 쓰기에는 발행 키가 필요한데
   독자에게는 그 키가 없기 때문이다. 그건 예전과 같이 각자의 브라우저에 남는다.
   ═══════════════════════════════════════════════════════════════════════ */

(function (global) {
  'use strict';

  var CFG = Object.assign(
    {
      enabled: true,
      backend: 'github',
      github: null,
      endpoint: '/api/posts',
      pollMs: 8000,
      hiddenPollMs: 0,
      maxInlineMediaBytes: 400 * 1024,
      maxPayloadBytes: 5 * 1024 * 1024,
      rememberToken: true,
      tokenKey: 'news_sync_token_v1',
      queueKey: 'news_sync_queue_v1',
      channel: 'news_sync_v1'
    },
    global.NEWS_SYNC_CONFIG || {}
  );

  var GH = Object.assign(
    {
      owner: '',
      repo: '',
      branch: 'main',
      path: 'data/posts.json',
      commitPrefix: 'posts:',
      read: ['raw', 'local'],
      api: 'https://api.github.com',
      raw: 'https://raw.githubusercontent.com'
    },
    CFG.github || {}
  );

  /* ── 저장소 shim ──────────────────────────────────────────────────
     appStorage(앱이 위에서 만들어 둔 것)를 우선 쓰고, 없으면 localStorage,
     둘 다 막혀 있으면 메모리로 떨어진다. 어디서 열어도 예외가 안 난다. */
  var mem = {};
  var store = (function () {
    try {
      if (global.appStorage && typeof global.appStorage.getItem === 'function') return global.appStorage;
    } catch (e) {}
    try {
      var ls = global['local' + 'Storage'];
      var probe = '__ns__' + Math.random();
      ls.setItem(probe, '1');
      ls.removeItem(probe);
      return ls;
    } catch (e) {}
    return {
      getItem: function (k) { return Object.prototype.hasOwnProperty.call(mem, k) ? mem[k] : null; },
      setItem: function (k, v) { mem[k] = String(v); },
      removeItem: function (k) { delete mem[k]; }
    };
  })();

  function sget(k) { try { return store.getItem(k); } catch (e) { return null; } }
  function sset(k, v) { try { store.setItem(k, v); } catch (e) {} }
  function sdel(k) { try { store.removeItem(k); } catch (e) {} }

  /* ── 상태 ─────────────────────────────────────────────────────────── */
  var state = {
    v: -1,            // 마지막으로 본 정본 버전 (-1 = 아직 한 번도 못 받음)
    sig: '',          // 버전 외의 변경까지 잡는 지문
    posts: null,      // 마지막으로 받은 목록
    status: 'idle',   // idle | ok | error | offline | off
    lastError: null,
    fatal: false,     // 재시도해도 소용없는 실패인지 (권한·용량)
    lastSyncTs: 0,
    persistent: null, // 정본이 진짜 저장소에 놓여 있는지
    backend: 'off'
  };

  var sessionToken = null;   // rememberToken:false일 때 여기에만 둔다
  var onList = null;         // 앱이 등록한 반영 콜백
  var buffered = null;       // 앱이 아직 준비되기 전에 받은 목록
  var timer = null;
  var inFlight = false;
  var bc = null;
  var started = false;

  /* ── 발행 키 ──────────────────────────────────────────────────────── */
  function getToken() {
    if (sessionToken) return sessionToken;
    return sget(CFG.tokenKey) || '';
  }
  function isAdmin() { return !!getToken(); }
  function setToken(t) {
    t = String(t || '').trim();
    if (!t) return;
    if (CFG.rememberToken) sset(CFG.tokenKey, t);
    else sessionToken = t;
  }
  function clearToken() { sessionToken = null; sdel(CFG.tokenKey); }

  function authHeaders(extra) {
    var h = Object.assign({}, extra || {});
    var t = getToken();
    if (t) h['authorization'] = 'Bearer ' + t;
    return h;
  }

  /* ── 정본으로 보내기 전 글 다듬기 ──────────────────────────────────
     blob과 세션 한정 참조는 다른 기기에서 의미가 없으므로 떨군다.
     큰 data URI도 떨군다 — 대신 무엇을 떨궜는지 호출부에 알려 준다. */
  var DROP = ['blob', '_draft', '_ref', '_src', '_blob', '_hasBlob'];

  function slim(article) {
    var a = Object.assign({}, article);
    delete a.liked;
    delete a.bookmarked;

    var dropped = null;
    if (a.media && typeof a.media === 'object') {
      var m = Object.assign({}, a.media);
      for (var i = 0; i < DROP.length; i++) delete m[DROP[i]];
      if (m.data && String(m.data).length > CFG.maxInlineMediaBytes) {
        dropped = m.name || '첨부';
        delete m.data;
        if (!m.url && !m.embed) m.unavailable = true;
      }
      if (m.poster && String(m.poster).length > CFG.maxInlineMediaBytes) delete m.poster;
      // blob: URL은 이 세션에서만 유효하다. 다른 기기에서는 깨진 링크가 된다.
      if (m.url && /^blob:/i.test(String(m.url))) delete m.url;
      // data 에도 objectURL 이 들어온다. 짧아서 크기 필터를 통과하므로 여기서 막는다.
      if (m.data && /^blob:/i.test(String(m.data))) {
        delete m.data;
        if (!m.url && !m.embed) m.unavailable = true;
      }
      a.media = m;
    }
    return { post: a, droppedMedia: dropped };
  }

  /* ── 오프라인 큐 ──────────────────────────────────────────────────── */
  function readQueue() {
    try {
      var q = JSON.parse(sget(CFG.queueKey) || '[]');
      return Array.isArray(q) ? q : [];
    } catch (e) { return []; }
  }
  function writeQueue(q) {
    try { sset(CFG.queueKey, JSON.stringify(q.slice(-50))); } catch (e) {}
  }
  function enqueue(op) {
    var q = readQueue();
    // 같은 글에 대한 이전 작업은 최신 것으로 대체한다 — 순서보다 결과가 중요하다
    q = q.filter(function (x) {
      return !(x.op === op.op && ((op.id && x.id === op.id) || (op.post && x.post && x.post.id === op.post.id)));
    });
    q.push(op);
    writeQueue(q);
  }

  async function flushQueue() {
    if (!CFG.enabled || !isAdmin()) return;
    var q = readQueue();
    if (!q.length) return;
    var rest = [];
    for (var i = 0; i < q.length; i++) {
      var op = q[i];
      var ok = false;
      try {
        ok = op.op === 'del' ? await B.del(op.id, true) : await B.put(op.post, true);
      } catch (e) { ok = false; }
      if (!ok) { rest = rest.concat(q.slice(i)); break; }   // 하나 막히면 나머지는 다음 기회에
    }
    writeQueue(rest);
  }

  /* ── 네트워크 ─────────────────────────────────────────────────────── */
  async function req(url, opts) {
    var o = Object.assign({ cache: 'no-store' }, opts || {});
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    // 큰 첨부 업로드는 15초를 넘긴다. 호출부가 시간을 늘릴 수 있게 한다.
    var tmo = (o.timeoutMs === undefined) ? 15000 : (o.timeoutMs | 0);
    delete o.timeoutMs;
    if (ctrl && tmo > 0) {
      o.signal = ctrl.signal;
      setTimeout(function () { try { ctrl.abort(); } catch (e) {} }, tmo);
    }
    var r = await fetch(url, o);
    var text = await r.text();
    var json = null;
    try { json = JSON.parse(text); } catch (e) {}
    return {
      status: r.status,
      ok: r.ok,
      json: json,
      text: text,
      header: function (k) { try { return r.headers.get(k); } catch (e) { return null; } }
    };
  }

  function emit(list, reason) {
    state.posts = list;
    state.lastSyncTs = Date.now();
    if (typeof onList === 'function') {
      try { onList(list, reason); } catch (e) {}
    } else {
      buffered = list;
    }
    try {
      global.dispatchEvent(new CustomEvent('newssync:articles', { detail: { posts: list, reason: reason, v: state.v } }));
    } catch (e) {}
    showBadge();
  }

  function showBadge() {
    try {
      var b = document.getElementById('sync-badge');
      if (b) b.hidden = false;
    } catch (e) {}
  }

  function applyWriteResult(res) {
    state.v = res.v | 0;
    if (res.sig) state.sig = res.sig;
    if (res.persistent !== undefined) state.persistent = !!res.persistent;
    if (Array.isArray(res.posts)) emit(res.posts, 'push');
    broadcast();
  }

  /* ══════════════════════════════════════════════════════════════════
     backend: 'server' — 예전 방식 (/api/posts)
     ══════════════════════════════════════════════════════════════════ */
  function serverFinish(r, quiet) {
    if (r.ok && r.json && r.json.ok) {
      state.fatal = false;
      applyWriteResult({ v: r.json.v | 0, posts: r.json.posts, persistent: r.json.persistent });
      return true;
    }
    if (r.status === 401 || r.status === 503) {
      state.lastError = (r.json && r.json.error) || '발행 권한이 없어요';
      state.fatal = true;                    // 권한 문제는 큐에 쌓아도 소용없다
      if (!quiet) note(state.lastError);
      return false;
    }
    if (r.status === 413) {
      state.lastError = (r.json && r.json.error) || '내용이 너무 커요';
      state.fatal = true;
      if (!quiet) note(state.lastError);
      return false;
    }
    state.fatal = false;
    state.lastError = (r.json && r.json.error) || ('HTTP ' + r.status);
    return false;
  }

  var ServerBackend = {
    name: 'server',
    label: '서버(/api/posts)',

    copy: {
      title: '발행 키',
      help: 'Vercel 환경변수 <code style="font-family:ui-monospace,monospace;background:#f1f2f4;padding:1px 5px;border-radius:4px">ADMIN_TOKEN</code>에 넣어 둔 값을 입력하세요. 이 브라우저에만 저장됩니다.',
      placeholder: '발행 키'
    },

    async pull(force) {
      var url = CFG.endpoint + (!force && state.v >= 0 ? (CFG.endpoint.indexOf('?') < 0 ? '?' : '&') + 'v=' + state.v : '');
      var r = await req(url, { method: 'GET', credentials: 'same-origin' });
      if (!r.ok || !r.json || r.json.ok !== true) {
        return { ok: false, status: r.status, error: (r.json && r.json.error) || ('HTTP ' + r.status) };
      }
      if (r.json.changed === false) return { ok: true, changed: false, persistent: r.json.persistent };
      return {
        ok: true,
        changed: true,
        v: r.json.v | 0,
        posts: Array.isArray(r.json.posts) ? r.json.posts : [],
        persistent: r.json.persistent
      };
    },

    async put(post, quiet) {
      function send(body) {
        return req(CFG.endpoint, {
          method: 'POST',
          credentials: 'same-origin',
          headers: authHeaders({ 'content-type': 'application/json' }),
          body: JSON.stringify(body)
        });
      }
      var r = await send({ post: post, ifV: state.v >= 0 ? state.v : undefined });
      if (r.status === 409 && r.json) {        // 다른 창이 먼저 썼다 — 받아 반영하고 한 번만 재시도
        state.v = r.json.v | 0;
        if (Array.isArray(r.json.posts)) emit(r.json.posts, 'conflict');
        r = await send({ post: post, ifV: state.v });
      }
      return serverFinish(r, quiet);
    },

    async del(id, quiet) {
      var url = CFG.endpoint + (CFG.endpoint.indexOf('?') < 0 ? '?' : '&') + 'id=' + encodeURIComponent(id);
      var r = await req(url, { method: 'DELETE', credentials: 'same-origin', headers: authHeaders() });
      return serverFinish(r, quiet);
    },

    async replace(posts, quiet) {
      var r = await req(CFG.endpoint, {
        method: 'POST',
        credentials: 'same-origin',
        headers: authHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify({ posts: posts, replace: true })
      });
      return serverFinish(r, quiet);
    },

    async verify(token) {
      var url = CFG.endpoint + (CFG.endpoint.indexOf('?') < 0 ? '?' : '&') + 'whoami=1';
      var r = await req(url, { method: 'GET', headers: { authorization: 'Bearer ' + token } });
      if (r.ok && r.json && r.json.ok) {
        return { ok: true, warn: r.json.persistent === false ? '서버에 저장소가 안 붙어 있어요(임시 저장).' : null };
      }
      if (r.status === 503) return { ok: false, error: '서버에 ADMIN_TOKEN이 설정돼 있지 않아요' };
      if (r.status === 404) return { ok: false, error: '/api/posts를 찾을 수 없어요 — 아직 배포 전인 것 같아요' };
      return { ok: false, error: '키가 맞지 않아요' };
    }
  };

  /* ══════════════════════════════════════════════════════════════════
     backend: 'github' — 서버 없이 저장소의 data/posts.json을 정본으로
     ══════════════════════════════════════════════════════════════════ */

  /* UTF-8 ↔ base64. 한글이 섞여도 안 깨지게 바이트 단위로 간다. */
  function utf8ToB64(s) {
    var bytes;
    if (typeof TextEncoder !== 'undefined') bytes = new TextEncoder().encode(s);
    else {
      var esc = unescape(encodeURIComponent(s));
      bytes = new Uint8Array(esc.length);
      for (var j = 0; j < esc.length; j++) bytes[j] = esc.charCodeAt(j);
    }
    var bin = '', CH = 0x8000;
    for (var i = 0; i < bytes.length; i += CH) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    }
    return btoa(bin);
  }
  function b64ToUtf8(b) {
    var bin = atob(String(b).replace(/\s+/g, ''));
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    if (typeof TextDecoder !== 'undefined') return new TextDecoder('utf-8').decode(bytes);
    return decodeURIComponent(escape(bin));
  }
  function byteLen(s) {
    try { return new Blob([s]).size; } catch (e) { return s.length * 2; }
  }

  function ghContentsUrl() {
    return GH.api + '/repos/' + encodeURIComponent(GH.owner) + '/' + encodeURIComponent(GH.repo) +
           '/contents/' + GH.path.split('/').map(encodeURIComponent).join('/');
  }
  function ghRepoUrl() {
    return GH.api + '/repos/' + encodeURIComponent(GH.owner) + '/' + encodeURIComponent(GH.repo);
  }
  function ghRawUrl() {
    return GH.raw + '/' + GH.owner + '/' + GH.repo + '/' + GH.branch + '/' + GH.path;
  }
  function ghLocalUrl() {
    try { return new URL(GH.path, document.baseURI).href; } catch (e) { return './' + GH.path; }
  }
  function ghHeaders(token, extra) {
    var h = Object.assign({ accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' }, extra || {});
    var t = token || getToken();
    if (t) h['authorization'] = 'Bearer ' + t;
    return h;
  }

  /* 정본 파일의 모양을 하나로 맞춘다. 배열만 들어 있어도 받아 준다. */
  function normStore(json) {
    if (Array.isArray(json)) return { v: 0, updatedAt: '', posts: json };
    if (!json || typeof json !== 'object') return null;
    return {
      v: json.v | 0,
      updatedAt: String(json.updatedAt || ''),
      posts: Array.isArray(json.posts) ? json.posts : []
    };
  }
  function sigOf(s) { return (s.v | 0) + ':' + (s.updatedAt || '') + ':' + s.posts.length; }

  /* 같은 주기 안의 요청은 같은 주소를 쓴다 — CDN이 대신 받아 주게 하려고. */
  function bust(force) {
    var step = Math.max(1000, CFG.pollMs | 0);
    return force ? Date.now() : Math.floor(Date.now() / step) * step;
  }

  function ghError(r) {
    if (r.status === 401) return { fatal: true, msg: '발행 키(GitHub 토큰)가 유효하지 않아요 — 만료됐을 수 있어요' };
    if (r.status === 403) {
      if (r.header('x-ratelimit-remaining') === '0') {
        return { fatal: false, msg: 'GitHub API 호출 한도에 걸렸어요 — 잠시 뒤 자동으로 다시 시도합니다' };
      }
      return { fatal: true, msg: '토큰에 이 저장소의 Contents 쓰기 권한이 없어요' };
    }
    if (r.status === 404) return { fatal: true, msg: '저장소를 찾을 수 없거나 토큰에 접근 권한이 없어요' };
    return { fatal: false, msg: (r.json && r.json.message) || ('HTTP ' + r.status) };
  }

  /* ── 저장소에 자산(사진 등) 올리기 ───────────────────────────────
     posts.json 에 dataURL 을 박으면 5MB 상한에 금방 닿는다. 사진은 별도
     파일로 img/ 에 올리고 본문에는 상대경로만 남긴다. 이미 있는 경로면
     sha 를 받아 덮어쓴다. */
  async function ghPutAsset(path, b64, message) {
    if (!getToken()) return { ok: false, error: '발행 키가 없어요' };
    if (!GH.owner || !GH.repo) return { ok: false, error: 'sync-config.js의 github.owner / repo가 비어 있어요' };

    var url = GH.api + '/repos/' + encodeURIComponent(GH.owner) + '/' + encodeURIComponent(GH.repo) +
              '/contents/' + String(path).split('/').map(encodeURIComponent).join('/');

    var sha = null;
    try {
      var head = await req(url + '?ref=' + encodeURIComponent(GH.branch), { method: 'GET', headers: ghHeaders(), timeoutMs: 30000 });
      if (head.ok && head.json && head.json.sha) sha = head.json.sha;
    } catch (e) {}

    var body = { message: message || ((GH.commitPrefix || 'posts:') + ' asset ' + path), content: b64, branch: GH.branch };
    if (sha) body.sha = sha;

    var r;
    try {
      r = await req(url, { method: 'PUT', headers: ghHeaders(null, { 'content-type': 'application/json' }), body: JSON.stringify(body), timeoutMs: 900000 });
    } catch (e2) {
      return { ok: false, error: '업로드 중 연결이 끊겼어요' };
    }
    if (r.ok) return { ok: true, path: path };
    return { ok: false, error: ghError(r).msg };
  }

  function shortId(id) { return String(id || '').slice(0, 14); }

  function upsert(posts, post) {
    var out = posts.slice();
    var hit = -1;
    for (var i = 0; i < out.length; i++) { if (out[i] && out[i].id === post.id) { hit = i; break; } }
    if (hit >= 0) out[hit] = post; else out.push(post);
    out.sort(function (a, b) { return ((b && b.ts) || 0) - ((a && a.ts) || 0); });
    return out;
  }

  /* 커밋 직전에 정본을 다시 읽는다. 커밋에 필요한 sha도 여기서 받는다.
     화면에 보이는 목록이 아니라 저장소의 실제 최신본 위에 얹기 때문에,
     다른 기기에서 먼저 쓴 글이 덮여 사라지지 않는다. */
  async function ghLoadForWrite() {
    var r = await req(ghContentsUrl() + '?ref=' + encodeURIComponent(GH.branch) + '&ts=' + Date.now(),
                      { method: 'GET', headers: ghHeaders() });

    if (r.status === 404) return { sha: null, store: { v: 0, updatedAt: '', posts: [] } };   // 첫 발행
    if (!r.ok) {
      var e = ghError(r);
      var err = new Error(e.msg);
      err.fatal = e.fatal;
      throw err;
    }

    var meta = r.json || {};
    var text = '';
    if (meta.encoding === 'base64' && meta.content) {
      text = b64ToUtf8(meta.content);
    } else if (meta.download_url) {                    // 1MB를 넘으면 내용이 비어서 온다
      var d = await req(meta.download_url + '?ts=' + Date.now(), { method: 'GET' });
      if (!d.ok) throw new Error('정본 파일을 읽지 못했어요');
      text = d.text;
    }

    var parsed = null;
    try { parsed = JSON.parse(text); } catch (e2) {}
    return { sha: meta.sha || null, store: normStore(parsed) || { v: 0, updatedAt: '', posts: [] } };
  }

  async function ghWrite(mutate, label, quiet) {
    if (!GH.owner || !GH.repo) {
      state.lastError = 'sync-config.js의 github.owner / github.repo가 비어 있어요';
      state.fatal = true;
      if (!quiet) note(state.lastError);
      return false;
    }

    for (var attempt = 0; attempt < 3; attempt++) {
      var cur;
      try { cur = await ghLoadForWrite(); }
      catch (e) {
        state.lastError = e.message;
        state.fatal = !!e.fatal;
        // 일시적 실패는 push()가 더 친절한 말로 다시 알린다. 여기서는 겹쳐 말하지 않는다.
        if (!quiet && state.fatal) note(state.lastError);
        return false;
      }

      var posts = mutate(cur.store) || [];
      var next = {
        v: (cur.store.v | 0) + 1,
        updatedAt: new Date().toISOString(),
        count: posts.length,
        posts: posts
      };
      var text = JSON.stringify(next, null, 1);

      if (byteLen(text) > CFG.maxPayloadBytes) {
        state.lastError = '정본 파일이 너무 커졌어요 — 이미지는 img/ 폴더나 외부 주소로 넣어 주세요';
        state.fatal = true;
        if (!quiet) note(state.lastError);
        return false;
      }

      var body = {
        message: (GH.commitPrefix ? GH.commitPrefix + ' ' : '') + label + ' (v' + next.v + ')',
        content: utf8ToB64(text),
        branch: GH.branch
      };
      if (cur.sha) body.sha = cur.sha;

      var r;
      try {
        r = await req(ghContentsUrl(), {
          method: 'PUT',
          headers: ghHeaders(null, { 'content-type': 'application/json' }),
          body: JSON.stringify(body)
        });
      } catch (e3) {
        state.lastError = String((e3 && e3.message) || e3);
        state.fatal = false;
        return false;
      }

      if (r.ok) {
        state.fatal = false;
        applyWriteResult({ v: next.v, sig: sigOf(next), posts: next.posts, persistent: true });
        return true;
      }

      // 409/422 = 그새 다른 창이 먼저 커밋했다. 다시 읽고 그 위에 얹는다.
      if (r.status === 409 || r.status === 422) continue;

      var ge = ghError(r);
      state.lastError = ge.msg;
      state.fatal = ge.fatal;
      if (!quiet && ge.fatal) note(ge.msg);
      return false;
    }

    state.lastError = '동시 수정이 겹쳐서 발행하지 못했어요 — 잠시 뒤 다시 시도해 주세요';
    state.fatal = false;
    return false;
  }

  var GithubBackend = {
    name: 'github',
    label: 'GitHub (' + GH.owner + '/' + GH.repo + ')',

    copy: {
      title: '발행 키 — GitHub 토큰',
      help:
        '이 저장소에 <b>Contents 쓰기</b> 권한만 가진 토큰을 넣으세요. ' +
        '<a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener" ' +
        'style="color:#0a58ca;font-weight:600">토큰 만들기</a> → Repository access에서 ' +
        '<code style="font-family:ui-monospace,monospace;background:#f1f2f4;padding:1px 5px;border-radius:4px">' + (GH.repo || 'repo') + '</code> ' +
        '하나만 선택 → Repository permissions의 <b>Contents</b>를 <b>Read and write</b>로. ' +
        '이 브라우저에만 저장되고 저장소에는 올라가지 않아요. 공용 컴퓨터에서는 쓰지 마세요.',
      placeholder: 'github_pat_… 또는 ghp_…'
    },

    /* ── 읽기: 키 없이, 누구나 ────────────────────────────────────── */
    async pull(force) {
      var sources = (GH.read && GH.read.length ? GH.read : ['raw', 'local']);
      var last = null;
      for (var i = 0; i < sources.length; i++) {
        var url = (sources[i] === 'local' ? ghLocalUrl() : ghRawUrl()) + '?ts=' + bust(force);
        var r;
        try { r = await req(url, { method: 'GET' }); }
        catch (e) { last = { ok: false, error: String((e && e.message) || e) }; continue; }

        // 파일이 아직 없다. 다만 뒤에 남은 읽기 경로가 있으면 그쪽을 마저 시도한다.
        // private 저장소의 raw는 익명 요청에 404를 준다 — 여기서 곧장 return하면
        // 'local' 폴백이 영영 실행되지 않아 리더가 정본을 못 읽는다.
        if (r.status === 404) {
          if (i < sources.length - 1) { last = { ok: false, status: 404, error: 'HTTP 404' }; continue; }
          return { ok: true, changed: false, persistent: true };   // 마지막 경로까지 없으면 첫 발행 전이다.
        }
        if (!r.ok) { last = { ok: false, status: r.status, error: 'HTTP ' + r.status }; continue; }

        var s = normStore(r.json);
        if (!s) { last = { ok: false, error: 'posts.json을 읽을 수 없어요' }; continue; }

        // CDN이 잠깐 옛 사본을 줄 수 있다. 뒤로 가는 갱신은 무시한다.
        if (state.v >= 0 && (s.v | 0) < state.v) return { ok: true, changed: false, persistent: true };

        var sig = sigOf(s);
        if (sig === state.sig) return { ok: true, changed: false, persistent: true };

        return { ok: true, changed: true, v: s.v | 0, sig: sig, posts: s.posts, persistent: true };
      }
      return last || { ok: false, error: '정본을 가져오지 못했어요' };
    },

    /* ── 쓰기: 읽고 → 고치고 → 커밋 ──────────────────────────────── */
    put: function (post, quiet) {
      return ghWrite(function (s) { return upsert(s.posts, post); }, '수정 ' + shortId(post.id), quiet);
    },
    del: function (id, quiet) {
      return ghWrite(function (s) {
        return s.posts.filter(function (p) { return !p || p.id !== id; });
      }, '삭제 ' + shortId(id), quiet);
    },
    replace: function (posts, quiet) {
      return ghWrite(function () { return posts.slice(); }, '전체 ' + posts.length + '개 반영', quiet);
    },

    /* ── 키 확인 ──────────────────────────────────────────────────── */
    async verify(token) {
      if (!GH.owner || !GH.repo) {
        return { ok: false, error: 'sync-config.js의 github.owner / github.repo를 먼저 채워 주세요' };
      }
      var r;
      try { r = await req(ghRepoUrl(), { method: 'GET', headers: ghHeaders(token) }); }
      catch (e) { return { ok: false, error: 'GitHub에 연결하지 못했어요' }; }

      if (r.ok && r.json) {
        var perms = r.json.permissions;
        if (perms && perms.push === false) {
          return { ok: false, error: '이 토큰은 읽기만 돼요 — Contents 권한을 Read and write로 바꿔 주세요' };
        }
        return { ok: true, warn: perms ? null : '권한 범위는 첫 발행 때 확인됩니다.' };
      }
      if (r.status === 401) return { ok: false, error: '토큰이 유효하지 않아요 (만료됐거나 잘못 붙여넣었어요)' };
      if (r.status === 404) {
        return { ok: false, error: '이 토큰으로는 ' + GH.owner + '/' + GH.repo + '가 안 보여요 — Repository access에 이 저장소를 넣었는지 확인하세요' };
      }
      if (r.status === 403) return { ok: false, error: 'GitHub이 거절했어요 (호출 한도 또는 조직 SSO 승인 필요)' };
      return { ok: false, error: 'HTTP ' + r.status };
    }
  };

  /* ── 백엔드 선택 ──────────────────────────────────────────────────── */
  function pickBackend() {
    var want = String(CFG.backend || 'github').toLowerCase();
    if (want === 'auto') {
      var host = '';
      try { host = String(location.hostname || ''); } catch (e) {}
      want = /\.github\.io$/i.test(host) ? 'github' : 'server';
    }
    if (want === 'server') return ServerBackend;
    if (want === 'github') return GithubBackend;
    return null;   // 'off' 또는 오타 — 완전 로컬로 산다
  }

  var B = pickBackend();
  state.backend = B ? B.name : 'off';
  if (!B) CFG.enabled = false;

  /* ── 읽기 ─────────────────────────────────────────────────────────── */
  async function pull(force) {
    if (!CFG.enabled || inFlight) return false;
    inFlight = true;
    try {
      var r = await B.pull(force);
      if (!r.ok) {
        // 아직 배포/발행 전이면 조용히 로컬 모드로 산다.
        state.status = r.status === 404 ? 'off' : 'error';
        state.lastError = r.error || ('HTTP ' + r.status);
        return false;
      }
      state.status = 'ok';
      state.lastError = null;
      if (r.persistent !== undefined) state.persistent = !!r.persistent;
      if (!r.changed) return false;
      state.v = r.v | 0;
      state.sig = r.sig || '';
      emit(Array.isArray(r.posts) ? r.posts : [], 'pull');
      return true;
    } catch (e) {
      state.status = (typeof navigator !== 'undefined' && navigator.onLine === false) ? 'offline' : 'error';
      state.lastError = String((e && e.message) || e);
      return false;
    } finally {
      inFlight = false;
    }
  }

  /* ── 쓰기 ─────────────────────────────────────────────────────────── */
  async function push(article) {
    if (!CFG.enabled || !isAdmin()) return false;
    var s = slim(article);
    if (s.droppedMedia) {
      note('첨부 «' + s.droppedMedia + '»가 너무 커서 올리지 않았어요 — img/ 경로나 이미지 주소로 넣으면 그대로 연동돼요');
    }
    try {
      var ok = await B.put(s.post);
      if (!ok && state.status !== 'off' && !state.fatal) {
        enqueue({ op: 'put', post: s.post });
        note('지금은 발행하지 못했어요 — 연결되면 자동으로 올라갑니다');
      }
      return ok;
    } catch (e) {
      enqueue({ op: 'put', post: s.post });
      note('지금은 발행하지 못했어요 — 연결되면 자동으로 올라갑니다');
      return false;
    }
  }

  async function remove(id) {
    if (!CFG.enabled || !isAdmin()) return false;
    try {
      var ok = await B.del(id);
      if (!ok && state.status !== 'off' && !state.fatal) enqueue({ op: 'del', id: id });
      return ok;
    } catch (e) {
      enqueue({ op: 'del', id: id });
      return false;
    }
  }

  /* 로컬에 쌓인 글 전체를 한 번에 올린다 — 첫 이관용 */
  async function replaceAll(list) {
    if (!CFG.enabled || !isAdmin()) return false;
    var posts = (list || []).map(function (a) { return slim(a).post; });
    posts.sort(function (a, b) { return ((b && b.ts) || 0) - ((a && a.ts) || 0); });
    try { return await B.replace(posts); } catch (e) { return false; }
  }

  /* ── 탭 사이 전파 ─────────────────────────────────────────────────── */
  function broadcast() {
    try { if (bc) bc.postMessage({ t: 'changed', v: state.v }); } catch (e) {}
  }
  function initChannel() {
    try {
      if (typeof BroadcastChannel === 'undefined') return;
      bc = new BroadcastChannel(CFG.channel);
      bc.onmessage = function (ev) {
        if (ev && ev.data && ev.data.t === 'changed') pull(true);
      };
    } catch (e) {}
  }

  /* ── 폴링 ─────────────────────────────────────────────────────────── */
  function interval() {
    var hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
    return hidden ? (CFG.hiddenPollMs || 0) : (CFG.pollMs || 8000);
  }
  function schedule() {
    clearTimeout(timer);
    var ms = interval();
    if (!ms) return;                       // 백그라운드에서는 완전히 멈춘다
    timer = setTimeout(tick, ms);
  }
  async function tick() {
    if (state.status !== 'off') {
      await pull();
      await flushQueue();
    }
    schedule();
  }
  function wake() {
    if (state.status === 'off') return;
    pull();
    flushQueue();
    schedule();
  }

  function bindDrift() {
    if (typeof document === 'undefined') return;
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') wake(); else schedule();
    });
    global.addEventListener('focus', wake);
    global.addEventListener('online', wake);
  }

  /* ── 알림 ─────────────────────────────────────────────────────────
     앱의 스낵바가 있으면 그걸 쓰고, 없으면 콘솔로 남긴다. */
  function note(msg) {
    try {
      if (typeof global.__newsSnack === 'function') { global.__newsSnack(msg); return; }
    } catch (e) {}
    try { console.info('[news-sync] ' + msg); } catch (e) {}
  }

  /* ── 발행 키 입력 화면 ─────────────────────────────────────────────
     주소 뒤에 #admin을 붙이면 뜬다. 키가 맞으면 이 브라우저에 저장하고
     새로고침한다 — 그때부터 이 창은 글을 발행할 수 있는 창이 된다. */
  function unlockUI() {
    if (!B) return;
    if (document.getElementById('ns-unlock')) return;

    var wrap = document.createElement('div');
    wrap.id = 'ns-unlock';
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-modal', 'true');
    wrap.style.cssText =
      'position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;' +
      'background:rgba(20,20,22,.55);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);padding:20px;';

    var card = document.createElement('div');
    card.style.cssText =
      'width:100%;max-width:400px;background:#fff;border-radius:16px;padding:22px;' +
      'box-shadow:0 24px 60px rgba(0,0,0,.28);font-family:Inter,system-ui,-apple-system,"Apple SD Gothic Neo",sans-serif;color:#16181d;';

    var admin = isAdmin();
    card.innerHTML =
      '<div style="font-size:17px;font-weight:700;letter-spacing:-.01em">' +
        (admin ? '이 브라우저는 발행 권한이 있어요' : B.copy.title) +
      '</div>' +
      '<p style="margin:8px 0 16px;font-size:13.5px;line-height:1.65;color:#5b6068">' +
        (admin
          ? '연필 버튼으로 쓴 글이 곧바로 ' + B.label + '에 올라가고, 열려 있는 모든 창에 몇 초 안에 반영됩니다.'
          : B.copy.help) +
      '</p>' +
      (admin ? '' :
        '<input id="ns-key" type="password" autocomplete="off" spellcheck="false" placeholder="' + B.copy.placeholder + '" ' +
        'style="width:100%;box-sizing:border-box;padding:11px 13px;border:1.5px solid #dcdfe4;border-radius:10px;' +
        'font-size:15px;font-family:inherit;outline:none">') +
      '<div id="ns-msg" style="margin-top:10px;font-size:12.5px;min-height:17px;line-height:1.5;color:#c0392b"></div>' +
      '<div style="display:flex;gap:8px;margin-top:12px">' +
        '<button id="ns-cancel" type="button" style="flex:1;padding:11px;border:1.5px solid #dcdfe4;background:#fff;' +
          'border-radius:10px;font-size:14px;font-weight:600;font-family:inherit;cursor:pointer">닫기</button>' +
        '<button id="ns-go" type="button" style="flex:1;padding:11px;border:0;background:#16181d;color:#fff;' +
          'border-radius:10px;font-size:14px;font-weight:600;font-family:inherit;cursor:pointer">' +
          (admin ? '권한 해제' : '확인') + '</button>' +
      '</div>';

    wrap.appendChild(card);
    document.body.appendChild(wrap);

    var msg = card.querySelector('#ns-msg');
    var input = card.querySelector('#ns-key');
    if (input) setTimeout(function () { try { input.focus(); } catch (e) {} }, 60);

    function close() {
      try { wrap.remove(); } catch (e) {}
      if (location.hash === '#admin') {
        try { history.replaceState(null, '', location.pathname + location.search); } catch (e) {}
      }
    }
    card.querySelector('#ns-cancel').onclick = close;

    card.querySelector('#ns-go').onclick = async function () {
      if (admin) { clearToken(); location.reload(); return; }
      var t = (input.value || '').trim();
      if (!t) { msg.style.color = '#c0392b'; msg.textContent = '키를 입력해 주세요'; return; }
      msg.style.color = '#5b6068';
      msg.textContent = '확인 중…';
      try {
        var v = await B.verify(t);
        if (v.ok) {
          setToken(t);
          msg.style.color = '#1e7a4d';
          msg.textContent = (v.warn ? v.warn + ' ' : '') + '확인됐어요. 새로고침합니다…';
          setTimeout(function () {
            try { history.replaceState(null, '', location.pathname + location.search); } catch (e) {}
            location.reload();
          }, 800);
          return;
        }
        msg.style.color = '#c0392b';
        msg.textContent = v.error || '키가 맞지 않아요';
      } catch (e) {
        msg.style.color = '#c0392b';
        msg.textContent = '확인하지 못했어요 — 네트워크를 확인해 주세요';
      }
    };

    if (input) {
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') card.querySelector('#ns-go').click();
      });
    }
    wrap.addEventListener('click', function (e) { if (e.target === wrap) close(); });
  }

  function watchHash() {
    function check() {
      if (location.hash === '#admin' || /[?&]admin(=1)?(&|$)/.test(location.search)) unlockUI();
    }
    global.addEventListener('hashchange', check);
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', check);
    else check();
  }

  /* ── 시작 ─────────────────────────────────────────────────────────
     앱(index.html / write.html)이 부팅을 끝낸 뒤 start(cb)를 부른다.
     그 전에 이미 응답이 왔다면 버퍼에 담아 뒀다가 여기서 흘려보낸다. */
  function start(cb) {
    if (typeof cb === 'function') {
      onList = cb;
      if (buffered) { try { cb(buffered, 'buffered'); } catch (e) {} buffered = null; }
    }
    if (started) return;
    started = true;
    if (!CFG.enabled) { state.status = 'off'; return; }
    initChannel();
    bindDrift();
    watchHash();
    pull(true).then(function () { flushQueue(); schedule(); });
  }

  global.NewsSync = {
    get enabled() { return !!CFG.enabled; },
    get config() { return CFG; },
    get state() { return state; },
    get version() { return state.v; },
    get backend() { return state.backend; },
    isAdmin: isAdmin,
    setToken: setToken,
    clearToken: clearToken,
    unlock: unlockUI,
    start: start,
    pull: pull,
    push: push,
    remove: remove,
    replaceAll: replaceAll,
    flushQueue: flushQueue,
    putAsset: ghPutAsset
  };

  // 앱 부팅을 기다리지 않고 미리 한 번 당겨 둔다 — 첫 화면이 그만큼 빨리 최신이 된다
  if (CFG.enabled) {
    try { pull(true); } catch (e) {}
  } else {
    state.status = 'off';
  }
})(window);
