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
    /* [2026-09-04 수정] 이 저장소는 private이다.
       private 저장소의 raw.githubusercontent.com은 익명 요청에 404를 준다
       (실제로 확인함). 그런데 news-sync.js의 pull()은 404를 만나면
       "아직 파일이 없다 = 첫 발행 전"으로 보고 그 자리에서 return 해 버린다.
       continue가 아니라 return이라, 뒤에 있는 'local'을 영영 시도하지 않는다.
       그 결과 리더(index.html)는 data/posts.json을 한 번도 읽지 못하고
       내장 스냅샷(BAKED_DATA)만 계속 보여 준다 — 이것이 index.html이
       write.html을 따라오지 않던 진짜 원인이다.

       그래서 raw를 아예 뺀다. Pages가 서빙하는 ./data/posts.json만 읽는다.
       (Pages 사이트는 공개라 익명으로 잘 읽힌다.)
       반영은 커밋 몇 초가 아니라 Pages 재빌드 뒤 = 보통 30~90초.
       저장소를 public으로 바꾸면 ['raw','local']로 되돌려 더 빠르게 할 수 있다. */
    /* [2026-09-05] 저장소를 public으로 전환했다. raw를 다시 앞에 둔다.
       raw는 커밋 몇 초 뒤, local(Pages)은 재빌드 30~90초 뒤에 반영된다.
       CDN도 다르므로 한쪽이 막혀도 다른 쪽으로 읽힌다. */
    read: ['local']
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
