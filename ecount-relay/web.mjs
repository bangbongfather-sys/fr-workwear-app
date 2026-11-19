// NJ SAFETY — 이카운트 웹 판매조회 로봇 (맥 또는 GitHub Actions 에서 실행)
//
// GitHub Actions 에서 돌 때(.github/workflows/ecount-sales.yml — 맥이 꺼져 있어도 되게):
//  - 회사코드·아이디·비밀번호는 GitHub 저장소의 Secrets 에서 환경 변수로만 받는다
//  - 회사 앱과는 GitHub 가 그때그때 발급하는 실행 증명(OIDC)으로 통신한다 — 따로 넣어 둘 인증키가 없다
//  - 저장소가 공개라 실행 기록도 공개된다 → 화면·금액·거래처·오류 문구는 기록에 찍지 않고 회사 앱으로만 보낸다
//
// 이카운트 공개 API 에는 판매 「조회」가 없어서, 맥의 Chrome 을 화면 없이(헤드리스) 띄워 이카운트 웹에 로그인하고
// 판매조회 화면을 읽어 회사 앱으로 보낸다. 이 파일은 맥이 실행할 때마다 회사 앱에서 최신본을 받아 쓴다.
//  - 회사코드·아이디·비밀번호는 맥 키체인에서만 꺼낸다 (화면 기록·전송 내용에 넣지 않는다)
//  - 이카운트에서는 읽기만 한다 — 전표를 고치거나 지우지 않는다
//  - 「다른 곳에서 로그인 중」 같은 확인창은 누르지 않고 닫는다 (사람이 쓰던 접속을 끊지 않게)
//
// 실행: node web.mjs check            — 회사 앱에 걸린 요청이 있을 때만 실행 (1분마다 launchd 가 부름)
//       node web.mjs probe            — 지금 바로 정찰 (로그인 → 판매조회 메뉴까지 화면을 찍어 보냄)
//       node web.mjs import 2024-12-13 2024-12-31
import { chromium } from "playwright-core";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";

const VERSION = "2026-11-19-fast1";
const GH = !!process.env.GITHUB_ACTIONS;   // GitHub Actions 에서 도는 중
const APP = process.env.NJ_APP || "https://fr-workwear-app.njsafety91.workers.dev";
const DIR = process.env.NJ_DIR || (GH ? join(process.env.RUNNER_TEMP || "/tmp", "nj-ecount") : join(homedir(), "Library/Application Support/nj-ecount"));
const LOGIN_URL = process.env.NJ_LOGIN_URL || "https://login.ecount.com/Login/";
const CHROME = process.env.NJ_CHROME || (GH ? "/usr/bin/google-chrome" : "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
const DEV = GH ? "github" : "office-mac";

const ENVKEY = { "nj-ecount-key": "NJ_ECOUNT_KEY", "nj-ecount-com": "NJ_ECOUNT_COM", "nj-ecount-web-id": "NJ_ECOUNT_WEB_ID", "nj-ecount-web-pw": "NJ_ECOUNT_WEB_PW" };
const kc = (s) => { if (process.env["NJ_KC_" + s]) return process.env["NJ_KC_" + s]; if (process.env[ENVKEY[s]]) return process.env[ENVKEY[s]].trim(); if (GH) return ""; try { return execFileSync("security", ["find-generic-password", "-a", userInfo().username, "-s", s, "-w"], { encoding: "utf8" }).trim(); } catch { return ""; } };
const sha256 = async (t) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t)))].map((b) => b.toString(16).padStart(2, "0")).join("");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (...a) => console.log(new Date().toISOString().slice(0, 19).replace("T", " "), ...a);
const quiet = (t) => (GH ? "(자세한 내용은 회사 앱 기록에)" : t);   // 공개되는 실행 기록에는 자세한 내용을 찍지 않는다

