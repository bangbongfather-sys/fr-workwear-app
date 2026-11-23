// ── 말로 묻는 회사 비서 (운전 중에도) ──
//
// 질문(글자) → Claude 가 회사 자료를 찾아보고 짧은 한국어 말투로 답한다. 「일정 추가해 줘」면 일정에 넣는다.
//  - 아이폰 단축어(Siri·CarPlay): POST /api/voice/ask/<토큰> 본문 = 질문 글자 → 답 글자(그대로 「텍스트 말하기」)
//    단축어는 로그인 헤더를 못 붙여 주소 안의 토큰으로 검증한다(은행 문자·캘린더 구독과 같은 방식).
//  - 앱 마이크 단추(로그인): POST /api/voice/ask {text} → {answer, actions}
//  - 관리(로그인): /api/voice/key/status · issue · disable
// 할 수 있는 일은 「읽기」와 「일정 추가」뿐 — 지우기·고치기 도구는 아예 주지 않는다.
// Anthropic API 키(ANTHROPIC_API_KEY)는 Cloudflare Secret 에만 있다.
import { callTool } from "./mcp.js";

const FB_HOST = "njsafety-2ee24-default-rtdb.asia-southeast1.firebasedatabase.app";
const CFG_PATH = "/frw_voice";          // {token, at, day, count, lastAt}
const CONV_PATH = "/frw_voice_conv";    // 최근 대화 몇 마디 — 「그럼 지난달은?」 같은 이어 묻기용
const LOG_PATH = "/frw_voice_log";      // 최근 20번 (질문·답·한 일)
const DAY_LIMIT = 300;                  // 하루 최대 질문 수(비용 안전장치)
const CONV_TTL = 15 * 60e3;             // 15분 지나면 새 대화
const TIME_BUDGET = 40e3;               // 한 질문에 쓰는 최대 시간

const fbUrl = (env, path) => `https://${FB_HOST}${path}.json?auth=${encodeURIComponent(env.FIREBASE_DB_SECRET)}`;
async function fbGet(env, path) { const r = await fetch(fbUrl(env, path)); return r.ok ? r.json() : null; }
async function fbPut(env, path, v) { const r = await fetch(fbUrl(env, path), { method: "PUT", body: JSON.stringify(v) }); if (!r.ok) throw new Error(`Firebase ${r.status}`); }
async function fbPatch(env, path, v) { const r = await fetch(fbUrl(env, path), { method: "PATCH", body: JSON.stringify(v) }); if (!r.ok) throw new Error(`Firebase ${r.status}`); }

