# 엘리프 한신더휴 수원 · 리서치 데스크

GitHub Pages만으로 **진짜 발행이 되는** 정적 사이트다. 서버도, Vercel도, 요금도 없다.

- 리더 — `https://aquabluevictory.github.io/elif-suwon-research1/`
- 글쓰기 — `https://aquabluevictory.github.io/elif-suwon-research1/write.html`

---

## 무엇이 달라졌나

예전에는 `write.html`에서 쓴 글이 그 기기의 IndexedDB에만 남았다. 남에게 보여
주려면 발행용 HTML을 새로 구워 다시 올려야 했고, 실시간 연동을 켜려면
`/api/posts`를 실행할 서버(Vercel)가 따로 필요했다. GitHub Pages는 정적 파일만
서빙하므로 그 주소에서는 발행이 되지 않았다.

이제 **정본이 저장소 안의 파일**이다.

```
data/posts.json   ← 이 파일이 정본이다. 모든 글이 여기 들어 있다.
```

- **읽기** — 누구나, 키 없이. 사이트가 `raw.githubusercontent.com`에서 이 파일을
  직접 받는다. 커밋하고 몇 초 뒤면 반영된다. Pages 재빌드를 기다리지 않는다.
- **쓰기** — 발행 키를 넣은 브라우저에서만. 저장 버튼을 누르면 GitHub Contents
  API로 이 파일에 커밋한다. 그게 곧 발행이다.

서버가 없어도 되는 이유는 간단하다. **GitHub 자체가 서버 역할을 한다.**

---

## 설치 — 세 단계

### 1. 저장소에 올린다

**터미널이 있으면** — 번들에 커밋 히스토리가 그대로 들어 있다.

```
git clone -b main elif-suwon-research1.bundle elif-suwon-research1
cd elif-suwon-research1
git remote add origin https://github.com/aquabluevictory/elif-suwon-research1.git
git push -u origin main
```

이미 로컬에 클론이 있다면 그 폴더에서 `git pull /경로/elif-suwon-research1.bundle main` 한 줄이면 된다.

푸시할 때 비밀번호 대신 토큰을 묻는다. 아래 3번에서 만들 토큰을 그대로 써도 되고,
`--force`가 필요하다는 말이 나오면 히스토리가 갈린 것이니 `git pull --rebase` 먼저 한다.

**터미널이 없으면** — 저장소 페이지에서 **Add file → Upload files**로
`elif-suwon-research1-files.zip`을 풀어 끌어다 놓고 커밋한다. 결과는 같다.
단, `.nojekyll`처럼 점으로 시작하는 파일은 브라우저 업로드에서 빠지기 쉬우니
빠졌으면 **Add file → Create new file**로 이름만 `.nojekyll`로 해서 빈 파일을 하나 만든다.

### 2. Pages를 켠다

저장소 **Settings → Pages → Source: Deploy from a branch → Branch: `main` / `/ (root)`**.

1~2분 뒤 `https://aquabluevictory.github.io/elif-suwon-research1/`가 열린다.
저장소는 **Public**이어야 한다 (Private은 Pages 유료 플랜이 필요하다).

### 3. 발행 키를 만들어 브라우저에 넣는다

발행 키는 **이 저장소의 파일 하나만 고칠 수 있는 GitHub 토큰**이다.

