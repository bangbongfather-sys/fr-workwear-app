// NJ SAFETY — 이카운트 웹 판매조회 로봇 (사무실 맥에서 실행)
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
import { existsSync, mkdirSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";

const VERSION = "2026-11-17-probe1";
const APP = process.env.NJ_APP || "https://fr-workwear-app.njsafety91.workers.dev";
const DIR = process.env.NJ_DIR || join(homedir(), "Library/Application Support/nj-ecount");
const LOGIN_URL = process.env.NJ_LOGIN_URL || "https://login.ecount.com/Login/";
const CHROME = process.env.NJ_CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const DEV = "office-mac";

const kc = (s) => { if (process.env["NJ_KC_" + s]) return process.env["NJ_KC_" + s]; try { return execFileSync("security", ["find-generic-password", "-a", userInfo().username, "-s", s, "-w"], { encoding: "utf8" }).trim(); } catch { return ""; } };
const sha256 = async (t) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t)))].map((b) => b.toString(16).padStart(2, "0")).join("");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (...a) => console.log(new Date().toISOString().slice(0, 19).replace("T", " "), ...a);

const KEY = kc("nj-ecount-key");
const RELAY = process.env.NJ_RELAY || (KEY ? await sha256(KEY) : "");
const H = { "Content-Type": "application/json", "X-Relay-Key": RELAY, "X-Relay-Dev": DEV };
async function api(path, body) {
  const r = await fetch(APP + path, body ? { method: "POST", headers: H, body: JSON.stringify(body) } : { headers: H });
  const t = await r.text(); try { return JSON.parse(t); } catch { return { error: `응답 읽기 실패 ${r.status}: ${t.slice(0, 200)}` }; }
}

// ── 무엇을 할지 ──
const [cmd = "check", a1 = "", a2 = ""] = process.argv.slice(2);
let job;
if (cmd === "check") {
  if (!RELAY) process.exit(0);
  const p = await api("/api/ecount/websales/pending");
  if (!p || !p.pending) process.exit(0);
  job = { mode: p.mode || "probe", from: p.from || "", to: p.to || "" };
  say("요청 받음", JSON.stringify(job));
} else job = { mode: cmd === "import" ? "import" : "probe", from: a1, to: a2 };

const COM = kc("nj-ecount-com"), ID = kc("nj-ecount-web-id"), PW = kc("nj-ecount-web-pw");
const t0 = Date.now();
const steps = [], shots = [], net = [], dialogs = [];
let browser = null, page = null;
const out = { mode: job.mode, from: job.from, to: job.to, ok: false, error: "", version: VERSION };

