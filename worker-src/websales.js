// ── 이카운트 웹 판매조회 로봇 (맥 · GitHub Actions) ──
//
// 맥이 꺼져 있어도 되게, 요청이 걸리면 GitHub Actions(.github/workflows/ecount-sales.yml)도 같이 깨운다.
//  - 깨우기: env.GITHUB_ACTIONS_TOKEN (이 저장소의 Actions 쓰기 권한만 있는 토큰, Cloudflare Secret)
//  - GitHub 쪽 로봇의 인증: GitHub 가 발급하는 실행 증명(OIDC) — 이 저장소 main 의 그 워크플로만 받아 준다
//  - 맥과 GitHub 중 먼저 가져간 쪽이 처리하고, 다른 쪽은 「이미 처리 중」을 보고 그냥 끝낸다
//
// 이카운트 공개 API 에는 판매 「조회」가 없다. 그래서 사무실 맥이 이카운트 웹에 로그인해(헤드리스 Chrome)
// 판매조회 화면을 읽어 회사 앱 「판매 현황」에 넣는다. 이 파일은 서버 쪽 — 요청 걸기·맥이 가져가기·결과 받기.
//  - 회사코드·아이디·비밀번호는 맥의 키체인에만 있다. 서버에는 오지 않는다.
//  - 맥 인증은 재고 중계와 같은 X-Relay-Key(이카운트 API 인증키의 SHA-256)를 쓴다.
//  - 단계: probe(정찰 — 로그인·메뉴 화면을 찍어 올림) / import(판매조회를 읽어 판매 현황에 반영)
//
//   /frw_websales_req   = { mode, from, to, at, by, claim:{dev,ts} }   — 걸린 요청 (하나만)
//   /frw_websales_log   = { at, mode, from, to, ok, error, steps:[…], net:[…], result }   — 마지막 실행 기록 (화면 사진 빼고)
//   /frw_websales_shots = [ { name, data(base64 jpeg) } ]                — 마지막 실행 화면 사진
//   /frw_websales_seen  = 맥이 마지막으로 요청을 확인한 시각(ms)
import { salesImport } from "./sales.js";

const FB_HOST = "njsafety-2ee24-default-rtdb.asia-southeast1.firebasedatabase.app";
const REQ = "/frw_websales_req", LOG = "/frw_websales_log", SHOTS = "/frw_websales_shots", SEEN = "/frw_websales_seen";
const GH_REPO = "bangbongfather-sys/fr-workwear-app", GH_WORKFLOW = "ecount-sales.yml", GH_ISS = "https://token.actions.githubusercontent.com", GH_AUD = "nj-websales";
const CLAIM_TTL = 12 * 60e3;   // 맥이 가져간 뒤 12분 안에 결과가 없으면 다시 가져갈 수 있게
const REQ_TTL = 6 * 3600e3;    // 6시간 넘게 아무도 안 가져간 요청은 버린다 (맥이 꺼져 있던 경우)

const fbUrl = (env, p) => `https://${FB_HOST}${p}.json?auth=${encodeURIComponent(env.FIREBASE_DB_SECRET)}`;
async function fbGet(env, p) { const r = await fetch(fbUrl(env, p)); return r.ok ? r.json() : null; }
async function fbPut(env, p, v) { const r = await fetch(fbUrl(env, p), { method: "PUT", body: JSON.stringify(v) }); if (!r.ok) throw new Error(`Firebase ${r.status}`); }
const kstAt = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 16).replace("T", " ");
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const clip = (s, n) => String(s == null ? "" : s).slice(0, n);

