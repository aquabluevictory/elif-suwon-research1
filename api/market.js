// api/market.js — Vercel Edge Function
//
// 날씨(open-meteo) + 환율(야후, 실패 시 open.er-api.com) + 코스피(야후)를
// 서버에서 한 번에 모아 60초 캐시로 돌려준다.
//
// 예전: 방문자마다 브라우저가 open-meteo 1회 + 야후 2회(실패 시 공개 CORS
// 프록시까지) = 방문자 수 × 최대 4~5개 외부 호출.
// 지금: 방문자가 몇이든 원본은 이 함수가 분당 1회만 맞는다. 나머지는
// s-maxage 캐시가 처리한다. 클라이언트는 자기 도메인(/api/market)에만
// 요청하므로 CORS 프록시가 필요 없다.
//
// 응답 형태는 클라이언트(marketFeed)가 기대하는 모양 그대로:
//   { weather:{temp,code}|null, fx:{px,pct}|null, kospi:{px,pct}|null, ts }

export const config = { runtime: 'edge' };

const TIMEOUT = 6000;

async function grab(url, pick) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), TIMEOUT);
  try {
    const r = await fetch(url, {
      signal: c.signal,
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; ResearchDeskProxy/1.0)' },
    });
    if (!r.ok) return null;
    return pick(await r.json());
  } catch {
    return null; // 한 곳이 죽어도 나머지는 살린다
  } finally {
    clearTimeout(t);
  }
}

const yahoo = (sym) =>
  grab(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=1d&interval=15m`,
    (j) => {
      const m = j?.chart?.result?.[0]?.meta;
      if (!m || m.regularMarketPrice == null) return null;
      const prev = m.chartPreviousClose ?? m.previousClose;
      return {
        px: m.regularMarketPrice,
        pct: prev ? ((m.regularMarketPrice - prev) / prev) * 100 : null,
      };
    }
  );

export default async function handler() {
  const [weather, fxYahoo, kospi] = await Promise.all([
    grab(
      'https://api.open-meteo.com/v1/forecast?latitude=37.5665&longitude=126.9780' +
        '&current=temperature_2m,weather_code&timezone=Asia%2FSeoul',
      (j) => ({ temp: j.current?.temperature_2m ?? null, code: j.current?.weather_code ?? null })
    ),
    yahoo('KRW=X'),
    yahoo('^KS11'),
  ]);

  // 야후 환율이 죽으면 등락률 없이 현재가만이라도 살린다 (기존 클라이언트 폴백과 동일한 순서)
  const fx =
    fxYahoo ||
    (await grab('https://open.er-api.com/v6/latest/USD', (j) =>
      j.rates?.KRW ? { px: j.rates.KRW, pct: null } : null
    ));

  return new Response(JSON.stringify({ weather, fx, kospi, ts: Date.now() }), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'public, s-maxage=60, stale-while-revalidate=300',
      'access-control-allow-origin': '*',
    },
  });
}
