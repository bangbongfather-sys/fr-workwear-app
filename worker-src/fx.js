// ── 환율 API (/api/fx) ──
//
// 브라우저가 환율 제공처를 직접 호출하지 않고 Worker를 거치게 하는 이유:
//  - CORS: 제공처가 CORS 헤더를 안 주거나 바뀌어도 앱은 영향 없음
//  - 캐시: 여러 기기·탭이 열려 있어도 외부 호출은 10분에 한 번으로 묶임
//  - 내구성: 제공처 장애 시 마지막 성공값을 그대로 내려 화면이 비지 않음
//  - 키 은닉: 나중에 키가 필요한 공식 환율(수출입은행)로 바꿔도 키가 노출되지 않음
//
// 소스 ① (주): 두나무 환율 CDN — 하나은행 고시 환율을 장중 몇 분 간격으로 갱신한다.
//   키 불필요. basePrice(매매기준율)와 함께 전일 종가 대비 등락(signedChangePrice/Rate)을
//   같이 주기 때문에, 앱이 "지난번에 열었던 날"과 비교해 등락을 추정할 필요가 없어진다.
//   응답: [{ currencyCode:"USD", basePrice, currencyUnit, signedChangePrice, signedChangeRate,
//            date, time, timestamp, ... }, ...]
// 소스 ② (예비): open.er-api.com — 하루 한 번 갱신. ①이 죽었을 때만 쓴다.
//   응답: { base, rates:{KRW,...}, time_last_update_unix, time_next_update_unix, result:"success" }

const FX_LIVE_SOURCE = "https://quotation-api-cdn.dunamu.com/v1/forex/recent?codes=FRX.KRWUSD,FRX.KRWJPY,FRX.KRWCNY,FRX.KRWEUR";
const FX_SOURCE = "https://open.er-api.com/v6/latest/USD";
const FX_TTL_MS = 2 * 60 * 1000;         // 캐시 2분 — 장중 환율이 그 정도 간격으로 움직인다
const FX_DAILY_TTL_MS = 10 * 60 * 1000;  // 예비(일 1회 갱신) 소스를 쓸 때는 더 자주 볼 이유가 없다
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

// ── 실시간(장중) 환율 ──
// 제공처가 필드 이름이나 단위를 바꾸는 사고를 대비해, 읽은 값이 상식 범위를 벗어나면
// 성공으로 치지 않고 예비 소스로 넘긴다.
async function fetchFxLive() {
  const res = await fetch(FX_LIVE_SOURCE, {
    headers: { "Accept": "application/json" },
    cf: { cacheTtl: 60, cacheEverything: true },
  });
  if (!res.ok) throw new Error(`실시간 환율 제공처 HTTP ${res.status}`);
  const arr = await res.json();
  if (!Array.isArray(arr) || arr.length === 0) throw new Error("실시간 환율 응답 형식 오류");

  // 통화별 "1단위당 원화" 로 정규화 (엔화처럼 100단위로 고시되는 통화가 있다)
  const krwPer = {};
  let usdItem = null;
  for (const it of arr) {
    const cur = String(it && it.currencyCode || "").toUpperCase();
    const unit = Number(it && it.currencyUnit) || 1;
    const base = Number(it && it.basePrice);
    if (!cur || !isFinite(base) || base <= 0) continue;
    krwPer[cur] = base / unit;
    if (cur === "USD") usdItem = it;
  }
  const krwPerUsd = krwPer.USD;
  if (!usdItem || !isFinite(krwPerUsd)) throw new Error("실시간 환율 응답에 USD가 없습니다");
  if (!(krwPerUsd > 500 && krwPerUsd < 5000)) throw new Error(`실시간 환율 값이 비정상입니다 (${krwPerUsd})`);

  // 앱은 USD 기준(1 USD 당 각 통화)으로 쓰므로 환산해서 넘긴다
  const rates = { KRW: krwPerUsd };
  for (const c of FX_PICK) {
    if (c === "KRW" || !krwPer[c]) continue;
    const v = krwPerUsd / krwPer[c];
    if (isFinite(v) && v > 0) rates[c] = v;
  }

  // 전일 종가 대비 등락 — 제공처 값을 그대로 쓴다
  let change = Number(usdItem.signedChangePrice);
  if (!isFinite(change)) {
    const mag = Number(usdItem.changePrice);
    change = isFinite(mag) ? (usdItem.change === "FALL" ? -mag : mag) : null;
  }
  let changeRate = Number(usdItem.signedChangeRate);
  changeRate = isFinite(changeRate) ? changeRate * 100 : null;
  const prevClose = change === null ? null : krwPerUsd - change;
  if (changeRate === null && prevClose > 0) changeRate = (change / prevClose) * 100;

  return {
    base: "USD",
    rates,
    updatedAt: Number(usdItem.timestamp) || Date.now(),
    nextUpdateAt: null,
    // 아래 세 값이 있으면 앱은 로컬 기록 대신 이 값으로 "전일 대비"를 그린다
    prevClose,
    changePrice: change,
    changeRate,
    quoteDate: usdItem.date || null,
    quoteTime: usdItem.time || null,
    live: true,
    source: "두나무 (하나은행 고시)",
  };
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
    live: false,
    source: "ExchangeRate-API",
  };
}

export async function handleFxApi(request, env, url) {
  if (request.method !== "GET") {
    return new Response(JSON.stringify({ error: `메서드 ${request.method} 미지원 (GET만 허용)` }), { status: 405, headers: corsHeadersFx() });
  }
  const now = Date.now();
  const force = url.searchParams.get("force") === "1";

  const ttl = fxCache && fxCache.payload && fxCache.payload.live ? FX_TTL_MS : FX_DAILY_TTL_MS;
  if (!force && fxCache && now - fxCache.at < ttl) {
    return fxJson({ ...fxCache.payload, cached: true, cacheAgeMs: now - fxCache.at });
  }

  try {
    let payload, liveErr = "";
    try {
      payload = await fetchFxLive();               // ① 장중 환율
    } catch (e1) {
      liveErr = e1.message || String(e1);
      payload = await fetchFx();                   // ② 하루 1회 갱신 예비 소스
      payload = { ...payload, liveWarning: liveErr };
    }
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
      // 브라우저·엣지에도 짧게 캐시 허용 — 탭을 여러 개 열어도 Worker 호출이 몰리지 않게.
      // 장중 값은 1분이면 충분히 신선하고, 그 이상 묶어두면 "실시간"이라 하기 어렵다.
      "Cache-Control": "public, max-age=60",
    },
  });
}