const kstNow = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 16).replace("T", " ");
const randomToken = () => [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
const asList = (v) => (Array.isArray(v) ? v : v ? Object.values(v) : []).filter(Boolean);
const num = (v) => { const n = Number(String(v ?? "").replace(/[^\d.-]/g, "")); return Number.isFinite(n) ? n : 0; };
const DOW = ["일", "월", "화", "수", "목", "금", "토"];

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" },
});
const text = (s, status = 200) => new Response(s, {
  status, headers: { "Content-Type": "text/plain; charset=utf-8", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" },
});

// ── Claude 에게 주는 도구 (읽기 + 일정 추가만) ──
const VOICE_TOOLS = [
  {
    name: "read_data",
    description: [
      "회사앱 자료를 읽습니다. section 에 아래 중 하나를 넣으세요(필요한 것만, 작은 것부터).",
      "· _campus — 한눈 요약: 장부 월매출·사업자별 입금·최근 매입·발주·재고·다가오는 일정·세무 기한",
      "· _todos — 일정(오늘 앞뒤 60일, id·날짜·내용·완료) · _cal:YYYY-MM — 그 달 일정 자세히 + 세금 기한",
      "· _sales:YYYY-MM-DD~YYYY-MM-DD — 이카운트 판매(매출) 합계·거래처·품목 상위 (전표 날짜 기준). _sales:7 = 최근 7일",
      "· _entered:YYYY-MM-DD — 그날 이카운트에 「입력한」 전표(전표 날짜와 상관없이)와 직전 입력일",
      "· _ledger:YYYY-MM — 그 달 장부(거래처별 공급가·합계·입금 상태) · _deposits:YYYY-MM — 그 달 통장 입금",
      "· _stock — 완제품 재고(품명·수량·안전재고) · _polist 또는 _polist:<검색어> — 최근 발주",
      "· _payables:<공급처> — 공급처 미지급 · _hr — 직원·급여 · accounts — 통장 잔액 · taxes — 세금 고지",
    ].join("\n"),
    input_schema: { type: "object", properties: { section: { type: "string" } }, required: ["section"] },
  },
  {
    name: "unpaid_summary",
    description: "장부 기준 미수금(「미입금」) 거래처별 합계. client 를 주면 그 거래처의 달별 미수만.",
    input_schema: { type: "object", properties: { client: { type: "string", description: "거래처명 일부 (선택)" } } },
  },
  {
    name: "search_purchases",
    description: "매입 현황(원단·부자재 입고) — 공급처명·기간으로 찾고 금액 합계를 냅니다.",
    input_schema: { type: "object", properties: { supplier: { type: "string" }, from: { type: "string", description: "YYYY-MM-DD" }, to: { type: "string", description: "YYYY-MM-DD" }, limit: { type: "number" } } },
  },
  {
    name: "get_pricing",
    description: "단가 계산기 제품별 등급(A~D) 단가. query 로 제품명 일부, grade 로 등급.",
    input_schema: { type: "object", properties: { query: { type: "string" }, grade: { type: "string" } } },
  },
  {
    name: "get_planner",
    description: "플래너 — view: day(그 날 시간표) · week · dashboard. date 는 YYYY-MM-DD (기본 오늘).",
    input_schema: { type: "object", properties: { view: { type: "string", enum: ["day", "week", "quarter", "year", "dashboard", "plan"] }, date: { type: "string" } } },
  },
  {
    name: "add_todo",
    description: "회사앱 「일정」에 일정 1건을 추가합니다(노션 To Do 도 같이 생김). 시각이 있으면 text 맨 앞에 24시간제로 \"15:00 \" 처럼 적으세요(그래야 시간표에 뜹니다). 끝나는 시각도 말했으면 \"15:00-16:30 \".",
    input_schema: {
      type: "object",
      properties: {
        date: { type: "string", description: "날짜 YYYY-MM-DD — 필수" },
        text: { type: "string", description: "일정 내용 — 필수" },
        memo: { type: "string" },
        endDate: { type: "string", description: "여러 날 일정의 끝나는 날 (선택)" },
      },
      required: ["date", "text"],
    },
  },
];

const SYSTEM = `당신은 방염복 회사 NJ SAFETY 대표의 음성 비서입니다. 대표는 운전 중이거나 손을 쓸 수 없는 상황에서 말로 묻습니다.
답은 그대로 소리 내어 읽힙니다. 그러니:
- 한국어 존댓말로, 1~3문장, 핵심 숫자부터. 표·목록·기호·마크다운·이모지·괄호 설명은 쓰지 마세요.
- 금액은 귀로 듣기 쉽게 반올림해 말하세요. 예: 320,001,990원 → "약 3억 2천만 원", 15,529,800원 → "약 1,550만 원". 정확한 금액을 물으면 그때만 끝자리까지.
- 날짜는 "11월 24일 월요일"처럼, 시각은 "오후 3시"처럼 말하세요.
- 자료가 필요하면 도구로 찾아본 뒤 답하세요. 짐작으로 숫자를 지어내지 마세요. 찾을 수 없으면 솔직히 "앱에 자료가 없어요"라고 하세요.
- 도구는 꼭 필요한 만큼만(보통 1~2번) 쓰세요. 서로 상관없는 조회는 한 번에 같이 부르세요.
- 「일정 추가해 줘」「~ 잡아 줘」「~ 기억해 둬(날짜 있음)」면 add_todo 로 넣고, 넣은 날짜·시각·내용을 짧게 되읽어 주세요. 날짜를 안 말했으면 오늘로 넣고 그렇게 말해 주세요. "내일·모레·다음 주 화요일"은 아래 오늘 날짜로 계산하세요.
- 일정을 지우거나 고치는 일, 돈을 보내거나 장부를 바꾸는 일은 할 수 없습니다. 부탁받으면 "그건 앱에서 직접 해 주세요"라고 하세요.
- 매출은 특별한 말이 없으면 이카운트 판매(_sales, 전표 날짜 기준)로 답하고, "오늘 입력한 매출"을 물으면 _entered 로 답하세요.`;

// 도구 실행 — 결과는 글자로, 너무 길면 자른다(빠르게·싸게)
async function runTool(env, name, input, actions) {
  const a = input && typeof input === "object" ? input : {};
  let r;
  if (name === "read_data") {
    const section = String(a.section || "").trim();
    if (!section) return { text: "section 이 비었습니다.", err: true };
    // 쓰기 우회 경로는 막는다 — 음성 비서는 읽기 + add_todo 만
    if (/^_(write|intake|todo_|planner|deposit_link|deposit_add|websales|ecount:(sync|refresh))/.test(section)) return { text: "음성 비서에서는 읽기만 할 수 있습니다.", err: true };
    r = await callTool({ name: "get_business_section", arguments: { section } }, env);
  } else if (name === "unpaid_summary") {
    return { text: JSON.stringify(await unpaidSummary(env, a.client)) };
  } else if (name === "search_purchases" || name === "get_pricing" || name === "get_planner") {
    r = await callTool({ name, arguments: a }, env);
  } else if (name === "add_todo") {
    const args = { date: a.date, text: a.text, memo: a.memo || "", endDate: a.endDate || "", token: `voice-${crypto.randomUUID()}` };
    r = await callTool({ name: "add_todo", arguments: args }, env);
    if (!r.isError) actions.push({ kind: "todo", date: String(a.date || ""), text: String(a.text || "") });
  } else {
    return { text: `알 수 없는 도구: ${name}`, err: true };
  }
  const t = asList(r && r.content).filter((c) => c.type === "text").map((c) => c.text).join("\n");
  return { text: t.length > 14000 ? t.slice(0, 14000) + " …(잘림 — 더 좁혀서 다시 찾으세요)" : t || "(빈 결과)", err: !!(r && r.isError) };
}

async function unpaidSummary(env, client) {
  const L = await fbGet(env, "/frw/ledgers");
  const q = String(client || "").replace(/\s+/g, "");
  const by = {};
  Object.keys(L || {}).sort().forEach((ym) => asList(L[ym] && L[ym].clients).forEach((c) => {
    if (c.status !== "미입금" || num(c.total) <= 0) return;
    const n = String(c.name || "").trim(); if (q && !n.replace(/\s+/g, "").includes(q)) return;
    (by[n] = by[n] || { 거래처: n, 합계: 0, 달: [] }).합계 += num(c.total); by[n].달.push(`${ym} ${num(c.total)}`);
  }));
  const rows = Object.values(by).sort((x, y) => y.합계 - x.합계);
  return { 기준: "장부의 「미입금」 행(VAT 포함 합계)", 전체합계: rows.reduce((s, r) => s + r.합계, 0), 거래처수: rows.length, 거래처: rows.slice(0, 25) };
}

async function claude(env, body) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      // 안전 검사에 걸려 거절되면 서버가 알아서 다른 모델로 다시 해 준다
      "anthropic-beta": "server-side-fallback-2026-07-01",
    },
    body: JSON.stringify(body),
  });
  const d = await r.json().catch(() => null);
  if (!r.ok) throw new Error((d && d.error && d.error.message) || `Claude 응답 ${r.status}`);
  return d;
}

