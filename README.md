# 배포 방법

이 폴더는 그대로 Vercel 프로젝트 루트로 쓸 수 있는 구조예요.

```
index.html      ← 리더 (이미지는 base64 대신 img/ 상대경로 참조)
img/*.jpg        ← 분리된 기사 이미지 29장
api/market.js    ← 날씨·환율·코스피 통합 프록시 (Edge, 60초 캐시)
api/read.js      ← 기사 원문용 SSRF 방어 프록시 (Node)
```

## 1. 배포

Vercel 계정이 있으면 둘 중 하나로 끝나요.

- **대시보드**: 이 폴더를 그대로 드래그해서 [vercel.com/new](https://vercel.com/new)에 올린다.
- **CLI**: 이 폴더에서
  ```
  npm i -g vercel   # 처음 한 번만
  vercel
  ```
  물어보는 대로 엔터 몇 번이면 `https://프로젝트명.vercel.app` 주소가 나와요.

별도 설정 파일(`vercel.json`) 필요 없이 `api/` 폴더만 있으면 자동으로 서버리스 함수로 인식돼요.

## 2. index.html의 `PROXY_BASE` 확인

`index.html`에서 `safeEmbedUrl` 바로 아래 있는 줄:

```js
const PROXY_BASE='';
```

- **같은 프로젝트에 html과 api를 함께 올렸다면** → 빈 문자열 그대로 둔다 (자기 도메인이니까).
- **api만 별도 프로젝트로 올렸다면** → `'https://그-프로젝트.vercel.app'` 처럼 채운다.

## 3. 배포 확인

```
curl https://프로젝트명.vercel.app/api/market
curl "https://프로젝트명.vercel.app/api/read?url=https://example.com"
```

`/api/market`은 `{weather, fx, kospi, ts}` JSON이, `/api/read`는 대상 페이지의 HTML이 그대로 돌아오면 정상이에요.

## 4. 배포 전에도 안 깨짐

`marketFeed()`와 EP의 `self` 항목은 실패하면(아직 배포 전이라 404가 나든, 뭐든) 조용히 기존 direct-fetch·공개 프록시 경로로 넘어가도록 짜여 있어요. 즉 이 폴더를 그냥 로컬에서 `index.html`만 열어 봐도 예전처럼 동작하고, `api/`를 배포하는 순간부터 그 경로를 우선적으로 타기 시작해요.
