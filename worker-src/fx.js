// ── 환율 API (/api/fx) ──
//
// 브라우저가 환율 제공처를 직접 호출하지 않고 Worker를 거치게 하는 이유:
//  - CORS: 제공처가 CORS 헤더를 안 주거나 바뀌어도 앱은 영향 없음
//  - 캐시: 여러 기기·탭이 열려 있어도 외부 호출은 10분에 한 번으로 묶임
//  - 내구성: 제공처 장애 시 마지막 성공값을 그대로 내려 화면이 비지 않음
//  - 키 은닉: 나중에 키가 필요한 공식 환율(수출입은행)로 바꿔도 키가 노출되지 않음
//
// 소스: open.er-api.com (ExchangeRate-API 공개 엔드포인트, 키 불필요·시간당 갱신)
// 응답: { base, rates:{KRW,...}, time_last_update_unix, time_next_update_unix, result:"success" }

const FX_SOURCE = "https://open.er-api.com/v6/latest/USD";
const FX_TTL_MS = 10 * 60 * 1000;        // 캐시 10분 (제공처가 시간당 갱신이라 더 짧게 볼 이유가 없음)
const FX_STALE_MAX_MS = 24 * 60 * 60 * 1000; // 24시간까지는 낡은 값이라도 내려준다 (그 이상은 오해 소지)

// Worker 인스턴스 메모리 캐시. 인스턴스가 재활용되는 동안만 유지되며,
// 사라지면 다음 요청에서 다시 받아오면 되므로 정확성에 영향 없음.
let fxCache = null; // { at:number, payload:object }

// 앱이 쓰는 통화만 골라 내린다 (원화 기준 환산이 목적)
const FX_PICK = ["KRW", "JPY", "CNY", "EUR", "VND"];

function pickRates(rates) {
  const out = {};
  for (const c of FX_PICK) {
    const v = Number(rates && rates[c]);
    if (isFinite(v) && v > 0) out[c] = v;
  }
  return out;
}

async function fetchFx() {
  const res = await fetch(FX_SOURCE, {
    headers: { "Accept": "application/json" },
    // Cloudflare 엣지 캐시도 함께 활용 — 동일 리전 요청은 여기서 흡수된다
    cf: { cacheTtl: 300, cacheEverything: true },
  });
  if (!res.ok) throw new Error(`환율 제공처 HTTP ${res.status}`);
  const data = await res.json();
  if (data.result && data.result !== "success") throw new Error(`환율 제공처 오류: ${data["error-type"] || data.result}`);
  const rates = pickRates(data.rates);
  if (!rates.KRW) throw new Error("환율 응답에 KRW가 없습니다");
  return {
    base: data.base_code || data.base || "USD",
    rates,
    // 제공처가 주는 갱신 시각(초) → ms. 없으면 수신 시각으로 대체.
    updatedAt: (Number(data.time_last_update_unix) || 0) * 1000 || Date.now(),
    nextUpdateAt: (Number(data.time_next_update_unix) || 0) * 1000 || null,
    source: "ExchangeRate-API",
  };
}

export async function handleFxApi(request, env, url) {
  if (request.method !== "GET") {
    return new Response(JSON.stringify({ error: `메서드 ${request.method} 미지원 (GET만 허용)` }), { status: 405, headers: corsHeadersFx() });
  }
  const now = Date.now();
  const force = url.searchParams.get("force") === "1";

  if (!force && fxCache && now - fxCache.at < FX_TTL_MS) {
    return fxJson({ ...fxCache.payload, cached: true, cacheAgeMs: now - fxCache.at });
  }

  try {
    const payload = await fetchFx();
    fxCache = { at: now, payload };
    return fxJson({ ...payload, cached: false, cacheAgeMs: 0 });
  } catch (e) {
    // 제공처 장애 — 24시간 내 마지막 성공값이 있으면 stale 표시와 함께 내려준다.
    if (fxCache && now - fxCache.at < FX_STALE_MAX_MS) {
      return fxJson({ ...fxCache.payload, cached: true, stale: true, cacheAgeMs: now - fxCache.at, warning: e.message });
    }
    return new Response(JSON.stringify({ error: e.message || "환율을 가져올 수 없습니다" }), { status: 502, headers: corsHeadersFx() });
  }
}

function corsHeadersFx() {
  return { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json; charset=utf-8" };
}
function fxJson(obj) {
  return new Response(JSON.stringify(obj), {
    headers: {
      ...corsHeadersFx(),
      // 브라우저·엣지에도 짧게 캐시 허용 — 탭을 여러 개 열어도 Worker 호출이 몰리지 않게
      "Cache-Control": "public, max-age=120",
    },
  });
}