// GitHub Actions 실행 증명(OIDC 토큰) 검사 — 서명(GitHub 공개 키) · 저장소 · main 가지 · 워크플로 파일 · 유효 시간
let _jwks = null, _jwksAt = 0;
const b64u = (t) => Uint8Array.from(atob(String(t).replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(String(t).length / 4) * 4, "=")), (c) => c.charCodeAt(0));
export async function websalesGhAuth(env, token) {
  try {
    const [h, p, sg] = String(token || "").split("."); if (!h || !p || !sg) return false;
    const head = JSON.parse(new TextDecoder().decode(b64u(h))), pl = JSON.parse(new TextDecoder().decode(b64u(p)));
    const repo = (env && env.GITHUB_REPO) || GH_REPO, now = Date.now() / 1000;
    if (head.alg !== "RS256" || pl.iss !== GH_ISS || pl.aud !== GH_AUD || pl.repository !== repo || pl.ref !== "refs/heads/main") return false;
    if (!String(pl.job_workflow_ref || "").startsWith(`${repo}/.github/workflows/${GH_WORKFLOW}@refs/heads/main`)) return false;
    if (!(Number(pl.exp) > now - 30) || (pl.nbf && Number(pl.nbf) > now + 60)) return false;
    const load = async () => { const r = await fetch(`${GH_ISS}/.well-known/jwks`); if (!r.ok) return false; _jwks = (await r.json()).keys || []; _jwksAt = Date.now(); return true; };
    if (!_jwks || Date.now() - _jwksAt > 3600e3) { if (!(await load())) return false; }
    let jwk = _jwks.find((k) => k.kid === head.kid);
    if (!jwk) { if (!(await load())) return false; jwk = _jwks.find((k) => k.kid === head.kid); }
    if (!jwk || jwk.kty !== "RSA") return false;
    const key = await crypto.subtle.importKey("jwk", { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    return await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64u(sg), new TextEncoder().encode(`${h}.${p}`));
  } catch { return false; }
}
// GitHub Actions 로봇 깨우기 (workflow_dispatch). 토큰이 없으면 아무것도 안 한다(맥만 쓴다).
// ※ 이카운트는 GitHub 서버(해외·처음 보는 위치)의 로그인에 매번 「추가 보안 인증」(문자 본인 인증)을 요구한다.
//   그래서 GitHub 로봇은 문자 인증을 고른 뒤 멈춰서 기다리고, 대표님이 앱에 인증번호를 넣으면 이어서 진행한다(아래 websalesAuth*).
//   맥은 평소 쓰던 인터넷이라 인증 없이 되므로, 맥이 켜져 있으면 맥에 먼저 맡긴다. 끄려면 Cloudflare 변수 WEBSALES_GH = "off".
const ghOn = (env) => !!env.GITHUB_ACTIONS_TOKEN && env.WEBSALES_GH !== "off";
const MAC_LIVE = 150e3;      // 맥은 1분마다 묻는다 — 2분 30초 안에 물었으면 켜져 있는 것으로 본다
const GH_FALLBACK = 100e3;   // 맥에 맡겼는데 이만큼 지나도 안 가져가면 GitHub 로봇을 깨운다
async function ghWake(env) {
  if (!ghOn(env)) return null;
  try {
    const r = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO || GH_REPO}/actions/workflows/${GH_WORKFLOW}/dispatches`, { method: "POST",
      headers: { Authorization: `Bearer ${env.GITHUB_ACTIONS_TOKEN}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "nj-websales", "Content-Type": "application/json" },
      body: JSON.stringify({ ref: "main", inputs: { mode: "check" } }) });
    if (r.status === 204) return { ok: true, ts: Date.now() };
    const why = r.status === 401 ? "토큰이 만료됐거나 틀렸어요" : r.status === 403 ? "토큰에 Actions 쓰기 권한이 없어요" : r.status === 404 ? "토큰이 이 저장소를 못 보거나 워크플로 파일이 없어요" : `GitHub 응답 ${r.status}`;
    return { ok: false, ts: Date.now(), error: why };
  } catch (e) { return { ok: false, ts: Date.now(), error: clip(e && e.message, 120) }; }
}

