# 배포 방법

이 폴더는 그대로 Vercel 프로젝트 루트로 쓸 수 있는 구조예요.

```
index.html      ← 리더 (이미지는 base64 대신 img/ 상대경로 참조)
img/*.jpg        ← 분리된 기사 이미지 29장
api/market.js    ← 날씨·환율·코스피 통합 프록시 (Edge, 60초 캐시)
api/read.js      ← 기사 원문용 SSRF 방어 프록시 (Node)
package.json     ← ESM 선언 ("type":"module") — api/read.js가 import 구문을 쓴다
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

## 5. api/read.js 남용 방지

이 엔드포인트는 인증이 없다. SSRF는 코드 안에서 막지만, **누가 얼마나 부를 수
있는가**는 별개 문제다. 주소만 알면 누구든 이 함수를 범용 URL 페처로 쓸 수 있고
비용은 이 프로젝트 소유자에게 청구된다. 그래서 두 가지를 넣어 뒀다.

**IP 레이트리밋** — IP당 분당 30회, 인스턴스 전체 분당 300회. 초과하면 `429`와
`Retry-After`를 준다. 한도는 `api/read.js` 상단 상수에서 바꾼다.

한계를 분명히 해 둔다. 이건 인스턴스 메모리 기반이라 서버리스에서는 완전하지 않다.
인스턴스가 여러 개 뜨면 카운터도 여러 벌이고, 콜드스타트마다 초기화된다. 분산
공격은 못 막는다. 확실히 막으려면 Vercel KV나 Upstash 같은 공유 저장소로 옮겨야
한다. 지금 있는 건 실수와 가벼운 남용을 걸러 청구서가 폭주하지 않게 하는
과속방지턱이다.

레이트리밋에 걸려도 사이트는 안 깨진다. `self` 프록시가 실패하면 클라이언트가
공개 프록시로 자동 폴백한다.

**CORS 기본값 변경** — 같은 도메인에 배포했으면(`PROXY_BASE=''`) CORS 헤더가
애초에 필요 없어서, 기본은 헤더를 안 붙인다. `api`만 별도 프로젝트로 올렸다면
Vercel 환경변수를 설정한다.

```
ALLOWED_ORIGINS=https://내-리더-프로젝트.vercel.app
```

쉼표로 여러 개 넣을 수 있다. 설정을 빠뜨리면 브라우저 콘솔에 CORS 오류가 뜨고
리더는 공개 프록시로 폴백한다 — 조용히 망가지지는 않는다.

참고로 오리진·리퍼러 검사는 여기서 쓸 수 없다. 클라이언트가
`referrerPolicy:'no-referrer'`로 호출하는 데다 같은 도메인 GET이라 브라우저가
Origin도 붙이지 않는다. 정상 요청에 헤더가 없으니 헤더로 거르면 사이트 자신이
막힌다. 그리고 curl에서는 어차피 위조가 자유롭다.
