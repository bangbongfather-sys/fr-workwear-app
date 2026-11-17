// ── 이카운트 웹 판매조회 로봇 (사무실 맥) ──
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
const CLAIM_TTL = 12 * 60e3;   // 맥이 가져간 뒤 12분 안에 결과가 없으면 다시 가져갈 수 있게
const REQ_TTL = 6 * 3600e3;    // 6시간 넘게 아무도 안 가져간 요청은 버린다 (맥이 꺼져 있던 경우)

const fbUrl = (env, p) => `https://${FB_HOST}${p}.json?auth=${encodeURIComponent(env.FIREBASE_DB_SECRET)}`;
async function fbGet(env, p) { const r = await fetch(fbUrl(env, p)); return r.ok ? r.json() : null; }
async function fbPut(env, p, v) { const r = await fetch(fbUrl(env, p), { method: "PUT", body: JSON.stringify(v) }); if (!r.ok) throw new Error(`Firebase ${r.status}`); }
const kstAt = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 16).replace("T", " ");
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const clip = (s, n) => String(s == null ? "" : s).slice(0, n);

// 요청 걸기 — mode "probe" | "import", from·to (import 일 때 필수)
export async function websalesRequest(env, { mode = "probe", from = "", to = "", by = "app" } = {}) {
  if (!["probe", "import"].includes(mode)) return { ok: false, error: "mode 는 probe 또는 import 입니다" };
  if (mode === "import" && (!DAY.test(from) || !DAY.test(to) || from > to)) return { ok: false, error: "가져올 기간(from·to, YYYY-MM-DD)이 필요합니다" };
  const cur = await fbGet(env, REQ).catch(() => null);
  if (cur && cur.atMs && Date.now() - cur.atMs < REQ_TTL) return { ok: true, already: true, message: "이미 걸린 요청이 있어요 — 맥이 처리 중이거나 곧 가져갑니다", req: { mode: cur.mode, from: cur.from, to: cur.to, at: cur.at } };
  const req = { mode, from: DAY.test(from) ? from : "", to: DAY.test(to) ? to : "", at: kstAt(), atMs: Date.now(), by: clip(by, 30) };
  await fbPut(env, REQ, req);
  const seen = Number(await fbGet(env, SEEN).catch(() => 0)) || 0;
  const alive = seen && Date.now() - seen < 5 * 60e3;
  return { ok: true, queued: true, req, mac: alive ? "켜져 있음 — 1분 안에 시작" : (seen ? `마지막 확인 ${Math.round((Date.now() - seen) / 60e3)}분 전 — 맥이 꺼져 있거나 설치 전일 수 있어요` : "아직 맥이 한 번도 확인하지 않았어요 — 설치가 필요합니다") };
}
export async function websalesCancel(env) { await fbPut(env, REQ, null); return { ok: true, cancelled: true }; }

// 맥이 1분마다 묻는다 — 걸린 요청이 있으면 가져간다(claim)
export async function websalesPending(env, dev = "") {
  if (dev === "setup") return { pending: false, setup: true };   // 설치 때 인증키만 확인 — 요청을 가져가지 않는다
  try { await fbPut(env, SEEN, Date.now()); } catch {}
  const req = await fbGet(env, REQ).catch(() => null);
  if (!req || !req.atMs) return { pending: false };
  if (Date.now() - req.atMs > REQ_TTL) { await fbPut(env, REQ, null).catch(() => {}); return { pending: false, expired: true }; }
  if (req.claim && Date.now() - Number(req.claim.ts) < CLAIM_TTL) return { pending: false, busy: true };
  await fbPut(env, REQ, { ...req, claim: { dev: clip(dev, 20), ts: Date.now() } });
  return { pending: true, mode: req.mode, from: req.from, to: req.to, at: req.at };
}

// 맥이 결과를 보낸다 — 실행 기록·화면 사진 저장, import 면 판매 현황에 반영
export async function websalesPush(env, b = {}, dev = "") {
  const at = kstAt();
  const steps = (Array.isArray(b.steps) ? b.steps : []).slice(0, 20).map((s) => ({
    name: clip(s && s.name, 60), url: clip(s && s.url, 300), title: clip(s && s.title, 120), text: clip(s && s.text, 2500),
    inputs: (Array.isArray(s && s.inputs) ? s.inputs : []).slice(0, 40), buttons: (Array.isArray(s && s.buttons) ? s.buttons : []).slice(0, 60).map((x) => clip(x, 60)),
    frames: (Array.isArray(s && s.frames) ? s.frames : []).slice(0, 10).map((x) => clip(x, 200)), note: clip(s && s.note, 500),
  }));
  const net = (Array.isArray(b.net) ? b.net : []).slice(0, 80).map((x) => ({ url: clip(x && x.url, 300), status: x && x.status, type: clip(x && x.type, 60), body: clip(x && x.body, 600) }));
  let result = null;
  if (b.mode === "import" && Array.isArray(b.rows) && b.rows.length && DAY.test(b.from || "") && DAY.test(b.to || "")) {
    result = await salesImport(env, { fileName: clip(b.fileName || `맥 로봇 판매조회 ${at}`, 100), from: b.from, to: b.to, rows: b.rows }).catch((e) => ({ ok: false, error: e.message }));
  }
  const log = { at, dev: clip(dev, 20), mode: clip(b.mode, 10), from: clip(b.from, 10), to: clip(b.to, 10), ok: !!b.ok && (!result || result.ok !== false),
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
export async function websalesShot(env, i) {
  const shots = await fbGet(env, SHOTS).catch(() => null);
  const x = Array.isArray(shots) ? shots[Number(i) || 0] : null;
  return x && x.data ? x : null;
}