1. [github.com/settings/personal-access-tokens/new](https://github.com/settings/personal-access-tokens/new) 로 간다
   (Settings → Developer settings → Personal access tokens → **Fine-grained tokens**).
2. **Repository access** → *Only select repositories* → `elif-suwon-research1` **하나만**.
3. **Permissions → Repository permissions → Contents** → **Read and write**.
   다른 항목은 전부 그대로 둔다. 이거 하나면 된다.
4. **Expiration**을 넣는다 (90일 권장). 만료되면 새로 만들어 다시 넣으면 된다.
5. Generate token → 한 번만 보이는 값을 복사한다.
6. `write.html#admin`을 열고 붙여넣는다.

```
https://aquabluevictory.github.io/elif-suwon-research1/write.html#admin
```

키가 맞으면 확인 후 새로고침되고, 그때부터 이 브라우저는 발행할 수 있는 창이 된다.

---

## 쓰는 법

1. `write.html`을 연다.
2. 연필 버튼으로 글을 쓰고 저장한다.
3. 끝이다. 저장이 곧 커밋이고, 커밋이 곧 발행이다.

글은 두 곳에 남는다 — **IndexedDB**(이 기기의 전체 백업, 이미지 원본 포함)와
**data/posts.json**(공개되는 정본). 다른 기기에서 `write.html`을 열면 정본에 있는
글이 자동으로 합쳐져 보이므로, 폰에서 쓴 글을 노트북에서 이어 고칠 수 있다.

리더(`index.html`)는 화면이 켜져 있는 동안 8초마다 정본을 확인하고, 바뀐 순간에만
새로고침 없이 화면을 갈아 끼운다. 이미 열려 있는 남의 탭에도 몇 초 안에 도착한다.

### 이미지

`img/` 폴더의 파일이나 외부 `https` 주소로 넣으면 크기 제한 없이 그대로 나간다.
붙여넣기로 넣은 이미지(data URI)는 400KB를 넘으면 정본으로 올라가지 않는다 —
`posts.json`이 무거워지면 모든 방문자의 첫 로딩이 느려지기 때문이다. 큰 이미지는
`img/`에 올리고 경로로 참조하는 편이 언제나 낫다.

---

## 발행 키를 다루는 법

토큰은 **저장소에 올라가지 않는다.** `write.html#admin`에 입력한 값은 그 브라우저의
localStorage에만 있고, 커밋되는 것은 `data/posts.json`뿐이다.

그래도 이건 진짜 자격증명이다. 세 가지만 지킨다.

- **범위를 좁게** — 위 3번대로 만들면 이 토큰이 할 수 있는 일은 이 저장소 파일
  수정뿐이다. 계정도, 다른 저장소도 건드리지 못한다.
- **공용 컴퓨터에서 쓰지 않는다** — 굳이 써야 하면 `sync-config.js`의
  `rememberToken`을 `false`로 바꾼다. 탭을 닫으면 사라진다.
- **의심스러우면 즉시 폐기** —
  [github.com/settings/personal-access-tokens](https://github.com/settings/personal-access-tokens)에서
  Revoke. 새로 만들어 다시 넣으면 끝이다. 브라우저에서만 지우려면
  `write.html#admin`을 열고 **권한 해제**를 누른다.

`write.html` 자체는 주소만 알면 누구나 열 수 있는 평범한 정적 페이지다. 다만 키가
없으면 발행이 안 되고, 그 창에서 쓴 글은 그 기기에만 남는다. 편집 화면을 아예
감추고 싶다면 `write.html`을 이 저장소에서 빼고 자기 컴퓨터에서만 열면 된다 —
`file://`로 열어도 정본 읽기·쓰기가 똑같이 동작한다.

---

## 파일 구조

```
index.html        리더. 내장 스냅샷을 갖고 있어 정본을 못 받아도 화면이 비지 않는다
write.html        글쓰기. #admin으로 발행 키를 넣는다
data/posts.json   ★ 정본. 발행은 이 파일에 커밋하는 일이다
sync-config.js    설정 한 곳. 저장소 이름·주기·상한이 여기 있다
news-sync.js      정본 ↔ 열려 있는 창들을 잇는 엔진
img/*.jpg         기사 이미지 29장
.nojekyll         Pages가 Jekyll로 가공하지 않게 한다
api/*.js          Vercel용 서버 함수 (Pages에서는 동작하지 않는다 — 아래 참고)
package.json      ESM 선언. api/를 쓸 때만 의미가 있다
```

---

## GitHub Pages에서 안 되는 것

`api/` 안의 함수는 서버가 필요하므로 Pages에서는 실행되지 않는다. 무엇이 어떻게
되는지 분명히 적어 둔다.

- **`api/posts.js`** — 이제 쓰지 않는다. 정본이 `data/posts.json`으로 옮겨 갔다.
  Vercel로 되돌아갈 때를 위해 남겨 둔 것뿐이다.
- **`api/market.js`** (날씨·환율·코스피) — 404가 나면 코드가 조용히 공개 프록시로
  넘어간다. **지표는 그대로 나온다.**
- **`api/read.js`** (기사 원문 프록시) — 마찬가지로 공개 프록시로 폴백한다.
  **읽기 기능은 그대로 동작한다.**

즉 Pages에서 잃는 기능은 없다. 자체 프록시 대신 공개 프록시를 타므로 가끔 조금
느릴 수 있을 뿐이다.

---

## 알아 둘 것

**발행 지연** — 커밋 직후 몇 초. 정본을 `raw.githubusercontent.com`에서 받기
때문에 Pages 재빌드(보통 30~90초)를 기다리지 않는다. 회사망 등에서 raw가 막혀
있으면 자동으로 `./data/posts.json`으로 넘어가고, 그때는 Pages 재빌드 시간만큼
늦어진다. 순서는 `sync-config.js`의 `github.read`에서 바꾼다.

**동시 편집** — 두 기기에서 동시에 저장하면 나중 것이 충돌(409)로 튕긴다.
그러면 저장소의 최신본을 다시 읽어 그 위에 얹고 재시도한다. 최대 3번. 다른
기기에서 먼저 쓴 글이 덮여 사라지지 않는다.

**호출 한도** — 읽기는 CDN이라 사실상 무제한이다(같은 주기 안의 요청은 같은
주소를 쓰도록 맞춰 두어 CDN이 대신 받는다). 쓰기는 토큰 기준 시간당 5,000회이고
발행 한 번에 2회를 쓰므로 걸릴 일이 없다.

**커밋 히스토리** — 발행할 때마다 `posts: 수정 …` 커밋이 하나씩 쌓인다.
글의 모든 버전이 git에 남는다는 뜻이다. 되돌리고 싶으면 그 커밋을 revert하면 된다.

**독자의 좋아요·북마크·댓글** — 정본으로 가지 않는다. 쓰기에 키가 필요한데
독자에게는 키가 없기 때문이다. 예전과 같이 각자의 브라우저에 남는다.

**커밋 작성자** — 번들의 커밋은 `aquabluevictory@users.noreply.github.com`으로
되어 있다. 다른 이름을 쓰려면 푸시 전에
`git commit --amend --author="이름 <메일>"`로 바꾸면 된다. 발행 커밋의 작성자는
토큰 주인이 된다.

---

## 설정 바꾸기

전부 `sync-config.js` 한 곳에 있다.

```js
backend: 'github'   // 'server'로 바꾸면 예전 /api/posts 방식으로 돌아간다
                    // 'auto'면 *.github.io에서만 github, 나머지는 server
                    // 'off'면 완전 로컬 (예전처럼 이 기기에만 저장)

github: {
  owner: 'aquabluevictory',        // 포크했거나 이름을 바꿨으면 여기 세 줄만 고친다
  repo:  'elif-suwon-research1',
  branch:'main',
  read: ['raw', 'local']           // 순서를 바꾸면 읽기 경로 우선순위가 바뀐다
},

pollMs: 8000                       // 변경 확인 주기. 4000이면 더 빠르고 15000이면 더 아낀다
```

### Vercel로 되돌아가려면

이 저장소를 [vercel.com/new](https://vercel.com/new)에서 Import Git Repository로
연결하고, 환경변수 `ADMIN_TOKEN`을 넣은 뒤 `sync-config.js`의 `backend`를
`'server'`로 바꾼다. `api/`는 그대로 남아 있으므로 코드는 손댈 필요가 없다.

**둘을 동시에 쓰지 않는다.** 정본이 두 곳으로 갈라지면 어느 쪽이 맞는지 알 수
없게 된다. 하나를 고른다.