const KEY = kc("nj-ecount-key");
const RELAY = process.env.NJ_RELAY || (KEY ? await sha256(KEY) : "");
// GitHub Actions 실행 증명(OIDC) — 몇 분만 유효해서 회사 앱을 부를 때마다 새로 받는다
const OIDC = GH && process.env.ACTIONS_ID_TOKEN_REQUEST_URL && process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
async function oidc() {
  const r = await fetch(`${process.env.ACTIONS_ID_TOKEN_REQUEST_URL}&audience=nj-websales`, { headers: { Authorization: `bearer ${process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` } });
  const j = await r.json().catch(() => ({})); if (!j.value) throw new Error(`실행 증명을 받지 못했습니다 (${r.status})`); return j.value;
}
const CAN_AUTH = !!(RELAY || OIDC);
async function api(path, body, dev = DEV) {
  const H = { "Content-Type": "application/json", "X-Relay-Dev": dev };
  if (RELAY) H["X-Relay-Key"] = RELAY; else if (OIDC) { try { H.Authorization = `Bearer ${await oidc()}`; } catch (e) { return { error: e.message }; } }
  const r = await fetch(APP + path, body ? { method: "POST", headers: H, body: JSON.stringify(body) } : { headers: H });
  const t = await r.text(); try { return JSON.parse(t); } catch { return { error: `응답 읽기 실패 ${r.status}: ${t.slice(0, 200)}` }; }
}

// ── 무엇을 할지 ──
const [cmd = "check", a1 = "", a2 = ""] = process.argv.slice(2);
let job;
if (cmd === "selftest") {
  // 점검 — 회사 앱 인증 · Chrome 실행 · 이카운트 로그인 화면이 열리는지만 본다 (로그인하지 않는다. 요청도 가져가지 않는다)
  const p = await api("/api/ecount/websales/pending", null, "setup");
  say("회사 앱 인증:", p && p.setup ? "됨" : `안 됨 (${(p && p.error) || "응답 이상"})`);
  say("비밀 값:", ["nj-ecount-com", "nj-ecount-web-id", "nj-ecount-web-pw"].map((k) => (kc(k) ? "있음" : "없음")).join(" · "), "(회사코드 · 아이디 · 비밀번호)");
  let ok = !!(p && p.setup);
  try {
    if (!existsSync(CHROME)) throw new Error("Chrome 없음");
    const b = await chromium.launch({ executablePath: CHROME, headless: true, args: GH ? ["--no-sandbox"] : [] });
    const pg = await b.newPage({ locale: "ko-KR", timezoneId: "Asia/Seoul" });
    await pg.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 45000 }); await pg.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
    const form = await pg.locator("input[type=password]").count();
    say("Chrome 실행: 됨 · 이카운트 로그인 화면:", form ? "열림" : "입력 칸이 안 보임", "· 주소:", new URL(pg.url()).hostname);
    if (!form) ok = false;
    await b.close();
  } catch (e) { say("Chrome·이카운트 화면 점검 실패:", e.message.split("\n")[0]); ok = false; }
  process.exit(ok ? 0 : 1);
}
if (cmd === "check") {
  if (!CAN_AUTH) { if (GH) { say("회사 앱과 통신할 실행 증명이 없습니다"); process.exit(1); } process.exit(0); }
  const p = await api("/api/ecount/websales/pending");
  if (GH && p && p.error) { say("회사 앱이 받아 주지 않았습니다:", p.error); process.exit(1); }
  if (!p || !p.pending) { if (GH) say(p && p.busy ? "다른 로봇이 이미 처리 중 — 끝" : "걸린 요청 없음 — 끝"); process.exit(0); }
  job = { mode: p.mode || "probe", from: p.from || "", to: p.to || "" };
  say("요청 받음", JSON.stringify(job));
  if (!GH) try {
    const self = fileURLToPath(import.meta.url);
    const r = await fetch(APP + "/ecount-relay/web.mjs", { cache: "no-store" });
    const latest = r.ok ? await r.text() : "";
    if (latest.includes("NJ SAFETY") && latest !== readFileSync(self, "utf8")) {
      writeFileSync(self, latest);
      say("최신 로봇으로 바꿔 실행");
      const rr = spawnSync(process.execPath, [self, job.mode, job.from, job.to], { stdio: "inherit", env: process.env });
      process.exit(rr.status == null ? 1 : rr.status);
    }
  } catch (e) { say("최신본 확인 실패(있던 것으로 계속):", e.message); }
} else job = { mode: cmd === "import" ? "import" : "probe", from: a1, to: a2 };