// 요청 걸기 — mode "probe" | "import", from·to (import 일 때 필수)
export async function websalesRequest(env, { mode = "probe", from = "", to = "", by = "app", only = "" } = {}) {
  if (!["probe", "import"].includes(mode)) return { ok: false, error: "mode 는 probe 또는 import 입니다" };
  if (mode === "import" && (!DAY.test(from) || !DAY.test(to) || from > to)) return { ok: false, error: "가져올 기간(from·to, YYYY-MM-DD)이 필요합니다" };
  const cur = await fbGet(env, REQ).catch(() => null);
  if (cur && cur.atMs && Date.now() - cur.atMs < REQ_TTL) {
    // 아직 아무도 안 가져갔고, GitHub 를 못 깨웠거나 깨운 지 10분이 넘었으면 한 번 더 깨운다
    const taken = cur.claim && Date.now() - Number(cur.claim.ts) < CLAIM_TTL;
    if (!taken && cur.only !== "mac" && (!cur.gh || !cur.gh.ok || Date.now() - Number(cur.gh.ts) > 10 * 60e3)) { const gh = await ghWake(env); if (gh) await fbPut(env, REQ, { ...cur, gh }).catch(() => {}); }
    return { ok: true, already: true, message: "이미 걸린 요청이 있어요 — 맥이 처리 중이거나 곧 가져갑니다", req: { mode: cur.mode, from: cur.from, to: cur.to, at: cur.at, atMs: cur.atMs } };
  }
  const req = { mode, from: DAY.test(from) ? from : "", to: DAY.test(to) ? to : "", at: kstAt(), atMs: Date.now(), by: clip(by, 30) };
  if (only === "github" || only === "mac") req.only = only;   // 점검용 — 한쪽 로봇만 가져가게
  await fbPut(env, REQ, req);
  const seen = Number(await fbGet(env, SEEN).catch(() => 0)) || 0;
  const alive = seen && Date.now() - seen < 5 * 60e3;
  // 맥이 방금까지 묻고 있었으면 맥에 먼저 맡긴다(인증 문자 없이 됨). 아니면 GitHub 로봇을 바로 깨운다.
  const macFirst = only !== "github" && seen && Date.now() - seen < MAC_LIVE;
  const gh = only === "mac" || macFirst ? null : await ghWake(env);
  if (gh) { req.gh = gh; await fbPut(env, REQ, req).catch(() => {}); }
  if (gh && gh.ok) return { ok: true, queued: true, req, robot: "GitHub 로봇을 깨웠어요 — 1분쯤 뒤 시작" };
  return { ok: true, queued: true, req, gh: gh ? gh.error : undefined, mac: alive ? "켜져 있음 — 1분 안에 시작" : (seen ? `마지막 확인 ${Math.round((Date.now() - seen) / 60e3)}분 전 — 맥이 꺼져 있거나 설치 전일 수 있어요` : "아직 맥이 한 번도 확인하지 않았어요 — 설치가 필요합니다") };
}
export async function websalesCancel(env) { await fbPut(env, REQ, null); return { ok: true, cancelled: true }; }

// 맥이 1분마다 묻는다 — 걸린 요청이 있으면 가져간다(claim)
export async function websalesPending(env, dev = "") {
  if (dev === "setup") return { pending: false, setup: true };   // 설치 때 인증키만 확인 — 요청을 가져가지 않는다
  if (dev !== "github") { try { await fbPut(env, SEEN, Date.now()); } catch {} }   // 「맥이 켜져 있나」는 맥이 물을 때만 갱신
  const req = await fbGet(env, REQ).catch(() => null);
  if (!req || !req.atMs) return { pending: false };
  if (Date.now() - req.atMs > REQ_TTL) { await fbPut(env, REQ, null).catch(() => {}); return { pending: false, expired: true }; }
  if (req.claim && Date.now() - Number(req.claim.ts) < CLAIM_TTL) return { pending: false, busy: true };
  if (req.only && (req.only === "github") !== (dev === "github")) return { pending: false };
  await fbPut(env, REQ, { ...req, claim: { dev: clip(dev, 20), ts: Date.now() } });
  return { pending: true, mode: req.mode, from: req.from, to: req.to, at: req.at };
}