// 질문 하나 처리 → { answer, actions, ms }
export async function voiceAsk(env, question, { via = "app" } = {}) {
  const t0 = Date.now();
  const q = String(question || "").trim().slice(0, 1000);
  if (!q) return { answer: "질문이 비어 있어요. 다시 말씀해 주세요.", actions: [] };
  if (!env.ANTHROPIC_API_KEY) return { answer: "서버에 Claude 키가 없어서 답할 수 없어요.", actions: [], error: "ANTHROPIC_API_KEY 없음" };
  // 하루 사용량 안전장치
  const cfg = (await fbGet(env, CFG_PATH)) || {};
  const today = kstNow().slice(0, 10);
  const count = cfg.day === today ? Number(cfg.count) || 0 : 0;
  if (count >= DAY_LIMIT) return { answer: "오늘 질문 횟수를 다 썼어요. 내일 다시 물어봐 주세요.", actions: [] };
  await fbPatch(env, CFG_PATH, { day: today, count: count + 1, lastAt: kstNow() });

  // 최근 대화(15분 안) — 글자만 이어 붙인다
  const conv = (await fbGet(env, CONV_PATH)) || {};
  const prev = conv.at && Date.now() - conv.at < CONV_TTL ? asList(conv.turns).slice(-4) : [];
  const now = new Date(Date.now() + 9 * 3600e3);
  const ymd = now.toISOString().slice(0, 10);
  const stamp = `지금: ${ymd} (${DOW[now.getUTCDay()]}요일) ${now.toISOString().slice(11, 16)} 한국 시간`;
  const messages = [];
  prev.forEach((t) => { messages.push({ role: "user", content: t.q }); messages.push({ role: "assistant", content: t.a }); });
  messages.push({ role: "user", content: `${stamp}\n\n${q}` });

  const actions = [];
  let answer = "";
  for (let turn = 0; turn < 6; turn++) {
    if (Date.now() - t0 > TIME_BUDGET) { answer = answer || "자료를 찾는 데 시간이 너무 걸려서 멈췄어요. 조금 더 좁혀서 물어봐 주세요."; break; }
    const d = await claude(env, {
      model: env.VOICE_MODEL || "claude-opus-5-5",
      max_tokens: 4000,
      output_config: { effort: env.VOICE_EFFORT || "low" },
      fallbacks: "default",
      cache_control: { type: "ephemeral" },
      system: SYSTEM,
      tools: VOICE_TOOLS,
      messages,
    });
    const content = Array.isArray(d.content) ? d.content : [];
    const said = content.filter((b) => b.type === "text").map((b) => b.text).join("").trim();
    if (d.stop_reason === "refusal") { answer = "그 질문에는 답할 수 없어요."; break; }
    if (d.stop_reason !== "tool_use") { answer = said || answer || "답을 만들지 못했어요. 다시 물어봐 주세요."; break; }
    messages.push({ role: "assistant", content });   // 생각 블록 등은 받은 그대로 되돌려 준다
    const uses = content.filter((b) => b.type === "tool_use");
    const results = await Promise.all(uses.map(async (u) => {
      try { const r = await runTool(env, u.name, u.input, actions); return { type: "tool_result", tool_use_id: u.id, content: r.text, ...(r.err ? { is_error: true } : {}) }; }
      catch (e) { return { type: "tool_result", tool_use_id: u.id, content: `오류: ${e?.message || e}`, is_error: true }; }
    }));
    messages.push({ role: "user", content: results });
    if (said) answer = said;
  }
  answer = cleanSpeech(answer);
  const turns = [...prev, { q, a: answer }].slice(-4);
  const ms = Date.now() - t0;
  try {
    await fbPut(env, CONV_PATH, { at: Date.now(), turns });
    const log = asList(await fbGet(env, LOG_PATH));
    await fbPut(env, LOG_PATH, [{ at: kstNow(), via, q: q.slice(0, 200), a: answer.slice(0, 300), actions, ms }, ...log].slice(0, 20));
  } catch {}
  return { answer, actions, ms };
}