const COM = kc("nj-ecount-com"), ID = kc("nj-ecount-web-id"), PW = kc("nj-ecount-web-pw");
const t0 = Date.now();
const steps = [], shots = [], net = [], dialogs = [];
let phase = 1;   // 어느 단계에서 주고받은 자료인지 (4 이상 = 판매조회 화면)
let listReq = null;   // 판매조회 목록 요청 { url, headers, body }
let browser = null, page = null;
const out = { mode: job.mode, from: job.from, to: job.to, ok: false, error: "", version: VERSION };

async function finish() {
  out.steps = steps; out.shots = shots; out.net = net; out.dialogs = dialogs; out.took = Math.round((Date.now() - t0) / 1000);
  try { if (browser) await browser.close(); } catch {}
  const r = CAN_AUTH ? await api("/api/ecount/websales/push", out) : { error: "인증키 없음" };
  say(out.ok ? "끝" : `실패: ${quiet(out.error)}`, "→ 회사 앱:", GH ? (r && r.saved ? "받음" : `못 받음 (${(r && r.error) || "응답 이상"})`) : JSON.stringify(r).slice(0, 300));
  process.exit(out.ok || (GH && r && r.saved) ? 0 : 1);   // GitHub 에서는 결과를 회사 앱에 넘겼으면 「실패」로 끝내지 않는다 — 실패할 때마다 GitHub 가 실패 메일을 보내서
}

