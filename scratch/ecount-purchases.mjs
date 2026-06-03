// 이카운트 발주서조회 API 검증 — ZONE → 로그인 → 발주서조회(GetPurchasesOrderList)
// ⚠️ 검증 전용(read-only). Worker/MCP 코드와 분리. 비밀값은 .dev.vars 에서만.
// 요청 body 형태(평면 vs 중첩 ListParam)가 가이드상 모호 → 둘 다 시도해 맞는 쪽 확인.
// 실행: node --env-file=.dev.vars scratch/ecount-purchases.mjs

const COM_CODE     = process.env.ECOUNT_COM_CODE;
const USER_ID      = process.env.ECOUNT_USER_ID;
const API_CERT_KEY = process.env.ECOUNT_API_CERT_KEY;
const LAN_TYPE     = "ko-KR";
const DOMAIN       = process.env.ECOUNT_DOMAIN || "sboapi";

const missing = [];
if (!COM_CODE)     missing.push("ECOUNT_COM_CODE");
if (!USER_ID)      missing.push("ECOUNT_USER_ID");
if (!API_CERT_KEY) missing.push("ECOUNT_API_CERT_KEY");
if (missing.length) { console.error("❌ .dev.vars 누락:", missing.join(", ")); process.exit(1); }

const pretty = (o) => JSON.stringify(o, null, 2);
const ymd = (d) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;

async function postJson(url, body) {
  let res;
  try {
    res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  } catch (e) { return { status: 0, json: { _networkError: String(e?.message || e) } }; }
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { _nonJson: true, _raw: text.slice(0, 1000) }; }
  return { status: res.status, json };
}

// 응답에서 핵심 요약 (Result 개수/첫 항목)
function summarize(label, r) {
  const d = r.json?.Data;
  const cnt = d?.TotalCnt;
  const arr = d?.Result;
  console.log(`\n[${label}] HTTP ${r.status} / Status ${r.json?.Status ?? "?"} / TotalCnt ${cnt ?? "?"} / Result ${Array.isArray(arr) ? arr.length + "건" : "(배열 아님)"}`);
  const errMsg = r.json?.Error?.Message || r.json?.Data?.Message;
  if (errMsg) console.log(`   ⚠️ 메시지: ${errMsg}`);
}

(async () => {
  console.log("════════ 이카운트 발주서조회 검증 ════════\n");

  // 1) ZONE
  const zone = await postJson(`https://${DOMAIN}.ecount.com/OAPI/V2/Zone`, { COM_CODE });
  const ZONE = zone.json?.Data?.ZONE ?? zone.json?.ZONE;
  if (!ZONE) { console.error("❌ ZONE 실패:\n" + pretty(zone.json)); throw new Error("ZONE_FAIL"); }
  console.log("✅ ZONE =", ZONE);

  // 2) 로그인
  const login = await postJson(`https://${DOMAIN}${ZONE}.ecount.com/OAPI/V2/OAPILogin`, { COM_CODE, USER_ID, API_CERT_KEY, LAN_TYPE, ZONE });
  const SESSION_ID = login.json?.Data?.Datas?.SESSION_ID ?? login.json?.Data?.SESSION_ID;
  if (!SESSION_ID) {
    const msg = login.json?.Data?.Message || "";
    console.error("❌ 로그인 실패:", msg || pretty(login.json));
    if (/IP/i.test(msg)) { const m = msg.match(/\[([\d.]+)\]/); console.error("👉 IP 등록 필요:", m?.[1] || "(응답 참고)"); }
    throw new Error("LOGIN_FAIL");
  }
  console.log("✅ 로그인 성공 (SESSION_ID 획득)");

  // 3) 발주서조회 — 최근 30일
  const today = new Date();
  const from = new Date(today); from.setDate(from.getDate() - 29);
  const FROM = ymd(from), TO = ymd(today);
  console.log(`\n조회 기간: ${FROM} ~ ${TO} (최근 30일)`);

  const url = `https://${DOMAIN}${ZONE}.ecount.com/OAPI/V2/Purchases/GetPurchasesOrderList?SESSION_ID=${encodeURIComponent(SESSION_ID)}`;

  // 시도 A: 평면(flat) body
  console.log("\n──────── 시도 A: 평면(flat) body ────────");
  const flatBody = { SESSION_ID, PROD_CD: "", CUST_CD: "", BASE_DATE_FROM: FROM, BASE_DATE_TO: TO, PAGE_CURRENT: 1, PAGE_SIZE: 100 };
  console.log("요청 body:", JSON.stringify(flatBody));
  const a = await postJson(url, flatBody);
  summarize("A:평면", a);
  console.log(pretty(a.json));

  // 시도 B: 중첩(ListParam) body
  console.log("\n──────── 시도 B: 중첩(ListParam) body ────────");
  const nestedBody = { SESSION_ID, PROD_CD: "", CUST_CD: "", ListParam: { BASE_DATE_FROM: FROM, BASE_DATE_TO: TO, PAGE_CURRENT: 1, PAGE_SIZE: 100 } };
  console.log("요청 body:", JSON.stringify(nestedBody));
  const b = await postJson(url, nestedBody);
  summarize("B:중첩", b);
  console.log(pretty(b.json));

  console.log("\n════════ 검증 완료 ════════");
  console.log("• Data.Result에 데이터가 채워진 쪽이 올바른 body 형태입니다.");
  console.log("• 둘 다 200인데 Result가 비었으면 → 해당 기간에 발주가 없을 수 있어요(기간 조정 필요).");
})().catch((e) => { console.error("\n(검증 중단:", e?.message || e, ")"); process.exitCode = 1; });