// 맥이 결과를 보낸다 — 실행 기록·화면 사진 저장, import 면 판매 현황에 반영
export async function websalesPush(env, b = {}, dev = "") {
  const at = kstAt();
  const steps = (Array.isArray(b.steps) ? b.steps : []).slice(0, 20).map((s) => ({
    name: clip(s && s.name, 60), url: clip(s && s.url, 300), title: clip(s && s.title, 120), text: clip(s && s.text, 4000),
    inputs: (Array.isArray(s && s.inputs) ? s.inputs : []).slice(0, 40), buttons: (Array.isArray(s && s.buttons) ? s.buttons : []).slice(0, 60).map((x) => clip(x, 60)),
    frames: (Array.isArray(s && s.frames) ? s.frames : []).slice(0, 10).map((x) => clip(x, 200)), note: clip(s && s.note, 500),
  }));
  const net = (Array.isArray(b.net) ? b.net : []).slice(0, 80).map((x) => ({ url: clip(x && x.url, 300), status: x && x.status, type: clip(x && x.type, 60), phase: x && x.phase, key: !!(x && x.key), body: clip(x && x.body, x && x.key ? 6000 : 500) }));
  let result = null;
  if (b.mode === "import" && Array.isArray(b.rows) && b.rows.length && DAY.test(b.from || "") && DAY.test(b.to || "")) {
    result = await salesImport(env, { fileName: clip(b.fileName || `맥 로봇 판매조회 ${at}`, 100), from: b.from, to: b.to, rows: b.rows }).catch((e) => ({ ok: false, error: e.message }));
  }
  const cur = await fbGet(env, REQ).catch(() => null);   // 어느 요청의 결과인지 남긴다 (앱이 「내가 건 요청이 끝났나」를 안다)
  const log = { at, atMs: Date.now(), reqAtMs: Number(cur && cur.atMs) || 0, dev: clip(dev, 20), mode: clip(b.mode, 10), from: clip(b.from, 10), to: clip(b.to, 10), ok: !!b.ok && (!result || result.ok !== false),
    error: clip(b.error, 600), dialogs: (Array.isArray(b.dialogs) ? b.dialogs : []).slice(0, 10).map((x) => clip(x, 300)), steps, net,
    rows: Array.isArray(b.rows) ? b.rows.length : 0, result, version: clip(b.version, 30), took: Number(b.took) || 0 };
  await fbPut(env, LOG, log);
  const shots = (Array.isArray(b.shots) ? b.shots : []).slice(0, 10).filter((x) => x && typeof x.data === "string" && x.data.length < 900000).map((x) => ({ name: clip(x.name, 60), data: x.data }));
  await fbPut(env, SHOTS, shots.length ? shots : null).catch(() => {});
  await fbPut(env, REQ, null).catch(() => {});
  return { ok: true, saved: true, result };
}