async function finish() {
  out.steps = steps; out.shots = shots; out.net = net; out.dialogs = dialogs; out.took = Math.round((Date.now() - t0) / 1000);
  try { if (browser) await browser.close(); } catch {}
  const r = RELAY ? await api("/api/ecount/websales/push", out) : { error: "인증키 없음" };
  say(out.ok ? "끝" : `실패: ${out.error}`, "→ 회사 앱:", JSON.stringify(r).slice(0, 300));
  process.exit(out.ok ? 0 : 1);
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
      return { title: document.title, text: (document.body ? document.body.innerText : "").replace(/\n{2,}/g, "\n").slice(0, 2500), inputs, buttons };
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

try {
  if (!COM || !ID || !PW) { out.error = "맥 키체인에 이카운트 회사코드·아이디·비밀번호가 없습니다 — 판매 로봇 설치를 다시 실행하세요"; await finish(); }
  if (!existsSync(CHROME)) { out.error = `Chrome 을 찾지 못했습니다: ${CHROME}`; await finish(); }
  const prof = join(DIR, "web-profile"); mkdirSync(prof, { recursive: true });
  const ctx = await chromium.launchPersistentContext(prof, { executablePath: CHROME, headless: true, viewport: { width: 1440, height: 900 }, locale: "ko-KR", timezoneId: "Asia/Seoul", acceptDownloads: true, args: ["--disable-blink-features=AutomationControlled"] });
  browser = ctx;
  page = ctx.pages()[0] || await ctx.newPage();
  ctx.on("page", (p) => { steps.push({ name: "새 창 열림", url: p.url() }); });
  page.on("dialog", async (d) => { dialogs.push(`[${d.type()}] ${d.message()}`); try { await d.dismiss(); } catch {} });
  // 이카운트 화면이 주고받는 자료(JSON) 기록 — 판매조회 자료가 어떤 모양으로 오는지 보려고
  page.on("response", async (r) => {
    try {
      const rt = r.request().resourceType(); if (!["xhr", "fetch", "document"].includes(rt)) return;
      const u = r.url(); if (!/ecount/i.test(u) || net.length >= 80) return;
      const ct = r.headers()["content-type"] || "";
      let body = ""; if (/json|text\/plain|javascript/.test(ct) && rt !== "document") { body = (await r.text()).slice(0, 600); }
      if (/passwd|password|PWD/i.test(body)) body = "(비밀번호 관련 응답 — 기록 안 함)";
      net.push({ url: u, status: r.status(), type: `${rt} ${ct.split(";")[0]}`, body });
    } catch {}
  });

  // ── 1. 로그인 ──
  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
  await snap("1 로그인 화면");
  const pw = await findVisible(["input[type=password]"]);
  if (pw) {
    const com = await findVisible(["#com_code", "input[name=com_code]", "input[name=COM_CODE]", "input[placeholder*='회사코드']", "input[title*='회사코드']"]);
    const id = await findVisible(["#id", "input[name=id]", "input[name=USER_ID]", "input[placeholder*='아이디']", "input[placeholder*='ID']", "input[title*='아이디']"]);
    if (!com || !id) await fail("로그인 화면에서 회사코드·아이디 칸을 찾지 못했습니다 (화면 사진을 보고 맞춰야 함)");
    await com.fill(COM); await id.fill(ID); await pw.fill(PW);
    const btn = await findVisible(["#save", "button:has-text('로그인')", "input[type=submit]", "a:has-text('로그인')", "[role=button]:has-text('로그인')"]);
    if (btn) await btn.click(); else await pw.press("Enter");
    await page.waitForLoadState("domcontentloaded", { timeout: 30000 }).catch(() => {});
    await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
    await sleep(3000);
    await snap("2 로그인 뒤", dialogs.length ? `확인창: ${dialogs.join(" / ")}` : "");
    if (await findVisible(["input[type=password]"])) await fail(`로그인이 안 됐습니다${dialogs.length ? ` — ${dialogs.join(" / ")}` : " — 화면 사진의 안내 문구를 확인해 주세요"}`);
  } else await snap("2 이미 로그인돼 있음", "", false);

  // ── 2. 판매조회 메뉴 찾기 (정찰) ──
  const search = await findVisible(["input[placeholder*='메뉴']", "input[title*='메뉴']", "input[placeholder*='검색']", "#searchMenu", "input[id*='menu' i]"]);
  if (search) {
    await search.click().catch(() => {}); await search.fill("판매조회"); await sleep(2500);
    await snap("3 메뉴 검색에 「판매조회」");
    await search.press("Enter").catch(() => {}); await sleep(6000);
    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
    await snap("4 판매조회 열기 시도");
  } else {
    const link = await findVisible(["text=판매조회", "a:has-text('판매조회')"]);
    if (link) { await link.click().catch(() => {}); await sleep(6000); await snap("4 판매조회 열기 시도(메뉴 글자)"); }
    else await snap("3 메뉴 검색칸을 찾지 못함", "판매조회로 가는 길을 화면 사진을 보고 정해야 합니다");
  }
  if (job.mode === "import") out.error = "판매조회 읽기 단계는 아직 준비 중입니다 — 정찰 결과로 마무리할 예정";
  else out.ok = true;
  await finish();
} catch (e) {
  await fail(`실행 중 오류: ${e.message}`);
}