// 소리로 읽기 좋게 — 마크다운 기호 정리
function cleanSpeech(s) {
  return String(s || "").replace(/\*\*|__|`|#+\s/g, "").replace(/^\s*[-•·]\s+/gm, "").replace(/\n{2,}/g, "\n").trim();
}

async function readQuestion(request) {
  const ct = request.headers.get("content-type") || "";
  try {
    if (ct.includes("application/json")) { const b = await request.json(); return { q: String(b.text || b.q || b.question || ""), reset: !!b.reset }; }
    if (ct.includes("form")) { const f = await request.formData(); return { q: String(f.get("text") || f.get("q") || "") }; }
    return { q: await request.text() };
  } catch { return { q: "" }; }
}

// 단축어용 (로그인 없이, 주소 토큰) — 답을 글자 그대로 돌려준다. ?json=1 이면 JSON.
export async function handleVoicePublic(request, env, url) {
  const m = /^\/api\/voice\/ask\/([a-f0-9]{16,64})\/?$/.exec(url.pathname);
  if (!m) return json({ error: "Not found" }, 404);
  const wantJson = url.searchParams.get("json") === "1";
  const out = (o, st = 200) => (wantJson ? json(o, st) : text(o.answer || o.error || "", st));
  const cfg = (await fbGet(env, CFG_PATH)) || {};
  if (!cfg.token || cfg.token !== m[1]) return out({ answer: "주소가 맞지 않아요. 앱에서 새 주소를 확인해 주세요." }, 403);
  const { q } = request.method === "GET" ? { q: url.searchParams.get("q") || "" } : await readQuestion(request);
  try { return out(await voiceAsk(env, q, { via: "shortcut" })); }
  catch (e) { return out({ answer: "지금은 답을 가져오지 못했어요. 잠시 뒤 다시 물어봐 주세요.", error: e?.message || String(e) }, 200); }
}

// 앱용 (로그인 필요) — 질문·관리
export async function handleVoiceApp(request, env, url) {
  const p = url.pathname.replace(/\/+$/, "");
  if (p === "/api/voice/ask" && request.method === "POST") {
    const { q, reset } = await readQuestion(request);
    if (reset) { try { await fbPut(env, CONV_PATH, { at: 0, turns: [] }); } catch {} }
    try { return json(await voiceAsk(env, q, { via: "app" })); }
    catch (e) { return json({ answer: "지금은 답을 가져오지 못했어요. 잠시 뒤 다시 물어봐 주세요.", error: e?.message || String(e), actions: [] }); }
  }
  if (p === "/api/voice/reset" && request.method === "POST") { await fbPut(env, CONV_PATH, { at: 0, turns: [] }); return json({ ok: true }); }
  const cfg = (await fbGet(env, CFG_PATH)) || {};
  if (p === "/api/voice/key/status") {
    return json({ enabled: !!cfg.token, token: cfg.token || null, at: cfg.at || null, lastAt: cfg.lastAt || null, today: cfg.day === kstNow().slice(0, 10) ? Number(cfg.count) || 0 : 0,
      limit: DAY_LIMIT, ai: !!env.ANTHROPIC_API_KEY, log: asList(await fbGet(env, LOG_PATH)).slice(0, 10) });
  }
  if (p === "/api/voice/key/issue" && request.method === "POST") {
    const token = randomToken(); await fbPatch(env, CFG_PATH, { token, at: kstNow() }); return json({ ok: true, enabled: true, token });
  }
  if (p === "/api/voice/key/disable" && request.method === "POST") { await fbPatch(env, CFG_PATH, { token: "" }); return json({ ok: true, enabled: false }); }
  return json({ error: "Not found" }, 404);
}
