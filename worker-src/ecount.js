// ── 이카운트 ERP 오픈API (재고) ──
//
// 흐름: Zone 조회 → 로그인(SESSION_ID) → 재고현황 조회 (+ 품목 목록으로 이름·규격 보충)
//  - 테스트 키는 sboapi…, 정식 키는 oapi… 도메인을 쓴다 (ECOUNT_TEST 로 고른다, 기본 테스트)
//  - 이카운트 응답 필드 이름이 문서·버전마다 조금씩 달라서 이름 후보 여러 개 중 있는 것을 쓴다.
//    처음 연결할 때 MCP `_ecount:probe` 로 원본 몇 줄을 보고 맞춘다.
//
// 필요 시크릿 (등록 전에는 configured:false — 앱은 연동 띠를 숨긴다)
//   ECOUNT_COM_CODE : 회사코드          ECOUNT_USER_ID : API 를 쓸 ERP 사용자 ID
//   ECOUNT_API_KEY  : API 인증키 (테스트 키 또는 정식 키)
//   ECOUNT_TEST     : "false" 면 정식(oapi), 그 밖에는 테스트(sboapi)

export const ecountConfigured = (env) => !!(env.ECOUNT_COM_CODE && env.ECOUNT_USER_ID && env.ECOUNT_API_KEY);
const isTest = (env) => String(env.ECOUNT_TEST ?? "true") !== "false";
const host = (env, zone) => `https://${isTest(env) ? "sboapi" : "oapi"}${zone || ""}.ecount.com`;

async function post(url, body) {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
  const text = await r.text();
  let j; try { j = JSON.parse(text); } catch { throw new Error(`이카운트 응답을 읽지 못함 (${r.status}): ${text.slice(0, 160)}`); }
  // 이카운트는 HTTP 200 안에 Status·Error 로 실패를 알린다
  const err = j && (j.Error || (j.Data && j.Data.Error));
  if (!r.ok || (j && String(j.Status || "200") !== "200") || (err && (err.Message || err.Code))) {
    throw new Error(`이카운트 오류: ${(err && (err.Message || err.Code)) || j.Status || r.status}`);
  }
  return j;
}

// 로그인 — { zone, session }
export async function ecountLogin(env) {
  if (!ecountConfigured(env)) throw new Error("이카운트 연동 정보(회사코드·사용자ID·인증키)가 아직 등록되지 않았습니다");
  const COM_CODE = String(env.ECOUNT_COM_CODE).trim();
  const z = await post(`${host(env)}/OAPI/V2/Zone`, { COM_CODE });
  const zone = (z.Data && (z.Data.ZONE || z.Data.Zone)) || z.ZONE;
  if (!zone) throw new Error("이카운트 Zone 을 받지 못했습니다 (회사코드 확인)");
  const l = await post(`${host(env, zone)}/OAPI/V2/OAPILogin`, {
    COM_CODE, USER_ID: String(env.ECOUNT_USER_ID).trim(), API_CERT_KEY: String(env.ECOUNT_API_KEY).trim(), LAN_TYPE: "ko-KR", ZONE: zone,
  });
  const d = l.Data || {};
  const session = (d.Datas && d.Datas.SESSION_ID) || d.SESSION_ID;
  if (!session) throw new Error(`이카운트 로그인 실패: ${(d.Message || d.Code || "SESSION_ID 없음")}`);
  return { zone, session };
}

const rowsOf = (j) => {
  const d = (j && j.Data) || {};
  const r = d.Result || d.Datas || d.Data || j.Result;
  return Array.isArray(r) ? r : (r && typeof r === "object" ? Object.values(r) : []);
};
const pick = (o, keys) => { for (const k of keys) if (o && o[k] != null && String(o[k]).trim() !== "") return o[k]; return ""; };
const num = (v) => { const n = Number(String(v ?? "").replace(/[,\s]/g, "")); return Number.isFinite(n) ? n : NaN; };
const kstYmd = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10).replace(/-/g, "");