// 상태 읽기 (앱·커넥터) — 사진은 빼고
export async function websalesStatus(env) {
  const [req, log, seen, shots] = await Promise.all([fbGet(env, REQ).catch(() => null), fbGet(env, LOG).catch(() => null), fbGet(env, SEEN).catch(() => null), fbGet(env, SHOTS).catch(() => null)]);
  const s = Number(seen) || 0;
  return { 맥: s ? { 마지막확인: new Date(s + 9 * 3600e3).toISOString().slice(0, 16).replace("T", " "), 켜짐: Date.now() - s < 5 * 60e3 } : "아직 설치 전",
    걸린요청: req ? { mode: req.mode, from: req.from, to: req.to, at: req.at, 가져감: !!req.claim } : null,
    마지막실행: log, 사진: Array.isArray(shots) ? shots.map((x, i) => `${i}: ${x && x.name}`) : [] };
}
// ── 추가 보안 인증(문자) — 로봇이 「인증번호가 필요해요」를 알리고, 앱에서 넣은 번호를 받아 간다 ──
//   REQ.auth = { state: "need" | "given", hint: "010****3079", at, error, code }   (code 는 로봇이 받아 가는 즉시 지운다)
const AUTH_TTL = 5 * 60e3;
export async function websalesAuthNeed(env, b = {}) {          // 로봇 → 서버: 인증번호가 필요하다 (틀렸을 때 다시 부르면 error 와 함께)
  const req = await fbGet(env, REQ).catch(() => null);
  if (!req || !req.atMs) return { ok: false, cancelled: true };
  await fbPut(env, REQ, { ...req, claim: req.claim ? { ...req.claim, ts: Date.now() } : req.claim, auth: { state: "need", hint: clip(b.hint, 30), at: Date.now(), error: clip(b.error, 120) } });
  return { ok: true };
}
export async function websalesAuthTake(env) {                  // 로봇 → 서버: 넣은 번호가 있으면 받아 간다
  const req = await fbGet(env, REQ).catch(() => null);
  if (!req || !req.atMs) return { cancelled: true };
  const a = req.auth;
  if (!a || a.state !== "given" || !a.code) return { wait: true };
  await fbPut(env, REQ, { ...req, auth: { state: "taken", hint: a.hint || "", at: a.at } });
  return { code: String(a.code) };
}
export async function websalesAuthGive(env, code) {            // 앱 → 서버: 대표님이 넣은 인증번호
  const c = String(code || "").replace(/\D/g, "");
  if (c.length < 4 || c.length > 8) return { ok: false, error: "인증번호는 숫자 4~8자리예요" };
  const req = await fbGet(env, REQ).catch(() => null);
  if (!req || !req.atMs || !req.auth || req.auth.state !== "need") return { ok: false, error: "지금은 인증번호를 기다리고 있지 않아요" };
  if (Date.now() - Number(req.auth.at) > AUTH_TTL) return { ok: false, error: "시간이 지났어요 — 요청을 취소하고 다시 눌러 주세요" };
  await fbPut(env, REQ, { ...req, auth: { ...req.auth, state: "given", code: c, error: "" } });
  return { ok: true };
}

// 앱(판매 현황 화면)용 짧은 상태 — 맥이 켜져 있나 · 걸린 요청 · 마지막 실행 결과 (기록·사진 빼고)
export async function websalesBrief(env) {
  const [req, log, seen] = await Promise.all([fbGet(env, REQ).catch(() => null), fbGet(env, LOG).catch(() => null), fbGet(env, SEEN).catch(() => null)]);
  const s = Number(seen) || 0;
  let live = req && req.atMs && Date.now() - req.atMs < REQ_TTL ? req : null;
  // 맥에 맡겼는데 한참 안 가져가면(잠들었거나 꺼짐) GitHub 로봇을 깨운다
  if (live && !live.claim && !live.gh && live.only !== "mac" && Date.now() - live.atMs > GH_FALLBACK && ghOn(env)) {
    const gh = await ghWake(env); if (gh) { live = { ...live, gh }; await fbPut(env, REQ, live).catch(() => {}); }
  }
  const au = live && live.auth;
  const r = log && log.result;
  return { ok: true, now: Date.now(),
    mac: { seen: s, alive: !!s && Date.now() - s < 5 * 60e3, installed: !!s },
    gh: { on: ghOn(env) },
    req: live ? { mode: live.mode, from: live.from, to: live.to, at: live.at, atMs: live.atMs, claimed: !!(live.claim && Date.now() - Number(live.claim.ts) < CLAIM_TTL), by: (live.claim && live.claim.dev) || "",
      gh: live.gh ? { ok: !!live.gh.ok, error: live.gh.error || "" } : null,
      auth: au ? { state: au.state, hint: au.hint || "", at: Number(au.at) || 0, error: au.error || "" } : null } : null,
    last: log ? { at: log.at, atMs: Number(log.atMs) || 0, reqAtMs: Number(log.reqAtMs) || 0, mode: log.mode, from: log.from, to: log.to, ok: !!log.ok, error: clip(log.error || (r && r.ok === false && r.error) || "", 300),
      rows: Number(log.rows) || 0, count: r && r.count != null ? r.count : null, total: r && r.total != null ? r.total : null } : null };
}
export async function websalesShot(env, i) {
  const shots = await fbGet(env, SHOTS).catch(() => null);
  const x = Array.isArray(shots) ? shots[Number(i) || 0] : null;
  return x && x.data ? x : null;
}
