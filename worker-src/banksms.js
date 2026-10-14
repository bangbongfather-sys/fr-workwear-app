// ── 은행 입출금 문자 → 입금 수집함 ──
//
// 아이폰 「단축어」 자동화가 은행 문자를 받으면 POST /api/bank/sms/<토큰> 으로 본문을 보낸다.
// 여기서 날짜·시각·금액·입금자·잔액을 읽어 팝빌과 같은 수집함(/frw_bank_inbox)에 넣는다.
// 앱은 수집함을 자기 입금내역에 합치므로(mergeBankInbox) 엑셀·팝빌과 중복 없이 섞인다.
//  - 은행 로그인·인증서는 어디에도 없다. 문자 본문만 받는다.
//  - 단축어는 헤더를 붙이기 번거로워 주소 안의 토큰으로 검증한다 (캘린더 구독과 같은 방식).
//    토큰은 앱(로그인 필요)에서 발급·폐기하고, 새로 발급하면 이전 주소는 즉시 막힌다.
//  - 출금 문자는 지금은 기록만 하고 입금함에는 넣지 않는다.
import { BANK_INBOX_PATH } from "./bank.js";

const FB_HOST = "njsafety-2ee24-default-rtdb.asia-southeast1.firebasedatabase.app";
export const SMS_CFG_PATH = "/frw_bank_sms";
const SMS_LOG_PATH = "/frw_bank_sms_log";

const fbUrl = (env, path) => `https://${FB_HOST}${path}.json?auth=${encodeURIComponent(env.FIREBASE_DB_SECRET)}`;
async function fbGet(env, path) { const r = await fetch(fbUrl(env, path)); return r.ok ? r.json() : null; }
async function fbPut(env, path, v) { const r = await fetch(fbUrl(env, path), { method: "PUT", body: JSON.stringify(v) }); if (!r.ok) throw new Error(`Firebase ${r.status}`); }
async function fbPatch(env, path, v) { const r = await fetch(fbUrl(env, path), { method: "PATCH", body: JSON.stringify(v) }); if (!r.ok) throw new Error(`Firebase ${r.status}`); }

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" },
});

const money = (s) => Number(String(s).replace(/[^\d]/g, ""));
const isMoney = (t) => /^[\d,]+원?$/.test(t) && /\d/.test(t) && (t.includes(",") || money(t) >= 100);

