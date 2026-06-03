// 이카운트(ECOUNT) Open API 검증 스크립트 — ZONE 조회 → 로그인 → 재고 조회
// ⚠️ 검증 전용. Worker/MCP 서버 코드와 완전히 분리됨. 아무것도 import 안 함.
// ⚠️ 비밀값(인증키/회사코드/유저ID)은 .dev.vars 에서만 읽음 (코드에 하드코딩 X, .gitignore 처리됨).
//
// 실행:  node --env-file=.dev.vars scratch/ecount-verify.mjs
//   (Node 20.6+ 의 --env-file 로 .dev.vars 를 환경변수로 로드)
//
// 도메인: 테스트=sboapi, 운영=oapi. 지금은 sboapi 로 검증.

const COM_CODE     = process.env.ECOUNT_COM_CODE;
const USER_ID      = process.env.ECOUNT_USER_ID;
const API_CERT_KEY = process.env.ECOUNT_API_CERT_KEY;
const LAN_TYPE     = "ko-KR";
const DOMAIN       = process.env.ECOUNT_DOMAIN || "sboapi"; // 운영 전환 시 .dev.vars 에 ECOUNT_DOMAIN=oapi

// ── 환경변수 검증 ──
const missing = [];
if (!COM_CODE)     missing.push("ECOUNT_COM_CODE");
if (!USER_ID)      missing.push("ECOUNT_USER_ID");
if (!API_CERT_KEY) missing.push("ECOUNT_API_CERT_KEY");
if (missing.length) {
  console.error("❌ .dev.vars 에 다음 값이 없습니다:", missing.join(", "));
  console.error("   실행: node --env-file=.dev.vars scratch/ecount-verify.mjs");
  process.exit(1);
}

const pretty = (o) => JSON.stringify(o, null, 2);
const todayYmd = () => {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
};

async function postJson(url, body) {
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (e) {
    return { status: 0, json: { _networkError: String(e?.message || e) } };
  }
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); }
  catch { json = { _nonJson: true, _raw: text.slice(0, 1000) }; }
  return { status: res.status, json };
}

(async () => {
  console.log("════════════ 이카운트 API 검증 ════════════");
  console.log(`회사코드(COM_CODE): ${COM_CODE}`);
  console.log(`유저(USER_ID): ${USER_ID}`);
  console.log(`도메인: ${DOMAIN}  (테스트=sboapi, 운영=oapi)\n`);

  // ── 1단계: ZONE 조회 ──
  console.log("──────── 1단계: ZONE 조회 ────────");
  const zoneUrl = `https://${DOMAIN}.ecount.com/OAPI/V2/Zone`;
  const zone = await postJson(zoneUrl, { COM_CODE });
  console.log(`POST ${zoneUrl}\nHTTP ${zone.status}`);
  console.log(pretty(zone.json));
  const ZONE = zone.json?.Data?.ZONE ?? zone.json?.ZONE ?? zone.json?.Data?.Datas?.ZONE;
  if (!ZONE) {
    console.error("\n❌ ZONE을 응답에서 찾지 못했습니다. 위 JSON에서 실제 ZONE 위치를 확인하세요.");
    throw new Error("ZONE_NOT_FOUND");
  }
  console.log(`\n✅ ZONE = ${ZONE}\n`);

  // ── 2단계: 로그인 (SESSION_ID 발급) ──
  console.log("──────── 2단계: 로그인 (SESSION_ID) ────────");
  const loginUrl = `https://${DOMAIN}${ZONE}.ecount.com/OAPI/V2/OAPILogin`;
  const login = await postJson(loginUrl, { COM_CODE, USER_ID, API_CERT_KEY, LAN_TYPE, ZONE });
  console.log(`POST ${loginUrl}\nHTTP ${login.status}`);
  console.log(pretty(login.json));
  const SESSION_ID =
    login.json?.Data?.Datas?.SESSION_ID ??
    login.json?.Data?.SESSION_ID ??
    login.json?.SESSION_ID;
  if (!SESSION_ID) {
    const msg = login.json?.Data?.Message || "";
    console.error("\n❌ 로그인 실패 — SESSION_ID를 받지 못했습니다.");
    if (/IP/i.test(msg)) {
      const ipMatch = msg.match(/\[([\d.]+)\]/);
      console.error("👉 [IP 차단] 이카운트 ERP > API인증키발급 > IP등록 에 아래 IP를 등록하세요:");
      if (ipMatch) console.error("   등록할 IP: " + ipMatch[1]);
    }
    if (msg) console.error("   응답 메시지: " + msg);
    console.error("   (인증키/회사코드/유저ID 가 sboapi(테스트) 계정 기준인지도 확인)");
    throw new Error("LOGIN_FAILED");
  }
  console.log(`\n✅ SESSION_ID = ${String(SESSION_ID).slice(0, 10)}…(로그에선 일부만 표시)\n`);

  // ── 3단계: 재고 조회 (위치별 재고현황) ──
  console.log("──────── 3단계: 재고 조회 ────────");
  const invUrl = `https://${DOMAIN}${ZONE}.ecount.com/OAPI/V2/InventoryBalance/GetListInventoryBalanceStatusByLocation?SESSION_ID=${encodeURIComponent(SESSION_ID)}`;
  const invBody = { SESSION_ID, BASE_DATE: todayYmd(), COM_CODE, USER_ID, ZONE, API_CERT_KEY, LAN_TYPE };
  const inv = await postJson(invUrl, invBody);
  console.log(`POST .../InventoryBalance/GetListInventoryBalanceStatusByLocation`);
  console.log(`BASE_DATE=${invBody.BASE_DATE}, HTTP ${inv.status}`);
  console.log(pretty(inv.json));

  console.log("\n════════════ 검증 완료 ════════════");
  console.log("↑ 재고 응답의 필드 구조(보통 Data.Result 배열)를 그대로 확인하세요.");
  console.log("※ 응답을 채팅에 붙일 땐 SESSION_ID / API_CERT_KEY 부분은 가려주세요.");
})().catch((e) => { console.error("\n(검증 중단:", e?.message || e, ")"); process.exitCode = 1; });
