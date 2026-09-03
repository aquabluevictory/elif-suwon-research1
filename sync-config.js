/* sync-config.js — 연동 설정 한 곳
   ─────────────────────────────────────────────────────────────────────
   여기만 고치면 된다. news-sync.js는 이 값을 읽어서 움직인다.
   이 파일이 없거나 enabled를 false로 두면 앱은 예전처럼 완전히 로컬로 동작한다. */

window.NEWS_SYNC_CONFIG = {

  /* 연동을 쓸지. false면 이 파일 이후의 모든 동작이 꺼진다. */
  enabled: true,

  /* 어디를 정본으로 쓸지.
       'github' — 서버 없이 GitHub 저장소의 data/posts.json을 정본으로 쓴다.
                  GitHub Pages(정적 호스팅)에서도 실제 발행이 된다. 기본값.
       'server' — 예전 방식. Vercel 등에 배포한 /api/posts를 쓴다.
       'auto'   — *.github.io에서 열렸으면 github, 아니면 server.
       'off'    — 완전 로컬.
     둘을 동시에 쓰지 않는다. 정본이 두 곳으로 갈라지면 글이 어긋난다. */
  backend: 'github',

  /* ── backend:'github'일 때 쓰는 값 ─────────────────────────────────
     저장소를 포크하거나 이름을 바꿨다면 여기 세 줄만 고치면 된다. */
  github: {
    owner:  'aquabluevictory',
    repo:   'elif-suwon-research1',
    branch: 'main',
    path:   'data/posts.json',

    /* 커밋 메시지 앞에 붙는 말 */
    commitPrefix: 'posts:',

    /* 읽기 경로 우선순위.
       'raw'   — raw.githubusercontent.com. 커밋 몇 초 뒤에 바로 반영된다.
       'local' — 이 사이트가 서빙하는 ./data/posts.json.
                 GitHub Pages 재빌드(보통 30~90초)를 기다려야 한다.
       raw가 막힌 망에서는 자동으로 local로 넘어간다. 순서만 바꾸면 반대가 된다. */
    read: ['raw', 'local']
  },

  /* ── backend:'server'일 때 쓰는 값 ─────────────────────────────── */
  endpoint: '/api/posts',

  /* 변경 확인 주기(ms). 화면이 보일 때만 돈다.
     같은 주기 안의 요청은 같은 주소를 쓰도록 맞춰 두었기 때문에,
     방문자가 몇이든 CDN이 대부분 대신 받아 준다.
     더 빠르게 하고 싶으면 4000, 더 아끼려면 15000쯤. */
  pollMs: 8000,

  /* 탭이 백그라운드일 때의 주기(ms). 0이면 완전히 멈춘다. */
  hiddenPollMs: 0,

  /* 정본으로 보낼 인라인 첨부(data URI) 하나의 상한.
     이걸 넘는 이미지는 올라가지 않는다 — 대신 img/ 경로나
     외부 https 주소로 넣으면 크기 제한 없이 그대로 연동된다. */
  maxInlineMediaBytes: 400 * 1024,

  /* posts.json 전체의 상한. 넘으면 발행을 막고 이유를 말해 준다.
     저장소를 무겁게 만들지 않기 위한 안전선이다. */
  maxPayloadBytes: 5 * 1024 * 1024,

  /* 발행 키를 이 브라우저에 기억할지. false면 탭을 닫을 때까지만 유지된다.
     공용 컴퓨터에서는 false로 둔다. */
  rememberToken: true
};