// 은행 문자 한 통 → { kind:"in"|"out", date, time, amount, bal, name, last4 } 또는 { error }
// 은행·서비스마다 줄바꿈과 순서가 달라서 "모양"으로 찾는다:
//   [KB]10/14 13:22 / 123456**789 / 홍길동 / 전자금융입금 / 550,000 / 잔액12,345,678
//   KB국민 10/14 13:22 1234**5678 (주)다인산업 입금 550,000 잔액 1,234,567
export function parseBankSms(text, nowKst) {
  const raw = String(text || "").replace(/\r/g, "").replace(/\[Web발신\]/g, " ").trim();
  if (!raw) return { error: "빈 문자" };
  const dt = raw.match(/(\d{1,2})\s*\/\s*(\d{1,2})\s+(\d{1,2}):(\d{2})/) || raw.match(/(\d{1,2})\s*\/\s*(\d{1,2})/);
  if (!dt) return { error: "날짜(월/일)를 찾지 못함" };
  const kindM = raw.match(/(입금|출금|지급|이체출금|인출|체크카드|승인)/);
  if (!kindM) return { error: "입금/출금 표시를 찾지 못함" };
  const kind = kindM[1] === "입금" || /입금/.test(raw) && !/출금|지급|인출/.test(raw) ? "in" : "out";
  const balM = raw.match(/잔액\s*:?\s*([\d,]+)/);
  const bal = balM ? money(balM[1]) : null;
  const acctM = raw.match(/(\d{2,8})[*Xx]{1,8}(\d{1,8})/);
  const last4 = acctM ? (acctM[1] + acctM[2]).slice(-4) : "";

  // 잔액·날짜·계좌를 지운 뒤 남은 조각에서 금액과 이름을 고른다
  let rest = raw.replace(/잔액\s*:?\s*[\d,]+원?/g, " ")
    .replace(dt[0], " ")
    .replace(acctM ? acctM[0] : "\u0000", " ")
    .replace(/\[?\s*KB\s*(국민|국민은행|스타뱅킹)?\s*\]?/gi, " ")
    .replace(/국민은행|기업은행|신한|우리|하나|농협/g, " ");
  const parts = rest.split(/\n+/).map(s => s.trim()).filter(Boolean);
  const tokens = parts.length >= 3 ? parts : rest.split(/\s+/).filter(Boolean);
  const kindIdx = tokens.findIndex(t => /입금|출금|지급|인출|승인/.test(t));
  let amtIdx = -1;
  // 입금/출금 표시 바로 뒤 → 바로 앞 → 처음 나오는 금액 모양
  for (const i of [kindIdx + 1, kindIdx - 1]) if (i >= 0 && i < tokens.length && isMoney(tokens[i])) { amtIdx = i; break; }
  if (amtIdx < 0) {
    // "입금 550,000" 처럼 한 조각에 붙어 있는 경우
    const inline = tokens.map((t, i) => [i, t.match(/(입금|출금|지급|인출)\s*([\d,]{3,})원?/)]).find(([, m]) => m);
    if (inline) { amtIdx = inline[0]; tokens[amtIdx] = inline[1][2]; }
  }
  if (amtIdx < 0) amtIdx = tokens.findIndex(isMoney);
  if (amtIdx < 0) return { error: "금액을 찾지 못함" };
  const amount = money(tokens[amtIdx]);
  if (!(amount > 0)) return { error: "금액이 0" };
  const name = tokens.filter((t, i) => i !== amtIdx && i !== kindIdx && !isMoney(t) && !/^(입금|출금|지급|인출|승인|전자금융|타행|자동이체|이체)+$/.test(t))
    .map(t => t.replace(/(전자금융|타행|자동이체)?(입금|출금|지급|인출)$/, "").trim()).filter(Boolean).join(" ").slice(0, 40);

  const [y0, m0] = [Number(nowKst.slice(0, 4)), Number(nowKst.slice(5, 7))];
  const mm = Number(dt[1]), dd = Number(dt[2]);
  const year = mm > m0 + 1 ? y0 - 1 : y0;           // 1월에 받은 12월 문자
  const date = `${year}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
  const time = dt[3] != null ? `${String(dt[3]).padStart(2, "0")}:${dt[4]}` : "";
  return { kind, date, time, amount, bal, name, last4 };
}

const randomToken = () => [...crypto.getRandomValues(new Uint8Array(24))].map(x => x.toString(16).padStart(2, "0")).join("").slice(0, 40);
const kstNow = () => new Date(Date.now() + 9 * 3600e3).toISOString();

// 로그 — 최근 30통 (인식 실패를 앱에서 보고 고칠 수 있게). 계좌번호는 끝 4자리만 남긴다.
async function pushLog(env, entry) {
  const cur = (await fbGet(env, SMS_LOG_PATH)) || [];
  const list = (Array.isArray(cur) ? cur : Object.values(cur)).filter(Boolean);
  list.unshift(entry);
  await fbPut(env, SMS_LOG_PATH, list.slice(0, 30));
}
const maskText = (t) => String(t || "").replace(/(\d{2,8})[*Xx]{1,8}(\d{1,8})/g, (m, a, b) => `****${(a + b).slice(-4)}`).slice(0, 300);

// 공개 경로: POST /api/bank/sms/<토큰>   본문 = 문자 원문(text/plain) 또는 {"text": "..."}
export async function handleBankSmsPublic(request, env, url) {
  const m = /^\/api\/bank\/sms\/([a-f0-9]{16,64})\/?$/.exec(url.pathname);
  if (!m) return json({ error: "Not found" }, 404);
  if (request.method !== "POST") return json({ error: "POST 로 보내 주세요" }, 405);
  const cfg = (await fbGet(env, SMS_CFG_PATH)) || {};
  if (!cfg.token || cfg.token !== m[1]) return json({ error: "주소가 맞지 않습니다 — 앱에서 새 주소를 확인하세요" }, 403);
  let text = "";
  const ct = request.headers.get("content-type") || "";
  try {
    if (ct.includes("application/json")) { const b = await request.json(); text = String(b.text || b.body || b.message || ""); }
    else if (ct.includes("form")) { const f = await request.formData(); text = String(f.get("text") || ""); }
    else text = await request.text();
  } catch { return json({ error: "본문을 읽지 못했습니다" }, 400); }
  text = text.slice(0, 1000);
  const now = kstNow();
  const p = parseBankSms(text, now.slice(0, 10));
  if (p.error) {
    await pushLog(env, { at: now, ok: false, error: p.error, text: maskText(text) });
    return json({ ok: false, error: p.error });
  }
  const ext = `${p.last4 || "sms"}|${p.date.replace(/-/g, "")}${p.time.replace(":", "")}|${p.amount}|${p.bal ?? ""}`;
  if (p.kind !== "in") {
    await pushLog(env, { at: now, ok: true, kind: "out", date: p.date, time: p.time, amount: p.amount, name: p.name, text: maskText(text) });
    return json({ ok: true, kind: "out", skipped: "출금은 입금함에 넣지 않습니다", amount: p.amount });
  }
  const key = ext.replace(/[.#$/\[\]|]/g, "_");
  const item = { ext, acct: p.last4, biz: cfg.biz || "nj", date: p.date, time: p.time, amount: p.amount,
    ...(p.bal != null ? { bal: p.bal } : {}), name: p.name, memo: "", remarks: "문자", src: "sms", collectedAt: Date.now() };
  await fbPatch(env, BANK_INBOX_PATH, { [key]: item });
  await pushLog(env, { at: now, ok: true, kind: "in", date: p.date, time: p.time, amount: p.amount, name: p.name, text: maskText(text) });
  await fbPatch(env, SMS_CFG_PATH, { lastAt: now });
  return json({ ok: true, kind: "in", date: p.date, time: p.time, amount: p.amount, name: p.name });
}

// 관리 경로 (로그인 필요): /api/bank/smskey/status | issue | disable
export async function handleBankSmsAdmin(request, env, url) {
  const cfg = (await fbGet(env, SMS_CFG_PATH)) || {};
  const p = url.pathname.replace(/\/+$/, "");
  if (p === "/api/bank/smskey/status") {
    const log = (await fbGet(env, SMS_LOG_PATH)) || [];
    return json({ enabled: !!cfg.token, token: cfg.token || null, biz: cfg.biz || "nj", at: cfg.at || null, lastAt: cfg.lastAt || null,
      log: (Array.isArray(log) ? log : Object.values(log)).filter(Boolean).slice(0, 15) });
  }
  if (p === "/api/bank/smskey/issue" && request.method === "POST") {
    let b = {}; try { b = await request.json(); } catch {}
    const next = { token: randomToken(), biz: b.biz === "corp" ? "corp" : "nj", at: kstNow() };
    await fbPut(env, SMS_CFG_PATH, next);
    return json({ ok: true, ...next });
  }
  if (p === "/api/bank/smskey/disable" && request.method === "POST") {
    await fbPut(env, SMS_CFG_PATH, { token: "", biz: cfg.biz || "nj", at: kstNow() });
    return json({ ok: true, enabled: false });
  }
  // 문자 붙여 넣고 미리 읽어 보기 (저장하지 않음)
  if (p === "/api/bank/smskey/test" && request.method === "POST") {
    let b = {}; try { b = await request.json(); } catch {}
    return json(parseBankSms(String(b.text || ""), kstNow().slice(0, 10)));
  }
  return json({ error: "Not found" }, 404);
}