// 재고현황 원본 행 (품목별 합계) — 결과는 PROD_CD·BAL_QTY 뿐이라 이름은 품목조회로 채운다.
// ZERO_FLAG 기본값 N 이면 재고 0 품목이 빠져 와서 앱 목록에서 사라진다(안전재고 설정도) → Y 로 받는다.
export async function ecountInventoryRaw(env, s) {
  const j = await post(`${host(env, s.zone)}/OAPI/V2/InventoryBalance/GetListInventoryBalanceStatus?SESSION_ID=${encodeURIComponent(s.session)}`, { BASE_DATE: kstYmd(), PROD_CD: "", WH_CD: "", ZERO_FLAG: "Y" });
  return rowsOf(j);
}
// 품목 목록 원본 행 (이름·규격·단위 보충용) — 실패해도 재고는 진행
export async function ecountProductsRaw(env, s) {
  try {
    const j = await post(`${host(env, s.zone)}/OAPI/V2/InventoryBasic/GetBasicProductsList?SESSION_ID=${encodeURIComponent(s.session)}`, {});
    return rowsOf(j);
  } catch { return []; }
}

const CODE_KEYS = ["PROD_CD", "PROD_CODE", "ITEM_CD"];
const NAME_KEYS = ["PROD_DES", "PROD_NM", "PROD_NAME", "ITEM_NM"];
const SPEC_KEYS = ["SIZE_DES", "PROD_SIZE", "SPEC", "SIZE_FLAG_DES"];
const UNIT_KEYS = ["UNIT", "UNIT_DES"];
const QTY_KEYS = ["BAL_QTY", "QTY", "STOCK_QTY", "INV_QTY"];
const CAT_KEYS = ["CLASS_DES", "PROD_TYPE_DES", "CLASS_CD"];

// 재고 품목 목록 — 앱 재고 탭의 엑셀 업로드 결과와 같은 모양 {code, name, spec, unit, cat, qty}
export async function ecountStockItems(env) {
  const s = await ecountLogin(env);
  const inv = await ecountInventoryRaw(env, s);
  const prods = await ecountProductsRaw(env, s);
  const info = new Map();
  for (const p of prods) {
    const code = String(pick(p, CODE_KEYS)).trim();
    // 품목구분 PROD_TYPE: 0 원재료 · 1 제품 · 2 반제품 · 3 상품 · 4 부재료 · 7 무형상품 (품목조회 API 문서)
    const PT = { 0: "원재료", 1: "제품", 2: "반제품", 3: "상품", 4: "부재료", 7: "무형상품" };
    const cat = String(pick(p, CAT_KEYS)).trim() || PT[String(pick(p, ["PROD_TYPE"])).trim()] || "";
    if (code) info.set(code, { name: String(pick(p, NAME_KEYS)).trim(), spec: String(pick(p, SPEC_KEYS)).trim(), unit: String(pick(p, UNIT_KEYS)).trim(), cat });
  }
  const byCode = new Map();
  for (const r of inv) {
    const code = String(pick(r, CODE_KEYS)).trim();
    const qty = num(pick(r, QTY_KEYS));
    if (!code || !Number.isFinite(qty)) continue;
    const cur = byCode.get(code);
    if (cur) { cur.qty += qty; continue; }       // 창고별로 나뉘어 오면 합친다
    const pi = info.get(code) || {};
    byCode.set(code, {
      code, qty,
      name: String(pick(r, NAME_KEYS) || pi.name || "").trim(),   // 비면 앱 쪽에서 기존 이름(없으면 코드)으로 채운다
      spec: String(pick(r, SPEC_KEYS) || pi.spec || "").trim(),
      unit: String(pick(r, UNIT_KEYS) || pi.unit || "").trim(),
      cat: String(pi.cat || "").trim(),
    });
  }
  return { items: [...byCode.values()], invRows: inv.length, prodRows: prods.length };
}

// 연결 점검 — 원본 몇 줄과 필드 이름 (필드 이름 맞추기용)
export async function ecountProbe(env) {
  if (!ecountConfigured(env)) return { configured: false, test: isTest(env) };
  const out = { configured: true, test: isTest(env) };
  try {
    const s = await ecountLogin(env); out.zone = s.zone; out.login = "성공";
    const inv = await ecountInventoryRaw(env, s);
    out.inventory = { rows: inv.length, keys: inv[0] ? Object.keys(inv[0]) : [], sample: inv.slice(0, 3) };
    const prods = await ecountProductsRaw(env, s);
    out.products = { rows: prods.length, keys: prods[0] ? Object.keys(prods[0]) : [], sample: prods.slice(0, 2) };
  } catch (e) { out.error = e.message; }
  return out;
}