// 화면 기록 — 글자·입력칸·단추 목록 (입력칸에 넣은 값은 기록하지 않는다)
async function snap(name, note = "", shot = true) {
  if (!page) return;
  try {
    const d = await page.evaluate(() => {
      const vis = (e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none"; };
      const inputs = [...document.querySelectorAll("input, select, textarea")].filter(vis).slice(0, 40)
        .map((e) => ({ tag: e.tagName.toLowerCase(), type: e.type || "", id: e.id || "", name: e.name || "", ph: e.placeholder || "", title: e.title || "" }));
      const buttons = [...document.querySelectorAll("button, a, input[type=button], input[type=submit], [role=button]")].filter(vis)
        .map((e) => (e.innerText || e.value || e.title || e.id || "").trim().replace(/\s+/g, " ")).filter(Boolean).slice(0, 60);
      return { title: document.title, text: (document.body ? document.body.innerText : "").replace(/\n{2,}/g, "\n").slice(0, 4000), inputs, buttons };
    });
    steps.push({ name, url: page.url(), note, frames: page.frames().map((f) => f.url()).filter((u) => u && u !== "about:blank"), ...d });
    if (shot && shots.length < 8) shots.push({ name, data: (await page.screenshot({ type: "jpeg", quality: 45 })).toString("base64") });
  } catch (e) { steps.push({ name, note: `기록 실패: ${e.message}` }); }
}
const fail = async (msg) => { out.error = msg; await snap("실패한 화면", msg); await finish(); };

// 모든 프레임에서 첫 번째로 보이는 요소 찾기
async function findVisible(selectors) {
  for (const f of page.frames()) for (const sel of selectors) {
    try { const loc = f.locator(sel); const n = await loc.count(); for (let i = 0; i < n; i++) { const el = loc.nth(i); if (await el.isVisible()) return el; } } catch {}
  }
  return null;
}

// 붙잡은 목록 요청을 기간만 바꿔 다시 보낸다 — 화면 안에서 보내므로 로그인 상태(쿠키)를 그대로 쓴다. 읽기만.
async function fetchRange(from, to, dm) {
  if (!dm) return { error: "화면에서 기본 조회 기간을 찾지 못했습니다" };
  const [, y1, m1, d1, y2, m2, d2] = dm;
  const fmts = (y, m, d) => [`${y}${m}${d}`, `${y}-${m}-${d}`, `${y}/${m}/${d}`];
  const [fy, fmo, fd] = from.split("-"), [ty, tmo, td] = to.split("-");
  let body = listReq.body, how = [];
  const swap = (olds, news) => { olds.forEach((o, i) => { if (body.includes(o)) { body = body.split(o).join(news[i]); how.push(`${o}→${news[i]}`); } }); };
  swap(fmts(y1, m1, d1), fmts(fy, fmo, fd));
  swap(fmts(y2, m2, d2), fmts(ty, tmo, td));
  if (!how.length) return { error: "요청 본문에서 기간 날짜를 찾지 못했습니다", how: "" };
  // 한 쪽에 많이 받기 — 쪽 크기처럼 보이는 값을 크게
  const sizeRe = /("(?:PAGE_?SIZE|PageSize|pageSize|ROW_?COUNT|RowCount|rowCount|PAGE_ROW_CNT|LIMIT_?CNT)"\s*:\s*)(\d+)/g;
  if (sizeRe.test(body)) { body = body.replace(sizeRe, (_, k) => `${k}1000`); how.push("쪽 크기 1000"); }
  const pageRe = /("(?:PAGE_?CURRENT|PAGE_?NO|PageNo|pageNo|PAGE_?INDEX|PageIndex|pageIndex|CURRENT_?PAGE|CurrentPage)"\s*:\s*)(\d+)/;
  const rows = []; let total = null, outside = 0, keys = "";
  for (let pg = 1; pg <= 40; pg++) {
    const b = pageRe.test(body) ? body.replace(pageRe, (_, k) => `${k}${pg}`) : body;
    const txt = await page.evaluate(async ({ url, headers, b }) => { const r = await fetch(url, { method: "POST", headers, body: b, credentials: "include" }); return `${r.status}\n` + await r.text(); }, { url: listReq.url, headers: listReq.headers, b });
    const st = txt.slice(0, txt.indexOf("\n")); let raw = txt.slice(txt.indexOf("\n") + 1);
    if (/^[A-Za-z0-9+/=\s]{40,}$/.test(raw.slice(0, 200))) { try { raw = Buffer.from(raw, "base64").toString("utf8"); } catch {} }
    let j; try { j = JSON.parse(raw); } catch { return { error: `목록 응답을 읽지 못했습니다 (${st}): ${raw.slice(0, 200)}`, how: how.join(", ") }; }
    const D = j && j.Data; const list = (D && Array.isArray(D.Data)) ? D.Data : [];
    if (D && D.TotalCount != null) total = Number(D.TotalCount);
    if (pg === 1 && list[0]) keys = Object.keys(list[0]).join(", ").slice(0, 600);
    for (const x of list) {
      const dn = String(x["SELL.IO_DATE_NO"] || x.IO_DATE_NO || "");
      const m = dn.match(/(\d{4})[\/.-](\d{2})[\/.-](\d{2})\s*-?\s*(\d*)/); if (!m) continue;
      const d = `${m[1]}-${m[2]}-${m[3]}`;
      if (d < from || d > to) { outside++; continue; }
      rows.push({ d, no: m[4] || "", c: String(x["SELL.CUST_DES"] || x.CUST_DES || ""), name: String(x["SELL.PROD_DES"] || x.PROD_DES || "판매"), total: Number(x["SELL.TOT_AMT"] ?? x.TOT_AMT ?? 0) || 0, slip: true });
    }
    if (!list.length || !pageRe.test(body) || (total != null && rows.length + outside >= total)) break;
  }
  return { rows, total, outside, keys, how: how.join(", ") };
}

try {
  if (!COM || !ID || !PW) { out.error = GH ? "GitHub 저장소 Secrets 에 이카운트 회사코드·아이디·비밀번호(ECOUNT_COM_CODE · ECOUNT_WEB_ID · ECOUNT_WEB_PW)가 없습니다" : "맥 키체인에 이카운트 회사코드·아이디·비밀번호가 없습니다 — 판매 로봇 설치를 다시 실행하세요"; await finish(); }
  if (!existsSync(CHROME)) { out.error = `Chrome 을 찾지 못했습니다: ${CHROME}`; await finish(); }
  const prof = join(DIR, "web-profile"); mkdirSync(prof, { recursive: true });
  const ctx = await chromium.launchPersistentContext(prof, { executablePath: CHROME, headless: true, viewport: { width: 1440, height: 900 }, locale: "ko-KR", timezoneId: "Asia/Seoul", acceptDownloads: true, args: ["--disable-blink-features=AutomationControlled", ...(GH ? ["--no-sandbox"] : [])] });
  browser = ctx;
  page = ctx.pages()[0] || await ctx.newPage();
  ctx.on("page", (p) => { steps.push({ name: "새 창 열림", url: p.url() }); });
  // 판매조회 목록 요청(GetListXFormSlipCommon)을 붙잡아 둔다 — 같은 요청을 기간만 바꿔 다시 보내려고
  page.on("request", (q) => {
    try { if (/GetListXFormSlipCommon/i.test(q.url()) && q.method() === "POST" && !listReq) {
      const h = {}; for (const [k, v] of Object.entries(q.headers())) if (!/^(cookie|host|content-length|origin|referer|user-agent|accept-encoding|connection|sec-)/i.test(k)) h[k] = v;
      listReq = { url: q.url(), headers: h, body: q.postData() || "" };
    } } catch {}
  });
  page.on("dialog", async (d) => { dialogs.push(`[${d.type()}] ${d.message()}`); try { await d.dismiss(); } catch {} });
  // 이카운트 화면이 주고받는 자료(JSON) 기록 — 판매조회 자료가 어떤 모양으로 오는지 보려고
  page.on("response", async (r) => {
    try {
      const rt = r.request().resourceType(); if (!["xhr", "fetch", "document"].includes(rt)) return;
      const u = r.url(); let host = ""; try { host = new URL(u).hostname; } catch {}
      if (!/(^|\.)ecount\.com$/.test(host) || /resource(v3)?\.ecount\.com/.test(host) || net.length >= 80) return;
      const ct = r.headers()["content-type"] || "";
      let body = ""; if (/json|text\/plain|keypack/.test(ct) && rt !== "document") { body = await r.text(); }
      // 이카운트는 응답을 base64 로 감싸 보내는 경우가 많다 — 풀어서 기록
      if (/^[A-Za-z0-9+/=\s]{40,}$/.test(body.slice(0, 200))) { try { const t = Buffer.from(body, "base64").toString("utf8"); if (/^[\[{]/.test(t.trim())) body = t; } catch {} }
      if (/passwd|password|PWD/i.test(body)) body = "(비밀번호 관련 응답 — 기록 안 함)";
      const key = (phase >= 4 && /Sale|ESD|ESQ|Slip|Search|GetList/i.test(u)) || /second_auth/i.test(u);
      net.push({ url: u, status: r.status(), type: `${rt} ${ct.split(";")[0]}`, body: body.slice(0, key ? 6000 : 500), key, phase });
    } catch {}
  });

  // ── 1. 로그인 ──
  // 정해 둔 시간만큼 쉬지 않고, 다음 화면에 필요한 것이 보이는 즉시 넘어간다 (예전엔 쉬는 시간만 1분 가까이 됐다)
  const until = async (fn, ms, step = 300) => { const t = Date.now(); for (;;) { let v = null; try { v = await fn(); } catch {} if (v) return v; if (Date.now() - t > ms) return null; await sleep(step); } };
  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 45000 });
  await until(() => findVisible(["input[type=password]"]), 15000);
  await snap("1 로그인 화면");
  const pw = await findVisible(["input[type=password]"]);
  if (pw) {
    const com = await findVisible(["#com_code", "input[name=com_code]", "input[name=COM_CODE]", "input[placeholder*='회사코드']", "input[title*='회사코드']"]);
    const id = await findVisible(["#id", "input[name=id]", "input[name=USER_ID]", "input[placeholder*='아이디']", "input[placeholder*='ID']", "input[title*='아이디']"]);
    if (!com || !id) await fail("로그인 화면에서 회사코드·아이디 칸을 찾지 못했습니다 (화면 사진을 보고 맞춰야 함)");
    await com.fill(COM); await id.fill(ID); await pw.fill(PW);
    const btn = await findVisible(["#save", "button:has-text('로그인')", "input[type=submit]", "a:has-text('로그인')", "[role=button]:has-text('로그인')"]);
    if (btn) await btn.click(); else await pw.press("Enter");
    // 로그인 결과를 기다린다 — 비밀번호 칸이 사라지면 성공, 「추가 보안 인증」 창이 뜨면 새 기기·새 위치 확인 (늦게 뜨기도 해서 20초까지 본다)
    const bodyText = async () => { let t = ""; for (const f of page.frames()) { try { t += "\n" + (await f.evaluate(() => (document.body ? document.body.innerText : ""))); } catch {} } return t; };
    let extra = false;
    for (let i = 0; i < 50; i++) { await sleep(400); if (/추가\s*보안\s*인증/.test(await bodyText())) { extra = true; break; } if (i >= 3 && !(await findVisible(["input[type=password]"]))) break; }
    await snap("2 로그인 뒤", dialogs.length ? `확인창: ${dialogs.join(" / ")}` : "");
    // 「추가 보안 인증」(처음 보는 기기·위치) — 문자(SMS) 인증을 골라 놓고, 대표님이 회사 앱에 인증번호를 넣어 주면 이어서 진행한다.
    // 인증번호는 대표님만 받는다 — 로봇은 넣어 준 번호를 그대로 한 번 입력할 뿐이고, 기록에 남기지 않는다.
    if (extra) {
      await until(async () => (await page.locator(".auth-method").count()) > 0, 15000);
      await snap("2-1 추가 보안 인증", "", true);
      // 인증 화면 구조 기록 — 인증번호 칸(또는 「인증」 글자)을 감싼 상자를 찾아 적어 둔다 (넣은 값은 빼고)
      const struct = async (name) => { try { const html = await page.evaluate(() => {
        const ins = [...document.querySelectorAll("input")].filter((e) => e.id !== "com_code" && e.id !== "id" && !["checkbox", "radio", "hidden", "password"].includes(e.type) && e.getBoundingClientRect().width > 0);
        let e = ins[0] || [...document.querySelectorAll(".wrapper-page-inform")].pop() || null;
        for (let k = 0; e && k < 7 && e.parentElement && !/인증/.test(e.innerText || ""); k++) e = e.parentElement;
        for (let k = 0; e && k < 2 && e.parentElement && (e.parentElement.innerText || "").length < 600; k++) e = e.parentElement;
        if (!e) return "";
        const c = e.cloneNode(true); c.querySelectorAll("script,style,svg,path").forEach((x) => x.remove());
        return c.outerHTML.replace(/\s+/g, " ").replace(/ (style|value|data-[\w-]+|aria-[\w-]+)="[^"]*"/g, "").slice(0, 3900); }); steps.push({ name, text: html }); } catch (e) { steps.push({ name, note: `읽기 실패: ${e.message}` }); } };
      const hint = ((await bodyText()).match(/01\d\*{2,}\d{2,4}/) || [""])[0];
      const sms = page.locator(".auth-method", { has: page.locator(".auth-method-title", { hasText: /^\s*SMS\s*$/ }) }).first();
      if (!(await sms.count())) { out.error = "추가 보안 인증 창에서 문자(SMS) 인증을 찾지 못했습니다"; await finish(); }
      // 인증번호 칸 — 이카운트는 숫자 한 칸씩 6칸(이름 없는 글자 칸)을 띄운다. 로그인 칸(회사코드·아이디)은 뺀다.
      const codeInputs = async () => { const loc = page.locator("input"); const list = []; const n = await loc.count();
        for (let k = 0; k < n; k++) { const el = loc.nth(k); try { const a = await el.evaluate((e) => ({ id: e.id, type: e.type })); if (a.id === "com_code" || a.id === "id" || ["checkbox", "radio", "hidden", "password"].includes(a.type)) continue; if (await el.isVisible()) list.push(el); } catch {} }
        return list; };
      await sms.click();
      await until(async () => (await codeInputs()).length > 0, 12000);
      await snap("2-4 문자 인증 고른 뒤");
      if (!(await codeInputs()).length) { await struct("2-5 문자 인증 화면 구조"); out.error = "문자 인증을 골랐지만 인증번호 넣는 칸을 찾지 못했습니다 (화면 구조 기록을 보고 맞춰야 함)"; await finish(); }
      let passed = false, why = "";
      for (let attempt = 0; attempt < 2 && !passed; attempt++) {
        const need = await api("/api/ecount/websales/auth", { hint, error: attempt ? "인증번호가 맞지 않았어요 — 다시 넣어 주세요" : "" });
        if (need && need.cancelled) { why = "요청이 취소됐습니다"; break; }
        say("문자 인증번호를 기다리는 중");
        let code = "";
        for (let k = 0; k < 176 && !code && !why; k++) { await sleep(1500); const r = await api("/api/ecount/websales/auth"); if (r && r.code) code = String(r.code); else if (r && r.cancelled) why = "요청이 취소됐습니다"; }   // 이카운트 유효시간 5분 — 4분 30초까지 기다린다
        if (why) break;
        if (!code) { why = "시간 안에 인증번호가 들어오지 않았습니다"; break; }
        const ins = await codeInputs();
        if (!ins.length) { why = "인증번호 칸이 사라졌습니다"; break; }
        if (ins.length >= code.length && ins.length > 1) {          // 한 칸에 한 숫자
          for (let k = 0; k < code.length; k++) { await ins[k].click().catch(() => {}); await ins[k].fill("").catch(() => {}); await page.keyboard.type(code[k], { delay: 40 }); await sleep(60); }
        } else { await ins[0].click().catch(() => {}); await ins[0].fill("").catch(() => {}); await page.keyboard.type(code, { delay: 90 }); }
        code = "";
        await sleep(300);
        const okBtn = (await findVisible(["button:has-text('인증번호확인')", "a:has-text('인증번호확인')", "[role=button]:has-text('인증번호확인')", "button:has-text('인증번호 확인')", "a:has-text('인증번호 확인')"]))
          || (await findVisible(["button:has-text('인증 완료')", "button:has-text('확인')"]));
        if (okBtn) await okBtn.click().catch(() => {}); else await page.keyboard.press("Enter");
        for (let k = 0; k < 40; k++) { await sleep(400); if (!(await findVisible(["input[type=password]"]))) { passed = true; break; } }
        await snap(`2-8 인증번호 넣은 뒤 (${attempt + 1}번째)`, "", !passed);
        if (!passed) await struct("2-9 인증번호 넣은 뒤 화면 구조");
      }
      if (!passed) { out.error = `문자 인증을 마치지 못했습니다 — ${why || "인증번호를 넣었지만 로그인으로 넘어가지 않았습니다"}`; await finish(); }
      say("문자 인증 통과");
    }
    if (await findVisible(["input[type=password]"])) await fail(`로그인이 안 됐습니다${dialogs.length ? ` — ${dialogs.join(" / ")}` : " — 화면 사진의 안내 문구를 확인해 주세요"}`);
  } else await snap("2 이미 로그인돼 있음", "", false);

  // ── 2. 판매조회 찾아가기 (정찰) — 첫 화면 「이카운트 시작하기」의 「판매조회」 글자를 누른다 ──
  const closeAlert = async () => { const ok = await findVisible(["button:has-text('확인')", "a:has-text('확인')"]); if (ok) await ok.click().catch(() => {}); };
  phase = 3;
  // 로그인 직후에는 첫 화면이 아직 그려지는 중일 수 있다(특히 문자 인증을 막 통과했을 때) — 「판매조회」 글자가 보일 때까지 40초까지 기다린다
  let link = null;
  for (let t = 0; t < 100 && !link; t++) {
    for (const f of page.frames()) { try { const l = f.getByText("판매조회", { exact: true }); const n = await l.count(); for (let i = 0; i < n && !link; i++) if (await l.nth(i).isVisible()) link = l.nth(i); } catch {} if (link) break; }
    if (!link) await sleep(400);
  }
  await snap("3 첫 화면", link ? "" : "「판매조회」 글자가 안 보임");
  if (!link) {   // 안 보이면 메뉴 검색 → 뜨는 목록에서 고르기
    const search = await findVisible(["#inputFavMSearch", "input[placeholder*='메뉴']"]);
    if (search) { await search.click().catch(() => {}); await search.type("판매조회", { delay: 120 }); await sleep(2500); await snap("3 메뉴 검색 목록");
      link = await findVisible(["li:has-text('판매조회')", "a:has-text('판매조회')", "[role=option]:has-text('판매조회')"]); }
  }
  if (!link) await fail("판매조회로 가는 글자·메뉴를 찾지 못했습니다");
  await link.scrollIntoViewIfNeeded().catch(() => {});
  phase = 4;
  await link.click();
  // 판매조회 화면은 열리면서 기본 기간 목록을 스스로 한 번 불러온다 — 그 요청이 잡히는 즉시 다음으로 (예전엔 7초씩 두 번 쉬고 검색도 한 번 더 눌렀다)
  await until(() => listReq, 25000, 250);
  await sleep(400);
  await snap("4 판매조회 화면");
  phase = 5;
  if (!listReq) {   // 스스로 안 불러오면 조회(검색) 단추를 눌러 본다 (읽기만)
    const search2 = await findVisible(["button:has-text('검색(F8)')", "button:has-text('검색')", "a:has-text('검색(F8)')", "button:has-text('조회')", "#search", "[data-cid='search']"]);
    if (search2) await search2.click().catch(() => {}); else await page.keyboard.press("F8").catch(() => {});
    await until(() => listReq, 20000, 250);
    await snap("5 판매조회 검색 뒤", search2 ? "" : "검색 단추를 못 찾아 F8 을 눌러 봄");
  }
  await closeAlert();

  // ── 3. 기간을 바꿔 판매 목록 받기 ──
  phase = 6;
  if (!listReq) await fail("판매조회 목록 요청을 붙잡지 못했습니다");
  const tmplText = (steps.find((s) => /판매조회 화면/.test(s.name)) || {}).text || "";
  const dm = listReq.body.match(/"BASE_DATE_FROM"\s*:\s*"(\d{4})(\d{2})(\d{2})"[\s\S]*?"BASE_DATE_TO"\s*:\s*"(\d{4})(\d{2})(\d{2})"/)   // 요청 본문의 기본 기간 (화면 글자를 기다리지 않아도 됨)
    || tmplText.match(/(\d{4})\/(\d{2})\/(\d{2})\s*~\s*(\d{4})\/(\d{2})\/(\d{2})/);
  steps.push({ name: "6 목록 요청 내용", url: listReq.url, text: `기본 기간: ${dm ? `${dm[1]}/${dm[2]}/${dm[3]} ~ ${dm[4]}/${dm[5]}/${dm[6]}` : "못 찾음"}\n머리글: ${JSON.stringify(listReq.headers).slice(0, 600)}\n본문:\n${listReq.body.slice(0, 3200)}` });
  const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  const want = { from: /^\d{4}-\d{2}-\d{2}$/.test(job.from) ? job.from : new Date(Date.now() + 9 * 3600e3 - 6 * 864e5).toISOString().slice(0, 10), to: /^\d{4}-\d{2}-\d{2}$/.test(job.to) ? job.to : today };
  const res = await fetchRange(want.from, want.to, dm);
  steps.push({ name: "7 기간 바꿔 받기", note: res.error || "", text: `요청 기간 ${want.from} ~ ${want.to}\n바꾼 곳: ${res.how || "-"}\n전체 건수(이카운트): ${res.total ?? "?"} · 받은 줄: ${res.rows ? res.rows.length : 0} · 합계: ${res.rows ? res.rows.reduce((t, r) => t + r.total, 0) : 0}\n기간 밖 줄: ${res.outside || 0}\n처음 3줄: ${JSON.stringify((res.rows || []).slice(0, 3))}\n마지막 3줄: ${JSON.stringify((res.rows || []).slice(-3))}\n원본 첫 줄 열 이름: ${res.keys || ""}` });
  if (res.error) await fail(res.error);
  if (job.mode === "import") {
    if (res.total != null && res.rows.length < res.total) await fail(`이카운트는 ${res.total}건이라는데 ${res.rows.length}건만 받았습니다 — 반영하지 않았습니다`);
    if (res.outside) await fail(`요청 기간 밖 날짜가 ${res.outside}줄 섞여 왔습니다 — 기간 바꾸기가 안 먹은 것 같아 반영하지 않았습니다`);
    out.rows = res.rows; out.from = want.from; out.to = want.to; out.fileName = `${GH ? "문자 인증 로봇" : "맥 로봇"} 판매조회 ${today}`;
  }
  out.ok = true;
  await finish();
} catch (e) {
  await fail(`실행 중 오류: ${e.message}`);
}
