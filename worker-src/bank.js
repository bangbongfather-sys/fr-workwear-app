// ── 은행 입금 자동수집 API (/api/bank/*) ──
//
// 팝빌 계좌조회로 모은 입금은 앱 데이터(/frw/bankDeposits)에 직접 쓰지 않고
// 별도 수집함(/frw_bank_inbox)에 쌓는다. 앱이 이 수집함을 받아 자기 입금내역에 합친다.
//  - 이유: 앱 동기화는 섹션 rev 가 맞을 때만 올린다. Worker 가 rev 를 올려 버리면
//          그 순간 입금내역을 고치던 기기가 충돌을 맞는다. 병합은 앱이 기존 규칙 안에서 한다.
//  - 수집함 항목: { ext, acct, biz, date, time, amount, bal, name, memo, remarks, collectedAt }
//    ext = "계좌끝4자리|거래일시|입금액|거래후잔액" — 같은 거래는 몇 번 다시 수집해도 같은 값.
//
// 필요 시크릿 (등록 전에는 status 가 configured:false 를 돌려주고 앱은 자동수집 UI 를 숨긴다)
//   POPBILL_LINK_ID, POPBILL_SECRET_KEY : 팝빌 연동신청 때 메일로 받은 값
//   POPBILL_ACCOUNTS : [{ id, corpNum, bankCode, accountNumber, biz, alias }] JSON — 계좌번호는 저장소에 두지 않는다
// 은행 비밀번호·인터넷뱅킹 ID 는 팝빌 사이트에만 등록한다. 여기엔 없다.

const FB_HOST = "njsafety-2ee24-default-rtdb.asia-southeast1.firebasedatabase.app";
export const BANK_INBOX_PATH = "/frw_bank_inbox";
export const BANK_STATUS_PATH = "/frw_bank_status";

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" },
});

async function fbGet(env, path) {
  const r = await fetch(`https://${FB_HOST}${path}.json?auth=${encodeURIComponent(env.FIREBASE_DB_SECRET)}`);
  return r.ok ? r.json() : null;
}

// 등록된 계좌 목록 (계좌번호는 끝 4자리만 밖으로 낸다)
export function bankAccounts(env) {
  try {
    const list = JSON.parse(env.POPBILL_ACCOUNTS || "[]");
    return Array.isArray(list) ? list.filter(a => a && a.id && a.accountNumber) : [];
  } catch { return []; }
}
export function bankConfigured(env) {
  return !!(env.POPBILL_LINK_ID && env.POPBILL_SECRET_KEY && bankAccounts(env).length);
}

export async function handleBankApi(request, env, url) {
  const path = url.pathname.replace(/\/+$/, "");

  // 수집함 — 앱이 자기 입금내역에 합칠 재료. 90일치 정도라 통째로 내려도 작다.
  if (path === "/api/bank/inbox" && request.method === "GET") {
    const raw = await fbGet(env, BANK_INBOX_PATH);
    const items = raw && typeof raw === "object" ? Object.values(raw).filter(x => x && x.ext) : [];
    items.sort((a, b) => String(a.date + (a.time || "")).localeCompare(String(b.date + (b.time || ""))));
    return json({ items });
  }

  // 수집 상태 — 앱의 「자동 수집」 띠에 계좌별 마지막 수집 시각·오류를 보여준다
  if (path === "/api/bank/status" && request.method === "GET") {
    const configured = bankConfigured(env);
    const accounts = bankAccounts(env).map(a => ({
      id: a.id, biz: a.biz || "nj", alias: a.alias || "", bankCode: a.bankCode || "",
      last4: String(a.accountNumber).replace(/\D/g, "").slice(-4),
    }));
    const status = configured ? await fbGet(env, BANK_STATUS_PATH) : null;
    return json({ configured, test: env.POPBILL_IS_TEST !== "false", accounts, status: status || {} });
  }

  // 지금 수집 — 팝빌 연결(수집 모듈)은 다음 단계에서 붙인다
  if (path === "/api/bank/collect" && request.method === "POST") {
    if (!bankConfigured(env)) return json({ error: "not_configured", message: "팝빌 연동 정보가 아직 등록되지 않았습니다" }, 503);
    return json({ error: "not_ready", message: "팝빌 수집 모듈을 준비 중입니다" }, 501);
  }

  return json({ error: "Not found" }, 404);
}
