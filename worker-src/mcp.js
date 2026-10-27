import { ecountConfigured, ecountStockItems, ecountProbe, buildStockItems, ecountRows } from "./ecount.js";
import { salesSummary, salesImport, salesCadence } from "./sales.js";
// ── Claude 커스텀 커넥터용 MCP 서버 (토큰 잠금, stateless Streamable HTTP) ──
//
// claude.ai → 설정 → 커넥터 → 커스텀 커넥터 추가 → URL: https://<worker>/mcp
//
// 프로토콜: JSON-RPC 2.0 over HTTP POST /mcp.
//  - 세션/서버주도 스트리밍 없음(stateless). 단일 요청-응답만 처리.
//  - 클라이언트가 Accept: text/event-stream 요청 시 단일 message 이벤트(SSE)로 응답, 아니면 JSON.
//  - 기본은 읽기 전용. 유일한 쓰기 도구는 mark_tax_paid(세무 탭 납부일 기록)뿐이며,
//    MCP_TOKEN 이 설정돼 엔드포인트가 잠겨 있을 때를 전제로 한다. 토큰을 해제하면
//    누구나 납부일을 고칠 수 있으니 반드시 유지할 것.
//
// 도구는 worker가 이미 쓰는 FIREBASE_DB_SECRET으로 RTDB를 직접 읽는다.

const FB_HOST = "njsafety-2ee24-default-rtdb.asia-southeast1.firebasedatabase.app";
const SERVER_NAME = "nj-safety";
const SERVER_VERSION = "1.0.0";
const DEFAULT_PROTOCOL_VERSION = "2025-06-18";

const ALLOWED_SECTIONS = [
  "clients", "suppliers", "clientAR", "ledgers", "monthlySales", "accounts",
  "products", "materials", "laborItems", "orders", "purchaseOrders", "fabricIntakes",
  "bids", "investments", "cashFlows", "scheduledExpenses", "todos", "notes", "recurringSchedules",
  "stock", "payables", "bankDeposits", "prodTrash", "companySeal", "taxes", "meetings",
];

// 단가 계산기 로직 (index.html computeProduct와 동일 공식) ──
const DEFAULT_MARGINS = { A: 50, B: 40, C: 30, D: 20 };
const GRADES = ["A", "B", "C", "D"];

function getActiveSpec(p) {
  if (!p) return null;
  if (Array.isArray(p.specs) && p.specs.length > 0) {
    return p.specs.find((s) => s.id === p.activeSpecId) || p.specs[0];
  }
  return p; // 레거시 평면 구조
}

// 견적용 요척서 — 앱에서 「납품가」로 지정한 요척서(deliverySpecId)가 있으면 그것,
// 없으면 화면에서 마지막으로 보고 있던 요척서(activeSpecId).
// activeSpecId 는 누가 무엇을 열어 봤느냐에 따라 바뀌므로 견적 기준으로는 납품가가 맞다.
function getPricingSpec(p) {
  if (p && Array.isArray(p.specs) && p.deliverySpecId != null) {
    const d = p.specs.find((s) => String(s.id) === String(p.deliverySpecId));
    if (d) return { spec: d, basis: "납품가" };
  }
  return { spec: getActiveSpec(p), basis: "화면 선택(납품가 미지정)" };
}

function computeProduct(p, materials, laborItems, specOverride) {
  const mats = materials || [];
  const labor = laborItems || [];
  const spec = specOverride || getActiveSpec(p) || p;
  // index.html fabricInfo 와 같게: 단가표 원단이 없으면 직접 입력 단가(f.price)를 쓴다
  const fCost = (spec.fabrics || []).reduce((s, f) => {
    const m = f.matId !== "" && f.matId != null ? mats.find((x) => x.id == f.matId) : null;
    const price = m ? (m.price || 0) : parseFloat(f.price || 0);
    return s + (price > 0 ? price * parseFloat(f.qty || 0) : 0);
  }, 0);
  const eCost = (spec.extras || []).reduce((s, e) => {
    const u = e.laborId !== "" && e.laborId != null ? ((labor.find((l) => l.id == e.laborId) || {}).price || 0) : parseFloat(e.price || 0);
    return s + u * parseFloat(e.qty || 1);
  }, 0);
  const base = fCost + eCost;
  const admin = base * ((spec.adminRate || 0) / 100);
  const beforeMargin = base + admin;
  const margins = spec.margins || DEFAULT_MARGINS;
  const overrides = spec.priceOverrides || {};
  const gradeList = spec.grades && spec.grades.length > 0 ? spec.grades : GRADES;
  const grades = {};
  for (const g of gradeList) {
    const auto = beforeMargin * (1 + (margins[g] ?? DEFAULT_MARGINS[g] ?? 30) / 100);
    const ov = parseFloat(overrides[g]);
    grades[g] = !isNaN(ov) && ov > 0 ? ov : auto;
  }
  return { base, admin, beforeMargin, grades, gradeList, selectedGrade: spec.selectedGrade || gradeList[0] || "A" };
}

const TOOLS = [
  {
    name: "search_tenders",
    description: "수집된 조달청(나라장터) 방염복 입찰 공고를 검색합니다. 공고명·발주기관 키워드와 상태로 필터링.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "공고명·발주기관 검색어 (선택)" },
        status: { type: "string", description: "상태 필터: new, reviewing, applied, awarded, failed, skipped (선택)" },
        limit: { type: "number", description: "최대 반환 건수 (기본 20, 최대 100)" },
      },
    },
  },
  {
    name: "search_quotes",
    description: "저장된 견적 이력을 검색합니다. 제목·거래처명으로 필터하며, 견적 본문은 제외하고 요약(제목/거래처/일자/품목/총액)만 반환합니다.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "견적 제목·거래처 검색어 (선택)" },
        limit: { type: "number", description: "최대 반환 건수 (기본 20, 최대 100)" },
      },
    },
  },
  {
    name: "get_business_section",
    description: "앱의 모든 데이터 탭 원본을 조회합니다. (단가 계산기의 등급 단가는 get_pricing이 더 정확)",
    inputSchema: {
      type: "object",
      properties: {
        section: {
          type: "string",
          enum: ALLOWED_SECTIONS,
          description:
            "clients(거래처별 단가), suppliers(공급처), clientAR(거래처 미수금), ledgers(장부), monthlySales(월매출), accounts(통장 잔액), products(단가계산기 제품-원본), materials(원단 단가표), laborItems(공임 단가표), orders(판매), purchaseOrders(발주), fabricIntakes(매입현황), bids(입찰캘린더-수동), investments(투자), cashFlows(자금흐름), scheduledExpenses(예정지출), todos(일정), notes(메모), recurringSchedules(정기일정)",
        },
      },
      required: ["section"],
    },
  },
  {
    name: "get_pricing",
    description: "단가 계산기의 제품별 등급(A~D) 단가를 계산해 반환합니다. (원단비+공임+관리비+등급마진/오버라이드 반영) 기본은 제품마다 앱에서 「납품가」로 지정한 요척서 기준이며, 견적서를 만들 때는 이 값을 쓰세요. 예: 'D급 견적서' → grade:\"D\" 로 호출해 각 제품의 단가를 사용. 응답의 '기준'이 '화면 선택(납품가 미지정)'인 제품은 납품가가 지정되지 않은 것이므로 사용자에게 확인을 권하세요.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "제품명 부분검색 (선택, 없으면 전체)" },
        grade: { type: "string", description: "견적 등급 (선택, 예: A·B·C·D). 지정하면 각 제품에 '단가'(그 등급 단가)를 함께 반환" },
        allSpecs: { type: "boolean", description: "true면 납품가 외 다른 요척서(예: 25년 가격)의 등급 단가도 함께 반환 (비교용)" },
      },
    },
  },
  {
    name: "search_purchases",
    description: "매입 현황(입고 기록)을 조회합니다. 공급처명과 매입일 기간으로 필터링하고 금액 합계(수량×단가)를 계산해 반환합니다.",
    inputSchema: {
      type: "object",
      properties: {
        supplier: { type: "string", description: "공급처명 부분검색 (예: 구리공장, 짱아) — 선택" },
        from: { type: "string", description: "시작일 YYYY-MM-DD (선택)" },
        to: { type: "string", description: "종료일 YYYY-MM-DD, 해당일 포함 (선택)" },
        limit: { type: "number", description: "최대 반환 라인 수 (기본 200, 최대 1000). 합계는 필터 전체 기준." },
      },
    },
  },
  {
    name: "get_campus_snapshot",
    description:
      "NJ 캠퍼스(3D 업무 시뮬레이터)용 요약 스냅샷. 장부 월매출·사업자별 입금·최근 매입/임가공·발주·완제품 재고·다가오는 일정·세무 기한·입찰 공고 수를 작게 묶어 반환합니다. 읽기 전용.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: "record_intake",
    description:
      "매입현황 입고를 기록합니다(NJ 캠퍼스용 쓰기 도구). mode=receive: 기존 '주문완료' 건(id)을 입고완료로 바꾸고, 받은 수량이 적으면 받은 만큼만 입고완료 행으로 나누고 나머지는 주문완료로 남깁니다. mode=new: 새 입고 행(입고완료)을 추가합니다. 회사앱 동기화 안전장치(_revs 증가·_sigs 갱신)를 지킵니다.",
    inputSchema: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["receive", "new", "batch"] },
        rows: { type: "array", description: "batch: [{materialName, qty, unit, unitPrice, status(입고완료|주문완료), note}]", items: { type: "object" } },
        inspector: { type: "string", description: "batch: 검수 담당자 (선택)" },
        id: { type: ["string", "number"], description: "receive: 매입현황 행 id" },
        qty: { type: "number", description: "받은 수량(receive) 또는 입고 수량(new)" },
        date: { type: "string", description: "입고일 YYYY-MM-DD (기본 오늘, KST)" },
        supplier: { type: "string", description: "new: 공급처" },
        materialName: { type: "string", description: "new: 품목명" },
        unit: { type: "string", description: "new: 단위 (선택)" },
        unitPrice: { type: "number", description: "new: 단가 (선택)" },
        note: { type: "string", description: "비고 (선택, 사이즈 등)" },
        token: { type: "string", description: "중복 방지용 1회 토큰 (같은 토큰 재요청은 한 번만 반영)" },
      },
      required: ["mode"],
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: "mark_tax_paid",
    description:
      "세무 탭의 특정 고지 건에 납부일을 기록합니다(또는 지웁니다). 대상은 id로 지정하며, get_business_section(section:\"taxes\")로 먼저 id를 확인하세요. paidDate 필드만 바꾸고 금액·기한·메모는 건드리지 않습니다.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: ["string", "number"], description: "세무 레코드의 id (taxes 조회 결과의 id 값)" },
        paidDate: {
          type: "string",
          description: "납부일 YYYY-MM-DD. 빈 문자열(\"\")을 주면 납부 기록을 지우고 미납으로 되돌립니다.",
        },
      },
      required: ["id", "paidDate"],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  {
    name: "list_backups",
    description: "앱이 4시간 슬롯마다 남기는 백업 스냅샷(frw_backup_YYYY-MM-DD_HH) 목록을 최신순으로 반환합니다. 데이터 유실 진단·복구용.",
    inputSchema: { type: "object", properties: { limit: { type: "number", description: "최대 개수 (기본 40)" } } },
    annotations: { readOnlyHint: true },
  },
  {
    name: "get_backup_section",
    description: "특정 백업 슬롯의 한 섹션 원본을 반환합니다. products 는 이미지를 생략하고, summaryOnly 면 제품별 요척서 수만 요약합니다.",
    inputSchema: {
      type: "object",
      properties: {
        slot: { type: "string", description: "list_backups 의 슬롯명 (예: 2026-08-30_08)" },
        section: { type: "string", enum: ALLOWED_SECTIONS },
        summaryOnly: { type: "boolean", description: "products 전용: 제품별 {id,name,specs수,specNames} 만 반환" },
      },
      required: ["slot", "section"],
    },
    annotations: { readOnlyHint: true },
  },
];

/* ───────── 외부 정보 (AI 직원용) ───────── */
// Brave Search API — 무료 플랜 키를 SEARCH_API_KEY 시크릿으로 넣으면 켜진다. 없으면 이유를 돌려준다(추측 금지).
async function webSearch(q, env) {
  q = String(q || "").trim().slice(0, 200);
  if (!q) return { error: "검색어가 비었습니다." };
  if (!env.SEARCH_API_KEY) return { error: "웹 검색 키(SEARCH_API_KEY)가 아직 등록되지 않았습니다. 대표에게 Brave Search API 키 등록을 요청하세요.", query: q, results: [] };
  const u = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=8&search_lang=ko&country=KR&text_decorations=false&safesearch=moderate`;
  try {
    const r = await fetch(u, { headers: { Accept: "application/json", "X-Subscription-Token": env.SEARCH_API_KEY } });
    if (!r.ok) return { error: `검색 서비스 응답 ${r.status}`, query: q, results: [] };
    const j = await r.json();
    const results = ((j.web && j.web.results) || []).slice(0, 8).map((x) => ({ title: String(x.title || "").slice(0, 120), url: x.url, snippet: String(x.description || "").slice(0, 300), age: x.age || x.page_age || "" }));
    const news = ((j.news && j.news.results) || []).slice(0, 4).map((x) => ({ title: String(x.title || "").slice(0, 120), url: x.url, snippet: String(x.description || "").slice(0, 200), age: x.age || "" }));
    return { query: q, results, news };
  } catch (e) { return { error: "검색 실패: " + (e && e.message), query: q, results: [] }; }
}
// Claude API 리서치 — 서버가 Anthropic Messages API를 웹 검색 도구와 함께 부른다. 호출마다 API 요금이 나가므로 캠퍼스 쪽에서 사용자 승인 뒤에만 부른다.
async function claudeResearch(raw, env) {
  let a = {}; try { a = JSON.parse(raw); } catch { a = { q: raw }; }
  const q = String(a.q || "").trim().slice(0, 600), ctx = String(a.context || "").slice(0, 1500);
  if (!q) return { error: "조사할 내용이 비었습니다." };
  if (!env.ANTHROPIC_API_KEY) return { error: "Claude API 키(ANTHROPIC_API_KEY)가 아직 등록되지 않았습니다. 대표에게 등록을 요청하세요.", query: q };
  const model = env.RESEARCH_MODEL || "claude-sonnet-5-5";
  const sys = "당신은 나정엔터프라이즈(NJ SAFETY, 산업용 방염작업복 제조·B2B 판매, 거래처는 안전용품 대리점·전기공사 업체)의 리서치 담당입니다. 웹 검색으로 최신 정보를 확인해 한국어로 보고합니다. 형식: 결론 2~3줄 → 핵심 사실(숫자·날짜 포함, 항목마다 출처 번호) → 우리 회사에 주는 시사점 2~3개. 확인 못 한 건 모른다고 적습니다. 1,200자 안쪽.";
  const user = (ctx ? `배경: ${ctx}\n\n` : "") + `조사 요청: ${q}\n오늘: ${kstToday()}`;
  const body = { model, max_tokens: 1400, system: sys, messages: [{ role: "user", content: user }], tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 5, user_location: { type: "approximate", country: "KR", timezone: "Asia/Seoul" } }] };
  try {
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 85000);
    const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", signal: ctrl.signal, headers: { "content-type": "application/json", "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" }, body: JSON.stringify(body) });
    clearTimeout(t);
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return { error: `Claude API 응답 ${r.status}: ${(j.error && j.error.message) || ""}`.slice(0, 300), query: q };
    const text = [], sources = new Map(); let searches = 0;
    for (const b of j.content || []) {
      if (b.type === "text") { text.push(b.text); for (const c of b.citations || []) if (c.url && !sources.has(c.url)) sources.set(c.url, String(c.title || "").slice(0, 100)); }
      else if (b.type === "server_tool_use") searches++;
      else if (b.type === "web_search_tool_result" && Array.isArray(b.content)) for (const x of b.content) if (x.url && !sources.has(x.url)) sources.set(x.url, String(x.title || "").slice(0, 100));
    }
    const u = j.usage || {};
    return { query: q, model, text: text.join("\n").slice(0, 6000), sources: [...sources].slice(0, 12).map(([url, title]) => ({ title, url })), searches, usage: { input: u.input_tokens, output: u.output_tokens, web_search_requests: u.server_tool_use && u.server_tool_use.web_search_requests } };
  } catch (e) { return { error: "리서치 실패: " + (e && e.name === "AbortError" ? "시간 초과(85초)" : e && e.message), query: q }; }
}
// 공개 웹 페이지 본문 읽기 — HTML에서 글만 남겨 8,000자까지
async function webRead(url) {
  url = String(url || "").trim();
  if (!/^https?:\/\//i.test(url)) return { error: "http(s) 주소만 읽을 수 있습니다.", url };
  try {
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 12000);
    const r = await fetch(url, { signal: ctrl.signal, redirect: "follow", headers: { "User-Agent": "Mozilla/5.0 (compatible; NJ-Campus-Reader/1.0)", Accept: "text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.5", "Accept-Language": "ko,en;q=0.8" } });
    clearTimeout(t);
    const ct = r.headers.get("content-type") || "";
    if (!r.ok) return { error: `페이지 응답 ${r.status}`, url };
    let text = await r.text();
    if (/json/.test(ct)) return { url, type: "json", text: text.slice(0, 8000) };
    if (/html/.test(ct) || /<html/i.test(text.slice(0, 2000))) text = htmlToText(text);
    return { url, title: (text.match(/^.{0,120}/) || [""])[0], text: text.slice(0, 8000), truncated: text.length > 8000 };
  } catch (e) { return { error: "읽기 실패: " + (e && e.name === "AbortError" ? "시간 초과" : e && e.message), url }; }
}
function htmlToText(h) {
  const title = (h.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || ["", ""])[1].replace(/\s+/g, " ").trim();
  let s = h.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(nav|header|footer|aside|form)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/(p|div|li|tr|h[1-6]|br|section|article|td|th)>/gi, "\n").replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, " ");
  s = s.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n));
  s = s.split("\n").map((l) => l.replace(/\s+/g, " ").trim()).filter((l) => l.length > 1).join("\n");
  return (title ? title + "\n\n" : "") + s;
}

async function fbGet(node, secret) {
  const url = `https://${FB_HOST}${node}.json?auth=${encodeURIComponent(secret)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Firebase ${res.status}`);
  return await res.json();
}

// 지정한 노드의 일부 필드만 갱신(RTDB PATCH). 노드 전체를 덮어쓰지 않는다.
async function fbPatch(node, patch, secret) {
  const url = `https://${FB_HOST}${node}.json?auth=${encodeURIComponent(secret)}`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`Firebase ${res.status}`);
  return await res.json();
}

// YYYY-MM-DD 가 실제로 존재하는 날짜인지. Date.parse 는 2026-02-30 을
// 3월 2일로 굴려버리므로 구성요소를 되짚어 확인해야 한다.
function isRealDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const y = +m[1], mo = +m[2], d = +m[3];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

// /frw/<section> 에서 id가 일치하는 레코드의 RTDB 키를 찾는다.
// 배열로 저장돼 있으면 인덱스, 객체면 그 키. 못 찾으면 null.
function findRecordKey(data, id) {
  const want = String(id);
  if (Array.isArray(data)) {
    const i = data.findIndex((r) => r && String(r.id) === want);
    return i >= 0 ? { key: String(i), record: data[i] } : null;
  }
  if (data && typeof data === "object") {
    for (const [k, v] of Object.entries(data)) {
      if (v && String(v.id) === want) return { key: k, record: v };
    }
  }
  return null;
}

function textContent(obj) {
  // 큰 응답은 들여쓰기를 빼서 작게 — 아티팩트 페이지가 커넥터로 받을 때 잘리거나 거절되지 않게
  let text = typeof obj === "string" ? obj : JSON.stringify(obj, null, 2);
  if (typeof obj !== "string" && text.length > 20000) text = JSON.stringify(obj);
  return { content: [{ type: "text", text }] };
}
function errContent(msg) {
  return { content: [{ type: "text", text: msg }], isError: true };
}

async function toolSearchTenders(args, env) {
  const data = await fbGet("/tenders/notices", env.FIREBASE_DB_SECRET);
  const list = data ? Object.values(data) : [];
  const q = (args.query || "").trim().toLowerCase();
  const status = (args.status || "").trim();
  const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 100);
  let filtered = list;
  if (status) filtered = filtered.filter((n) => n.status === status);
  if (q) filtered = filtered.filter((n) => `${n.bidNtceNm || ""} ${n.ntceInsttNm || ""} ${n.dminsttNm || ""}`.toLowerCase().includes(q));
  filtered.sort((a, b) => String(b.bidClseDt || "").localeCompare(String(a.bidClseDt || "")));
  const out = filtered.slice(0, limit).map((n) => ({
    공고명: n.bidNtceNm,
    공고번호: `${n.bidNtceNo}-${n.bidNtceOrd}`,
    발주기관: n.ntceInsttNm || n.dminsttNm || null,
    추정가격: n.presmptPrce ?? null,
    마감: n.bidClseDt || null,
    매칭점수: n.matchScore ?? null,
    상태: n.status || null,
    URL: n.bidNtceUrl || null,
  }));
  return textContent({ 총_매칭: filtered.length, 반환: out.length, 공고: out });
}

async function toolSearchQuotes(args, env) {
  const qh = await fbGet("/frw/quoteHistory", env.FIREBASE_DB_SECRET);
  const list = Array.isArray(qh) ? qh : qh ? Object.values(qh) : [];
  const q = (args.query || "").trim().toLowerCase();
  const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 100);
  let filtered = list;
  if (q) filtered = filtered.filter((e) => `${e.title || ""} ${e.quoteClient || ""}`.toLowerCase().includes(q));
  const out = filtered.slice(0, limit).map((e) => ({
    제목: e.title,
    거래처: e.quoteClient || null,
    일자: e.dateStr || null,
    품목: Array.isArray(e.products) ? e.products.map((p) => ({ 이름: p.name, 단가: Number(p.price) || 0 })) : [],
    총액: Array.isArray(e.products) ? e.products.reduce((s, p) => s + (Number(p.price) || 0), 0) : null,
  }));
  return textContent({ 총: filtered.length, 반환: out.length, 견적: out });
}

function toNumber(v) {
  return parseFloat(String(v ?? "").replace(/[^0-9.\-]/g, "")) || 0;
}
// "2026-5-11", "2026/05/11", "5/11"(올해) → "2026-05-11"
function normalizeDate(s) {
  const str = String(s || "").trim();
  if (!str) return "";
  const parts = str.replace(/[./]/g, "-").split("-").map((p) => p.trim()).filter(Boolean);
  let y, m, d;
  if (parts.length >= 3) [y, m, d] = parts;
  else if (parts.length === 2) { y = String(new Date().getFullYear()); [m, d] = parts; }
  else return str;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

async function toolSearchPurchases(args, env) {
  const fi = await fbGet("/frw/fabricIntakes", env.FIREBASE_DB_SECRET);
  const list = Array.isArray(fi) ? fi : fi ? Object.values(fi) : [];
  const sup = (args.supplier || "").trim();
  const from = normalizeDate(args.from);
  const to = normalizeDate(args.to);
  const limit = Math.min(Math.max(Number(args.limit) || 200, 1), 1000);

  let filtered = list.filter((r) => r && r.date);
  if (sup) filtered = filtered.filter((r) => { const s = (r.supplier || "").trim(); return s.includes(sup) || sup.includes(s); });
  if (from) filtered = filtered.filter((r) => r.date >= from);
  if (to) filtered = filtered.filter((r) => r.date <= to);
  filtered.sort((a, b) => String(a.date).localeCompare(String(b.date)));

  const total = filtered.reduce((s, r) => s + toNumber(r.qty) * toNumber(r.unitPrice), 0);
  const rows = filtered.slice(0, limit).map((r) => {
    const amount = toNumber(r.qty) * toNumber(r.unitPrice);
    return {
      매입일: r.date,
      공급처: r.supplier || null,
      품목: r.materialName || null,
      수량: r.qty ?? null,
      단가: toNumber(r.unitPrice),
      금액: amount,
      상태: r.status || null,
      비고: r.note || null,
    };
  });
  return textContent({
    공급처필터: sup || "(전체)",
    기간: `${from || "처음"} ~ ${to || "끝"}`,
    건수: filtered.length,
    금액합계: total,
    금액합계_표시: total.toLocaleString("ko-KR") + "원",
    매입: rows,
  });
}

// 백업 슬롯 목록 — 루트 키를 shallow 로 읽어 frw_backup_ 접두사만 추린다 (데이터 본문은 안 받는다)
async function toolListBackups(args, env) {
  const url = `https://${FB_HOST}/.json?shallow=true&auth=${encodeURIComponent(env.FIREBASE_DB_SECRET)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Firebase ${res.status}`);
  const root = (await res.json()) || {};
  const limit = Math.max(1, Math.min(200, Number(args.limit) || 40));
  const slots = Object.keys(root).filter((k) => k.startsWith("frw_backup_")).map((k) => k.slice("frw_backup_".length)).sort().reverse();
  return textContent({ total: slots.length, slots: slots.slice(0, limit) });
}

async function toolGetBackupSection(args, env) {
  const slot = String(args.slot || "");
  if (!/^\d{4}-\d{2}-\d{2}(?:_\d{2})?$/.test(slot)) return errContent(`slot 형식이 잘못됐습니다: "${slot}" (예: 2026-08-30_08)`);
  const section = String(args.section || "");
  if (!ALLOWED_SECTIONS.includes(section)) return errContent(`허용되지 않은 섹션: "${section}"`);
  let data = await fbGet(`/frw_backup_${slot}/${section}`, env.FIREBASE_DB_SECRET);
  if (section === "products" && Array.isArray(data)) {
    if (args.summaryOnly) {
      data = data.map((p) => ({ id: p?.id, name: p?.name, specCount: Array.isArray(p?.specs) ? p.specs.length : 0,
        specs: Array.isArray(p?.specs) ? p.specs.map((s) => ({ id: s?.id, name: s?.name, createdAt: s?.createdAt })) : [] }));
    } else {
      data = data.map((p) => (p && p.image) ? { ...p, image: "(이미지 생략)" } : p);
    }
  }
  let text = JSON.stringify(data, null, 2);
  if (text.length > 60000) text = text.slice(0, 60000) + "\n... (잘림 — 데이터가 너무 큼)";
  return { content: [{ type: "text", text }] };
}

async function toolGetSection(args, env) {
  const section = String(args.section || "");
  // 배포 확인용 마커 — 어떤 커밋이 라이브인지 원격에서 검증 (Claude가 배포 상태 점검에 사용)
  if (section === "_version") {
    // 배포 확인용 — 앱(index.html)만 바뀐 커밋은 자동 배포가 안 걸리는 경우가 있어, 앱을 고칠 때 이 값을 같이 올려 배포를 확실히 한다
    return { content: [{ type: "text", text: JSON.stringify({ build: "2026-10-27-radar-cmdk", note: "재주문 레이더 · ⌘K 명령창" }) }] };
  }
  // 커넥터가 새 도구 목록을 늦게 받는 경우를 대비한 우회 경로 (get_campus_snapshot 과 동일)
  if (section === "_campus") return textContent(await buildCampusSnapshot(env));
  // AI 직원용 작은 조회 (큰 섹션은 60KB에서 잘리므로 서버에서 필요한 만큼만 줄여 준다)
  if (section.startsWith("_ledger:")) {
    const m = section.slice(8);
    if (!/^\d{4}-\d{2}$/.test(m)) return errContent("월 형식은 YYYY-MM 입니다.");
    const L = await fbGet(`/frw/ledgers/${m}`, env.FIREBASE_DB_SECRET);
    const rows = asList(L && L.clients).map((c) => ({ 거래처: c.name, 공급가: toNumber(c.supply), 합계: toNumber(c.total), 상태: c.status || "", 메모: c.memo || "" }));
    return textContent({ 월: m, 행수: rows.length, 공급가합계: rows.filter((r) => r.상태 !== "법인 거래").reduce((a, r) => a + r.공급가, 0), 행: rows });
  }
  if (section.startsWith("_deposits:")) {
    const m = section.slice(10);
    if (!/^\d{4}-\d{2}$/.test(m)) return errContent("월 형식은 YYYY-MM 입니다.");
    const d = await fbGet("/frw/bankDeposits", env.FIREBASE_DB_SECRET);
    const rows = asList(d && d.items).filter((x) => String(x.date || "").startsWith(m)).map((x) => ({ 일자: x.date, 시각: x.time || "", 입금자: x.name || x.client || "", 금액: toNumber(x.amount), 사업자: x.biz === "corp" ? "엔제이세이프티(법인)" : "나정", 메모: x.memo || "" }));
    return textContent({ 월: m, 건수: rows.length, 합계: rows.reduce((a, r) => a + r.금액, 0), 행: rows.slice(0, 300) });
  }
  // 캠퍼스 창고용: 단가계산기 제품 목록(가벼운 것)과 제품 사진 한 장(base64 data URL)
  if (section === "_prodlist") {
    const ps = asList(await fbGet("/frw/products", env.FIREBASE_DB_SECRET));
    return textContent({ 제품: ps.map((p) => ({ id: p.id, 이름: p.name || "", 시즌: p.category || "", 포함: p.include !== false, 사진: !!(p.image && String(p.image).length > 50), 사진크기: p.image ? String(p.image).length : 0 })) });
  }
  if (section.startsWith("_prodimg:")) {
    const id = section.slice(9).trim();
    const ps = asList(await fbGet("/frw/products", env.FIREBASE_DB_SECRET));
    const p = ps.find((x) => x && String(x.id) === id);
    if (!p) return errContent(`제품이 없습니다: ${id}`);
    if (!p.image || String(p.image).length < 50) return textContent({ id, 사진: null });
    return { content: [{ type: "text", text: JSON.stringify({ id, 이름: p.name || "", 사진: String(p.image) }) }] };
  }
  // 이카운트 — 연결 점검(원본 필드 확인) / 재고 지금 동기화
  if (section === "_ecount:probe") return textContent(await ecountProbe(env));
  if (section === "_ecount:status") return textContent(await ecountStatus(env));
  if (section === "_ocr:status") return textContent({ 서버키: !!env.ANTHROPIC_API_KEY, 모델: env.OCR_MODEL || "claude-sonnet-5-5" });
  // 이카운트 판매현황(엑셀로 올린 것) — "_sales" (최근 30일) / "_sales:7" / "_sales:2026-10-01~2026-10-31"
  // 판매현황 「최신 내역 반영하기」 — 앱 버튼이 연 Claude 대화가 먼저 읽는 작업 안내 ("_sales:guide" 또는 "_sales:guide:YYYY-MM-DD~YYYY-MM-DD")
  if (section === "_sales:guide" || section.startsWith("_sales:guide:")) return textContent(await salesGuide(env, section.slice(13)));
  if (section === "_sales" || section.startsWith("_sales:")) {
    const arg = section.slice(7);
    const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
    let from, to = today;
    const m = arg.match(/^(\d{4}-\d{2}-\d{2})~(\d{4}-\d{2}-\d{2})$/);
    if (m) { from = m[1]; to = m[2]; }
    else { const k = Math.max(1, Math.min(800, Number(arg) || 30)); from = new Date(Date.now() + 9 * 3600e3 - (k - 1) * 86400e3).toISOString().slice(0, 10); }
    const r = await salesSummary(env, from, to, { top: 60 });
    return { content: [{ type: "text", text: JSON.stringify({ 안내: "이카운트 판매현황 엑셀로 올린 실제 판매. total=합계(없으면 공급가). covered=이 기간 중 엑셀이 들어온 범위 — 그 밖의 날은 아직 안 올린 것", ...r }) }] };
  }
  // 판매현황 요약(캠퍼스 판매현황 창) — "_salesum:" + JSON {from,to,top,slips} : 품목 전부(top, 기본 500)·전표 목록은 slips:true 일 때만
  if (section.startsWith("_salesum:")) {
    let o = {}; try { o = JSON.parse(section.slice(9)); } catch { return errContent("_salesum 인자 JSON 이 잘못됐습니다."); }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(o.from || "") || !/^\d{4}-\d{2}-\d{2}$/.test(o.to || "") || o.from > o.to) return errContent("from·to(YYYY-MM-DD)가 필요합니다.");
    const r = await salesSummary(env, o.from, o.to, { top: Math.min(2000, Math.max(1, parseInt(o.top) || 500)) });
    if (!o.slips) delete r.slips;
    return { content: [{ type: "text", text: JSON.stringify(r) }] };
  }
  // 거래처 주문 주기(캠퍼스 이탈 레이더·섬 날씨) — "_cadence" (최근 400일) / "_cadence:YYYY-MM-DD~YYYY-MM-DD"
  if (section === "_cadence" || section.startsWith("_cadence:")) {
    const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
    const m = section.slice(9).match(/^(\d{4}-\d{2}-\d{2})~(\d{4}-\d{2}-\d{2})$/);
    const from = m ? m[1] : new Date(Date.now() + 9 * 3600e3 - 399 * 86400e3).toISOString().slice(0, 10), to = m ? m[2] : today;
    return { content: [{ type: "text", text: JSON.stringify(await salesCadence(env, from, to)) }] };
  }
  // 판매현황 줄 목록(캠퍼스 판매현황 창·AI 직원) — "_salesrows:" + JSON {from,to,q,client,name,offset,limit} → 줄마다 d(날짜)·i(그날 안 순번)
  if (section.startsWith("_salesrows:")) {
    let o = {}; try { o = JSON.parse(section.slice(11)); } catch { return errContent("_salesrows 인자 JSON 이 잘못됐습니다."); }
    return { content: [{ type: "text", text: JSON.stringify(await salesRows(env, o || {})) }] };
  }
  // 출고(판매) 추정 — "_ecount:moves" (최근 30일) / "_ecount:moves:7" / "_ecount:moves:2026-10-01~2026-10-31"
  if (section === "_ecount:moves" || section.startsWith("_ecount:moves:")) {
    const arg = section.slice(14).replace(/^:/, "");
    const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
    let from, to = today;
    const m = arg.match(/^(\d{4}-\d{2}-\d{2})~(\d{4}-\d{2}-\d{2})$/);
    if (m) { from = m[1]; to = m[2]; }
    else { const n = Math.max(1, Math.min(366, Number(arg) || 30)); from = new Date(Date.now() + 9 * 3600e3 - (n - 1) * 86400e3).toISOString().slice(0, 10); }
    const r = await stockMoves(env, from, to);
    return { content: [{ type: "text", text: JSON.stringify({ 안내: "이카운트 새로고침 사이 재고 감소=출고(판매 추정), 증가=입고. 새로고침한 날짜 기준", ...r, products: r.products.slice(0, 60) }) }] };
  }
  if (section === "_ecount:sync" || section === "_ecount:refresh") return textContent(await ecountRequest(env, "claude"));
  if (section === "_stock") {
    const st = await fbGet("/frw/stock", env.FIREBASE_DB_SECRET);
    const items = asList(st && st.items).map((i) => ({ 코드: i.code, 품명: i.name, 수량: toNumber(i.qty), 안전재고: i.safeQty === "" || i.safeQty == null ? null : toNumber(i.safeQty), ...(i.adjustedAt ? { 조정: i.adjustedAt, 조정사유: i.adjustNote || "" } : {}) }));
    return textContent({ 반영시각: (st && st.updatedAt) || null, 품목수: items.length, 품목: items, 조정가능: true });
  }
  // 커넥터가 record_intake 를 아직 못 볼 때의 우회: section = "_intake:" + JSON 인자
  if (section.startsWith("_write:")) {
    let a; try { a = JSON.parse(section.slice(7)); } catch { return errContent("_write 인자 JSON 이 잘못됐습니다."); }
    return await toolCampusWrite(a || {}, env);
  }
  // 응답은 들여쓰기 없이(작게) — 큰 응답은 커넥터 중간에서 잘리거나 거절될 수 있다
  const compact = (o) => ({ content: [{ type: "text", text: JSON.stringify(o) }] });
  if (section === "_deposit_inbox" || section.startsWith("_deposit_inbox:")) {
    let o = {}; if (section.length > 15) { try { o = JSON.parse(section.slice(15)); } catch {} }
    return compact(await depositInbox(env, o));
  }
  if (section.startsWith("_unpaid:")) return compact(await unpaidOf(env, section.slice(8)));
  // 공급처 미지급 정산(결제원장) — 매입 현황 자동 집계(VAT 포함) + 수동 매입 − 지급 = 미지급잔액
  if (section.startsWith("_payables:")) return compact(await payablesOf(env, section.slice(10)));
  // 발주 이력 조회(캠퍼스 견적·발주 담당): _polist 또는 _polist:<공급처/품목 검색어> — 최근 발주일 순 30건, 품목·단가 포함(본문 제외)
  if (section === "_polist" || section.startsWith("_polist:")) {
    const q = section.slice(8).trim().toLowerCase().replace(/\s+/g, "");
    const hit = (p) => !q || [p.supplier && p.supplier.name, p.title, ...asList(p.items).map((i) => i.name)].some((x) => String(x || "").toLowerCase().replace(/\s+/g, "").includes(q));
    const pos = asList(await fbGet("/frw/purchaseOrders", env.FIREBASE_DB_SECRET)).filter(hit)
      .sort((x, y) => String(y.orderDate || y.dateStr || "").localeCompare(String(x.orderDate || x.dateStr || ""))).slice(0, 30);
    return compact(pos.map((p) => ({ id: p.id, 제목: p.title || "", 발주일: p.orderDate || p.dateStr || "", 납기: p.deliveryDate || "", 공급처: (p.supplier && p.supplier.name) || "",
      품목: asList(p.items).map((i) => ({ 이름: i.name || "", 단위: i.unit || "", 수량: toNumber(i.qty), 단가: toNumber(i.unitPrice), 입고: i.receivedQty ?? "", 요청: i.memo || "" })),
      합계: toNumber(p.totalAmount), 결제조건: p.paymentTerms || "", 납품장소: p.deliveryPlace || "", 메모: p.memo || "", 캠퍼스: !!p.fromCampus })));
  }
  // 판매 현황(orders) — 캠퍼스 판매현황 창·AI 직원: 필터 + 제품별·거래처별·월별 합계 + 행 페이지 (+ names: 매칭용 제품·거래처 이름)
  if (section === "_orders" || section.startsWith("_orders:")) {
    let o = {}; if (section.length > 8) { try { o = JSON.parse(section.slice(8)); } catch { return errContent("_orders 인자 JSON 이 잘못됐습니다."); } }
    return compact(await ordersRead(env, o || {}));
  }
  // 인사 관리 — 직원 목록 + 급여대장 (선택: "_hr:2026-10" 이면 그 달 기록까지)
  if (section === "_hr" || section.startsWith("_hr:")) return compact(await hrRead(env, section.slice(4) || ""));
  // 일정 전체(최근 60일~앞으로 60일, 미완료 우선) — AI 직원 조회용
  // 캠퍼스 일정 달력: 그 달에 걸치는 일정(앞뒤 7일 여유) 전체 필드
  if (section.startsWith("_cal:")) {
    const ym = section.slice(5).trim(); if (!/^\d{4}-\d{2}$/.test(ym)) return errContent("_cal:YYYY-MM 형식입니다.");
    const t = asList(await fbGet("/frw/todos", env.FIREBASE_DB_SECRET));
    const lo = addDays(`${ym}-01`, -7), hi = addDays(`${ym}-28`, 14);
    const rows = t.filter((x) => x && x.date && x.date <= hi && (x.endDate || x.date) >= lo)
      .sort((a, b) => String(a.date).localeCompare(String(b.date)) || (a.createdAt || 0) - (b.createdAt || 0))
      .map((x) => ({ id: x.id, date: x.date, endDate: x.endDate || "", text: String(x.text || "").slice(0, 300), memo: String(x.memo || "").slice(0, 1500), done: !!x.done, category: x.category || "", auto: !!(x.isAuto || x.recurringId) }));
    const tx = asList(await fbGet("/frw/taxes", env.FIREBASE_DB_SECRET));
    const taxes = tx.filter((x) => x && x.dueDate && x.dueDate >= lo && x.dueDate <= hi)
      .map((x) => ({ id: x.id, date: x.dueDate, type: x.taxType || "세금", biz: x.biz || "", amount: toNumber(x.amount), period: x.period || "", paid: x.paidDate || "" }));
    return textContent({ 오늘: kstToday(), 월: ym, 건수: rows.length, rows, taxes });
  }
  if (section === "_todos") {
    const t = asList(await fbGet("/frw/todos", env.FIREBASE_DB_SECRET)); const now = kstToday();
    const lo = addDays(now, -60), hi = addDays(now, 60);
    const rows = t.filter((x) => x.date && x.date >= lo && x.date <= hi).sort((a, b) => String(a.date).localeCompare(String(b.date)))
      .map((x) => ({ id: x.id, 날짜: x.date, 내용: String(x.text || "").slice(0, 120), 완료: !!x.done }));
    return textContent({ 오늘: now, 건수: rows.length, 일정: rows });
  }
  // AI 직원 외부 정보: 웹 검색(Brave Search API, 시크릿 SEARCH_API_KEY 필요)과 공개 페이지 읽기
  if (section.startsWith("_web:")) return compact(await webSearch(section.slice(5), env));
  if (section.startsWith("_fetch:")) return compact(await webRead(section.slice(7)));
  // 깊은 리서치: Anthropic API(웹 검색 도구 포함)를 서버가 직접 부른다 — 유료, ANTHROPIC_API_KEY 필요
  if (section.startsWith("_research:")) return compact(await claudeResearch(section.slice(10), env));
  if (section.startsWith("_intake:")) {
    let a; try { a = JSON.parse(section.slice(8)); } catch { return errContent("_intake 인자 JSON 이 잘못됐습니다."); }
    return await toolRecordIntake(a || {}, env);
  }
  if (!ALLOWED_SECTIONS.includes(section)) {
    return errContent(`허용되지 않은 섹션: "${section}". 가능: ${ALLOWED_SECTIONS.join(", ")}`);
  }
  let data = await fbGet(`/frw/${section}`, env.FIREBASE_DB_SECRET);
  // products의 base64 이미지는 응답 폭증 방지를 위해 제거 (단가는 get_pricing 사용)
  if (section === "products" && Array.isArray(data)) {
    data = data.map((p) => (p && p.image) ? { ...p, image: "(이미지 생략)" } : p);
  }
  let text = JSON.stringify(data, null, 2);
  if (text.length > 60000) text = text.slice(0, 60000) + "\n... (잘림 — 데이터가 너무 큼)";
  return { content: [{ type: "text", text }] };
}

// ── NJ 캠퍼스 스냅샷 ──
// 큰 섹션(장부·재고·매입·일정)을 서버에서 줄여서 한 번에 넘긴다. get_business_section 은
// 60KB에서 잘리기 때문에 페이지가 원본을 직접 읽으면 최근 달이 빠진다.
const asList = (v) => (Array.isArray(v) ? v : v ? Object.values(v) : []).filter(Boolean);
function kstNow() {
  const d = new Date(Date.now() + 9 * 3600e3);
  return { ymd: d.toISOString().slice(0, 10), ym: d.toISOString().slice(0, 7), iso: d.toISOString().slice(0, 19) + "+09:00" };
}
function addDays(ymd, n) {
  const d = new Date(ymd + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10);
}

async function buildCampusSnapshot(env) {
  const S = env.FIREBASE_DB_SECRET;
  const get = (n) => fbGet(n, S).catch(() => null);
  const [ledgers, deposits, intakes, pos, stock, todos, taxes, notices, clients, materials, laborItems] = await Promise.all([
    get("/frw/ledgers"), get("/frw/bankDeposits"), get("/frw/fabricIntakes"), get("/frw/purchaseOrders"),
    get("/frw/stock"), get("/frw/todos"), get("/frw/taxes"), get("/tenders/notices"), get("/frw/clients"),
    get("/frw/materials"), get("/frw/laborItems"),
  ]);
  const now = kstNow();

  // 장부: 월별 공급가 합계(법인 거래 제외 = 나정), 법인 거래 건수, 미입금
  const months = Object.keys(ledgers || {}).filter((k) => /^\d{4}-\d{2}$/.test(k)).sort().slice(-8);
  const sales = months.map((m) => {
    const cs = asList(ledgers[m] && ledgers[m].clients);
    const nj = cs.filter((c) => c.status !== "법인 거래");
    const unpaid = nj.filter((c) => c.status === "미입금");
    const top = [...nj].sort((a, b) => toNumber(b.supply) - toNumber(a.supply)).slice(0, 5).map((c) => ({ name: c.name, supply: toNumber(c.supply) }));
    return {
      month: m, supply: nj.reduce((s, c) => s + toNumber(c.supply), 0), clients: nj.length,
      unpaidCount: unpaid.length, unpaidTotal: unpaid.reduce((s, c) => s + toNumber(c.total), 0),
      corpRows: cs.length - nj.length, top,
    };
  });

  // 입금: 사업자(nj/corp)별 월 합계 + 최근 12건 + 오늘
  const dep = asList(deposits && deposits.items).filter((d) => d.date);
  const depMonth = { nj: {}, corp: {} };
  for (const d of dep) {
    const b = d.biz === "corp" ? "corp" : "nj", m = String(d.date).slice(0, 7);
    depMonth[b][m] = (depMonth[b][m] || 0) + toNumber(d.amount);
  }
  dep.sort((a, b) => `${b.date} ${b.time || ""}`.localeCompare(`${a.date} ${a.time || ""}`));
  const today = dep.filter((d) => d.date === now.ymd);
  const deposit = {
    pendingCount: asList(deposits && deposits.items).filter((d) => d.status === "pending").length,
    byMonth: depMonth,
    today: { count: today.length, nj: today.filter((d) => d.biz !== "corp").reduce((s, d) => s + toNumber(d.amount), 0), corp: today.filter((d) => d.biz === "corp").reduce((s, d) => s + toNumber(d.amount), 0) },
    recent: dep.slice(0, 12).map((d) => ({ date: d.date, time: d.time || "", name: d.name || d.client || "", amount: toNumber(d.amount), biz: d.biz === "corp" ? "corp" : "nj" })),
    // 최근 처리된 입금(캠퍼스 입금 배 연출) — 처리 시각 최신 20건, 거래처는 처리할 때 연결한 이름
    doneRecent: dep.filter((d) => d.status === "done" && d.doneAt).sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0)).slice(0, 20)
      .map((d) => ({ id: d.id || "", client: d.client || "", name: d.name || "", amount: toNumber(d.amount), doneAt: d.doneAt, date: d.date })),
  };

  // 매입: 최근 내역, 공급처별 이번 달 합계, 아직 입고 안 된(주문완료) 건 = 진행 중
  const fi = asList(intakes).filter((r) => r.date).map((r) => ({ ...r, date: normalizeDate(r.date) }));
  fi.sort((a, b) => String(b.date).localeCompare(String(a.date)));
  const line = (r) => ({ id: r.id, date: r.date, supplier: r.supplier || "", item: r.materialName || "", qty: toNumber(r.qty), amount: toNumber(r.qty) * toNumber(r.unitPrice), status: r.status || "", note: r.note || "" });
  const bySupplier = {};
  for (const r of fi) {
    if (!String(r.date).startsWith(now.ym)) continue;
    const k = r.supplier || "기타"; bySupplier[k] = (bySupplier[k] || 0) + toNumber(r.qty) * toNumber(r.unitPrice);
  }
  const open = fi.filter((r) => r.status && r.status !== "입고완료").slice(0, 30).map(line);
  // 공급처별 가장 최근 기록과 가장 최근 입고완료 기록 (원단·부자재처럼 드문 공급처도 보이게)
  const last = {}, lastIn = {};
  for (const r of fi) {
    const k = r.supplier || "기타";
    if (!last[k]) last[k] = line(r);
    if (r.status === "입고완료" && !lastIn[k]) lastIn[k] = line(r);
  }
  const openTotal = fi.filter((r) => r.status && r.status !== "입고완료");
  const purchases = { recent: fi.slice(0, 15).map(line), open, openCount: openTotal.length, openQty: openTotal.reduce((s, r) => s + toNumber(r.qty), 0), monthBySupplier: bySupplier, last, lastIn };

  // 발주서: 최근 6건 요약 (본문 마크다운·첨부 제외)
  const poList = asList(pos).sort((a, b) => String(b.orderDate || "").localeCompare(String(a.orderDate || ""))).slice(0, 6).map((p) => ({
    date: p.orderDate || "", supplier: (p.supplier && p.supplier.name) || "", deliveryDate: p.deliveryDate || "",
    items: asList(p.items).slice(0, 4).map((i) => ({ name: i.name || "", qty: toNumber(i.qty), unit: i.unit || "" })),
    amount: asList(p.items).reduce((s, i) => s + toNumber(i.qty) * toNumber(i.unitPrice), 0),
  }));

  // 완제품 재고: 사이즈를 뗀 품명별 합계
  const items = asList(stock && stock.items);
  const groups = {};
  let low = 0;
  for (const it of items) {
    const q = toNumber(it.qty), base = String(it.name || it.code || "").replace(/\s*\[[^\]]*\]\s*$/, "").trim() || "기타";
    groups[base] = (groups[base] || 0) + Math.max(0, q);
    if (it.safeQty !== "" && it.safeQty != null && q <= toNumber(it.safeQty)) low++;
  }
  const neg = items.filter((i) => toNumber(i.qty) < 0);
  const stockOut = {
    negCount: neg.length, negTop: neg.slice(0, 8).map((i) => ({ name: i.name || i.code, qty: toNumber(i.qty) })),
    skus: items.length, totalQty: items.reduce((s, i) => s + Math.max(0, toNumber(i.qty)), 0), low,
    groups: Object.entries(groups).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([name, qty]) => ({ name, qty })),
    updatedAt: (stock && stock.updatedAt) || null,
  };

  // 일정: 오늘~7일 뒤, 미완료
  const until = addDays(now.ymd, 7);
  const upcoming = asList(todos).filter((t) => !t.done && t.date && t.date >= now.ymd && t.date <= until)
    .sort((a, b) => String(a.date).localeCompare(String(b.date))).slice(0, 10).map((t) => ({ date: t.date, text: String(t.text || "").slice(0, 80) }));
  const overdue = asList(todos).filter((t) => !t.done && t.date && t.date < now.ymd && t.date >= addDays(now.ymd, -14)).length;

  // 세무: 30일 안에 기한 도래, 미납
  const tax = asList(taxes).filter((t) => !t.paidDate && t.dueDate && t.dueDate >= addDays(now.ymd, -7) && t.dueDate <= addDays(now.ymd, 30))
    .sort((a, b) => String(a.dueDate).localeCompare(String(b.dueDate))).map((t) => ({ biz: t.biz, type: t.taxType, amount: toNumber(t.amount), due: t.dueDate }));

  // 입찰: 새 공고 수 + 마감 임박 3건
  const nts = asList(notices);
  // bidClseDt 는 "2026-10-10 10:00" 또는 "202610101000" 형태가 섞여 있어 숫자만 비교한다
  const dk = (s) => String(s || "").replace(/\D/g, "").slice(0, 12);
  const live = nts.filter((n) => dk(n.bidClseDt).slice(0, 8) >= now.ymd.replace(/-/g, "") && n.status !== "skipped");
  live.sort((a, b) => dk(a.bidClseDt).localeCompare(dk(b.bidClseDt)));
  const tenders = {
    newCount: nts.filter((n) => n.status === "new").length, openCount: live.length,
    soon: live.slice(0, 3).map((n) => ({ title: n.bidNtceNm, org: n.ntceInsttNm || n.dminsttNm || "", close: n.bidClseDt, status: n.status || "" })),
  };

  // 단가표 이름 — 붙여넣기 입고에서 회사앱과 같은 규칙으로 품목명을 맞추는 데 쓴다
  const catalog = {
    materials: asList(materials).filter((m) => m.name).map((m) => ({ name: m.name, unit: m.unit || "", price: toNumber(m.price) })),
    labor: asList(laborItems).filter((l) => l.name).map((l) => ({ name: l.name, unit: l.unit || "", price: toNumber(l.price) })),
  };
  return { catalog, asOf: now.iso, today: now.ymd, sales, deposit, purchases, purchaseOrders: poList, stock: stockOut, todos: { upcoming, overdue }, taxes: tax, tenders, clientCount: asList(clients).length };
}

async function toolGetPricing(args, env) {
  // 임시 우회: 커넥터가 새 도구(list_backups/get_backup_section)를 아직 못 보므로
  // query 가 "__backup" 으로 시작하면 백업 조회로 넘긴다. 읽기 전용. 복구가 끝나면 제거.
  //   __backup:list            → 슬롯 목록
  //   __backup:<slot>:<section>[:summary] → 그 슬롯의 섹션 (summary 면 요척서 수만)
  const q0 = String(args.query || "");
  if (q0.startsWith("__backup")) {
    const parts = q0.split(":");
    if (parts[1] === "list") return await toolListBackups({ limit: Number(parts[2]) || 60 }, env);
    // __backup:sync → 동기화 안전장치 상태 점검 (섹션별 rev 와 내용 지문). 읽기 전용.
    if (parts[1] === "sync") {
      const [revs, sigs] = await Promise.all([
        fbGet("/frw/_revs", env.FIREBASE_DB_SECRET),
        fbGet("/frw/_sigs", env.FIREBASE_DB_SECRET),
      ]);
      const keys = Object.keys(sigs || {});
      return textContent({ revs: revs || {}, sigs: sigs || {}, sigSections: keys.length });
    }
    // __backup:<slot>:products:diff → 백업 vs 현재(live) 제품별 요척서 차이 (읽기 전용)
    if (parts[1] && parts[2] === "products" && parts[3] === "diff") {
      const [bak, live] = await Promise.all([
        fbGet(`/frw_backup_${parts[1]}/products`, env.FIREBASE_DB_SECRET),
        fbGet("/frw/products", env.FIREBASE_DB_SECRET),
      ]);
      const strip = (p) => { const { image, ...r } = p || {}; return r; };
      const byId = (arr) => { const m = new Map(); (Array.isArray(arr) ? arr : []).forEach((p) => p && m.set(String(p.id), p)); return m; };
      const B = byId(bak), L = byId(live);
      const out = [];
      const ids = new Set([...B.keys(), ...L.keys()]);
      for (const id of ids) {
        const b = B.get(id), l = L.get(id);
        if (!b || !l) { out.push({ id, name: (b || l).name, onlyIn: b ? "backup" : "live" }); continue; }
        const bs = new Map((b.specs || []).map((s) => [String(s.id), s]));
        const ls = new Map((l.specs || []).map((s) => [String(s.id), s]));
        const onlyBackup = [...bs.keys()].filter((k) => !ls.has(k)).map((k) => ({ id: k, name: bs.get(k).name }));
        const onlyLive = [...ls.keys()].filter((k) => !bs.has(k)).map((k) => ({ id: k, name: ls.get(k).name }));
        const changedShared = [...bs.keys()].filter((k) => ls.has(k) && JSON.stringify(bs.get(k)) !== JSON.stringify(ls.get(k))).map((k) => ({ id: k, backupName: bs.get(k).name, liveName: ls.get(k).name }));
        const fieldDiff = ["name", "marketPrice", "memo", "category", "include", "activeSpecId", "deliverySpecId"].filter((f) => JSON.stringify(b[f]) !== JSON.stringify(l[f])).map((f) => ({ field: f, backup: b[f], live: l[f] }));
        if (onlyBackup.length || onlyLive.length || changedShared.length || fieldDiff.length) out.push({ id, name: l.name, onlyBackup, onlyLive, changedShared, fieldDiff });
      }
      return textContent({ slot: parts[1], backupCount: B.size, liveCount: L.size, differences: out });
    }
    if (parts[1] && parts[2]) return await toolGetBackupSection({ slot: parts[1], section: parts[2], summaryOnly: parts[3] === "summary" }, env);
    return errContent("__backup:list 또는 __backup:<slot>:<section>[:summary]");
  }
  const [products, materials, laborItems] = await Promise.all([
    fbGet("/frw/products", env.FIREBASE_DB_SECRET),
    fbGet("/frw/materials", env.FIREBASE_DB_SECRET),
    fbGet("/frw/laborItems", env.FIREBASE_DB_SECRET),
  ]);
  const prods = Array.isArray(products) ? products : products ? Object.values(products) : [];
  const mats = Array.isArray(materials) ? materials : materials ? Object.values(materials) : [];
  const labor = Array.isArray(laborItems) ? laborItems : laborItems ? Object.values(laborItems) : [];
  const q = (args.query || "").trim().toLowerCase();
  let filtered = prods.filter((p) => p && p.include !== false);
  if (q) filtered = filtered.filter((p) => (p.name || "").toLowerCase().includes(q));
  const round = (n) => Math.round(n || 0);
  const grade = String(args.grade || "").trim().toUpperCase().replace(/급$/, "");
  const gradeMap = (c) => { const o = {}; for (const g of c.gradeList) o[g] = round(c.grades[g]); return o; };
  const out = filtered.map((p) => {
    const { spec, basis } = getPricingSpec(p);
    const c = computeProduct(p, mats, labor, spec);
    const row = {
      제품명: p.name,
      요척서: spec && spec.name ? spec.name : "",
      기준: basis,
      원가: round(c.base),
      관리비포함원가: round(c.beforeMargin),
      등급단가: gradeMap(c),
      선택등급: c.selectedGrade,
    };
    // 시장 소비자가(단가표 하단 판매가) — 앱 getMarketPrice 와 같게 활성 요척서 값, 없으면 제품 값. 비어 있으면 넣지 않는다
    { const as = getActiveSpec(p), mv = as && as !== p && as.marketPrice !== undefined ? as.marketPrice : p.marketPrice;
      const mp = parseFloat(String(mv ?? "").replace(/[^\d.]/g, "")); if (mp > 0) row.시장소비자가 = round(mp); }
    if (grade) row.단가 = c.grades[grade] != null ? round(c.grades[grade]) : null;
    if (args.allSpecs && Array.isArray(p.specs) && p.specs.length > 1) {
      row.다른요척서 = p.specs.filter((s) => s !== spec).map((s) => ({ 요척서: s.name, 등급단가: gradeMap(computeProduct(p, mats, labor, s)) }));
    }
    return row;
  });
  const result = { 제품수: out.length, 제품: out };
  const unset = out.filter((r) => r.기준 !== "납품가").map((r) => r.제품명);
  if (unset.length) result.안내 = `납품가 요척서가 지정되지 않은 제품 ${unset.length}개는 화면에서 마지막으로 본 요척서 기준입니다: ${unset.join(", ")}`;
  if (grade && out.some((r) => r.단가 == null)) result.등급안내 = `'${grade}' 등급이 없는 제품은 단가가 null 입니다`;
  return textContent(result);
}

// ── 회사앱 동기화 규약을 지키는 서버 쓰기 ──
// 앱은 섹션별 _revs 로 "누가 바꿨는지"를 알아챈다. 서버가 데이터만 고치고 rev 를 안 올리면
// 옛 복사본을 쥔 기기가 그대로 덮어쓸 수 있다(요척서 유실과 같은 기제). 그래서:
//   ① 데이터 PATCH(+_sigs) → ② rev 를 조건부(if-match)로 +1 → ③ 다시 읽어 반영됐는지 확인,
//   빠졌으면(그 사이 다른 기기가 덮음) 처음부터 다시. 변경은 id·토큰 기준이라 여러 번 적용해도 한 번과 같다.
function sectionSignature(v) {   // index.html 의 같은 함수와 동일해야 한다
  const recs = Array.isArray(v) ? v : (v && typeof v === "object" ? Object.keys(v).filter((k) => k !== "gone").map((k) => v[k]) : []);
  let n = 0, m = 0, a = 0;
  for (const r of recs) {
    n++;
    if (r && typeof r === "object" && !Array.isArray(r)) for (const k of Object.keys(r)) if (Array.isArray(r[k])) m += r[k].length;
    if (Array.isArray(r)) a += r.length;
  }
  return { n, m, a };
}
async function fbGetTagged(node, secret) {
  const res = await fetch(`https://${FB_HOST}${node}.json?auth=${encodeURIComponent(secret)}`, { headers: { "X-Firebase-ETag": "true" } });
  if (!res.ok) throw new Error(`Firebase ${res.status}`);
  return { etag: res.headers.get("ETag"), value: await res.json() };
}
async function fbPutIfMatch(node, value, etag, secret) {
  const res = await fetch(`https://${FB_HOST}${node}.json?auth=${encodeURIComponent(secret)}`, {
    method: "PUT", headers: { "Content-Type": "application/json", "if-match": etag }, body: JSON.stringify(value),
  });
  if (res.status === 412) return false;
  if (!res.ok) throw new Error(`Firebase ${res.status}`);
  return true;
}
// mutate(data) → { patch: {상대키: 값}, check(data2): boolean, result } | { done:true, result }
async function safeSectionWrite(section, mutate, env) {
  const S = env.FIREBASE_DB_SECRET;
  for (let attempt = 0; attempt < 4; attempt++) {
    const data = await fbGet(`/frw/${section}`, S);
    const plan = mutate(data);
    if (plan.isError || plan.done) return plan;
    const next = plan.apply(data);              // 적용 후 섹션 전체 (지문 계산용)
    const body = {};
    if (plan.replace) body[section] = next;               // 삭제처럼 배열을 다시 써야 할 때만(섹션 전체)
    else for (const [k, v] of Object.entries(plan.patch)) body[`${section}/${k}`] = v;
    body[`_sigs/${section}`] = sectionSignature(next);
    await fbPatch(`/frw`, body, S);
    let bumped = false;
    for (let i = 0; i < 5 && !bumped; i++) {
      const { etag, value } = await fbGetTagged(`/frw/_revs/${section}`, S);
      bumped = await fbPutIfMatch(`/frw/_revs/${section}`, (Number(value) || 0) + 1, etag, S);
    }
    if (!bumped) throw new Error("rev 갱신 충돌이 계속됩니다");
    const after = await fbGet(`/frw/${section}`, S);
    if (plan.check(after)) return plan;
  }
  throw new Error("다른 기기의 저장과 계속 겹쳐 반영하지 못했습니다. 잠시 뒤 다시 시도해 주세요.");
}

function kstToday() { return new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10); }
async function toolRecordIntake(args, env) {
  const mode = String(args.mode || "");
  const qty = Number(args.qty);
  if (mode !== "batch" && (!(qty > 0) || !Number.isFinite(qty))) return errContent("qty 는 0보다 큰 숫자여야 합니다.");
  const date = args.date ? String(args.date) : kstToday();
  if (!isRealDate(date)) return errContent(`date 가 잘못됐습니다: "${date}"`);
  const token = String(args.token || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`).slice(0, 64);
  const note = args.note != null ? String(args.note).slice(0, 120) : null;
  const list = (d) => (Array.isArray(d) ? d.map((r, i) => [String(i), r]) : Object.entries(d || {})).filter(([, r]) => r);
  const nextKey = (d) => (Array.isArray(d) || d == null ? String(Array.isArray(d) ? d.length : 0) : `c${Date.now()}`);
  const hasToken = (d) => list(d).some(([, r]) => r.campusToken === token);
  const newId = (d) => { const ids = new Set(list(d).map(([, r]) => String(r.id))); let id = Date.now(); while (ids.has(String(id))) id++; return id; };
  const withRow = (d, key, row) => { if (Array.isArray(d) || d == null) { const a = [...(d || [])]; a[Number(key)] = row; return a; } return { ...d, [key]: row }; };

  if (mode === "new") {
    const supplier = String(args.supplier || "").trim(), materialName = String(args.materialName || "").trim();
    if (!supplier || !materialName) return errContent("새 입고에는 supplier(공급처)와 materialName(품목)이 필요합니다.");
    const plan = await safeSectionWrite("fabricIntakes", (d) => {
      if (hasToken(d)) return { done: true, result: { 결과: "이미 반영됨 (같은 요청)" } };
      const key = nextKey(d);
      const row = { id: newId(d), date, supplier, inspector: "", materialName, qty: String(qty), unit: String(args.unit || ""),
        unitPrice: args.unitPrice != null && args.unitPrice !== "" ? String(args.unitPrice) : "", status: "입고완료",
        note: note || "", receivedAt: date, campusToken: token, fromCampus: true };
      return { patch: { [key]: row }, apply: (dd) => withRow(dd, key, row), check: hasToken, result: { 결과: "새 입고 등록", 행: row } };
    }, env);
    return plan.isError ? plan : textContent(plan.result);
  }

  if (mode === "batch") {
    const supplier = String(args.supplier || "").trim();
    const rows = Array.isArray(args.rows) ? args.rows.slice(0, 80) : [];
    if (!supplier) return errContent("일괄 입고에는 supplier(공급처)가 필요합니다.");
    const clean = rows.map((r) => ({ name: String(r.materialName || "").trim(), qty: Number(r.qty), unit: String(r.unit || ""),
      price: r.unitPrice != null && r.unitPrice !== "" ? String(r.unitPrice) : "", status: r.status === "주문완료" ? "주문완료" : "입고완료",
      note: r.note != null ? String(r.note).slice(0, 120) : "" })).filter((r) => r.name && r.qty > 0);
    if (!clean.length) return errContent("기록할 행이 없습니다 (품목명과 0보다 큰 수량 필요).");
    const plan = await safeSectionWrite("fabricIntakes", (d) => {
      if (hasToken(d)) return { done: true, result: { 결과: "이미 반영됨 (같은 요청)" } };
      let id = newId(d), base = Array.isArray(d) || d == null ? (d ? d.length : 0) : null;
      const patch = {}, made = [];
      clean.forEach((r, i) => {
        const key = base != null ? String(base + i) : `c${Date.now()}_${i}`;
        const row = { id: id++, date, supplier, inspector: String(args.inspector || ""), materialName: r.name, qty: String(r.qty), unit: r.unit,
          unitPrice: r.price, status: r.status, note: r.note, campusToken: i === 0 ? token : `${token}#${i}`, fromCampus: true,
          ...(r.status === "입고완료" ? { receivedAt: date } : {}) };
        patch[key] = row; made.push(row);
      });
      const apply = (dd) => { let out = dd; for (const [k, v] of Object.entries(patch)) out = withRow(out, k, v); return out; };
      return { patch, apply, check: hasToken, result: { 결과: `${made.length}건 일괄 등록`, 행수: made.length } };
    }, env);
    return plan.isError ? plan : textContent(plan.result);
  }

  if (mode === "receive") {
    if (args.id === undefined || args.id === null || String(args.id) === "") return errContent("receive 에는 id 가 필요합니다.");
    const want = String(args.id);
    const plan = await safeSectionWrite("fabricIntakes", (d) => {
      if (hasToken(d)) return { done: true, result: { 결과: "이미 반영됨 (같은 요청)" } };
      const hit = list(d).find(([, r]) => String(r.id) === want);
      if (!hit) return errContent(`매입현황에 id=${want} 인 행이 없습니다.`);
      const [key, cur] = hit;
      if (cur.status === "입고완료") return errContent("이미 입고완료된 행입니다.");
      const ordered = toNumber(cur.qty);
      const extra = note ? ` · ${note}` : "";
      if (qty >= ordered) {
        const row = { ...cur, qty: String(qty), status: "입고완료", receivedAt: date, campusToken: token,
          note: `${cur.note || ""}${extra}`.trim() };
        return { patch: { [key]: row }, apply: (dd) => withRow(dd, key, row), check: hasToken,
          result: { 결과: "입고완료 처리", 행: row, 주문수량: ordered } };
      }
      // 일부 입고: 받은 만큼 새 입고완료 행, 원래 행은 남은 수량으로 줄여 주문완료 유지
      const rest = { ...cur, qty: String(ordered - qty) };
      const nkey = nextKey(d);
      const got = { ...cur, id: newId(d), qty: String(qty), status: "입고완료", receivedAt: date, campusToken: token, splitFrom: cur.id,
        note: `${cur.note || ""} · 부분입고 ${qty}/${ordered}${extra}`.trim() };
      return { patch: { [key]: rest, [nkey]: got }, apply: (dd) => withRow(withRow(dd, key, rest), nkey, got), check: hasToken,
        result: { 결과: "부분 입고", 입고행: got, 남은행: rest } };
    }, env);
    return plan.isError ? plan : textContent(plan.result);
  }
  return errContent('mode 는 "receive" 또는 "new" 여야 합니다.');
}

// ── AI 직원 쓰기 (캠퍼스 페이지가 사용자 승인 뒤에만 부른다) ──
// 장부 입금 상태: ledgers/<월>/clients/<i> 의 status·memo 만 바꾼다
async function toolLedgerStatus(a, env) {
  const month = String(a.month || ""), name = String(a.name || "").trim(), status = String(a.status || "");
  if (!/^\d{4}-\d{2}$/.test(month)) return errContent("month 는 YYYY-MM 입니다.");
  if (!name) return errContent("거래처 이름(name)이 필요합니다.");
  if (!["입금완료", "미입금"].includes(status)) return errContent('status 는 "입금완료" 또는 "미입금" 입니다.');
  const token = String(a.token || `${Date.now()}`).slice(0, 64), memo = a.memo ? String(a.memo).slice(0, 120) : "";
  const plan = await safeSectionWrite("ledgers", (d) => {
    const L = d && d[month]; const arr = L && L.clients;
    const list = Array.isArray(arr) ? arr.map((r, i) => [String(i), r]) : Object.entries(arr || {});
    let hit = list.find(([, r]) => r && String(r.name || "").trim() === name);
    if (!hit) { const c = list.filter(([, r]) => r && String(r.name || "").includes(name)); if (c.length === 1) hit = c[0]; else if (c.length > 1) return errContent(`'${name}' 이(가) 여러 거래처와 겹칩니다: ${c.map(([, r]) => r.name).join(", ")}`); }
    if (!hit) return errContent(`${month} 장부에 '${name}' 거래처가 없습니다.`);
    const [k, cur] = hit;
    if (cur.status === "법인 거래") return errContent("법인 거래 행은 바꾸지 않습니다.");
    if (cur.status === status && !memo) return { done: true, result: { 결과: "변경 없음", 거래처: cur.name, 상태: status } };
    const row = { ...cur, status, memo: memo ? `${cur.memo ? cur.memo + " / " : ""}${memo}` : (cur.memo || ""), campusToken: token };
    const key = `${month}/clients/${k}`;
    const apply = (dd) => { const o = { ...(dd || {}) }; const m = { ...(o[month] || {}) }; const cl = Array.isArray(m.clients) ? [...m.clients] : { ...(m.clients || {}) }; cl[k] = row; m.clients = cl; o[month] = m; return o; };
    const check = (dd) => { const r = dd && dd[month] && dd[month].clients && dd[month].clients[k]; return !!r && r.campusToken === token; };
    return { patch: { [key]: row }, apply, check, result: { 결과: "장부 상태 변경", 월: month, 거래처: cur.name, 이전: cur.status, 변경: status, 공급가: toNumber(cur.supply) } };
  }, env);
  return plan.isError ? plan : textContent(plan.result);
}
// 일정: 추가 / 완료 체크
async function toolTodo(a, env) {
  const token = String(a.token || `${Date.now()}`).slice(0, 64);
  const list = (d) => (Array.isArray(d) ? d.map((r, i) => [String(i), r]) : Object.entries(d || {})).filter(([, r]) => r);
  if (a.op === "todo_add") {
    const date = String(a.date || kstToday()), text = String(a.text || "").trim();
    if (!isRealDate(date)) return errContent("date 는 YYYY-MM-DD 입니다.");
    if (!text) return errContent("할 일 내용(text)이 필요합니다.");
    const plan = await safeSectionWrite("todos", (d) => {
      if (list(d).some(([, r]) => r.campusToken === token)) return { done: true, result: { 결과: "이미 반영됨" } };
      const key = Array.isArray(d) || d == null ? String(d ? d.length : 0) : `c${Date.now()}`;
      const ids = new Set(list(d).map(([, r]) => String(r.id))); let id = Date.now(); while (ids.has(String(id))) id++;
      let end = a.endDate && isRealDate(String(a.endDate)) ? String(a.endDate) : ""; let start = date; if (end && end < start) { const x = start; start = end; end = x; } if (end === start) end = "";
      const row = { id, date: start, endDate: end, text: text.slice(0, 200), memo: a.memo ? String(a.memo).slice(0, 1500) : "", done: false, createdAt: Date.now(), atts: [], campusToken: token, fromCampus: true };
      const apply = (dd) => { if (Array.isArray(dd) || dd == null) { const x = [...(dd || [])]; x[Number(key)] = row; return x; } return { ...dd, [key]: row }; };
      return { patch: { [key]: row }, apply, check: (dd) => list(dd).some(([, r]) => r.campusToken === token), result: { 결과: "일정 추가", 일정: { 날짜: date, 내용: row.text } } };
    }, env);
    return plan.isError ? plan : textContent(plan.result);
  }
  if (a.op === "todo_done") {
    const want = String(a.id || ""); const done = a.done !== false;
    if (!want) return errContent("완료할 일정의 id 가 필요합니다.");
    const plan = await safeSectionWrite("todos", (d) => {
      const hit = list(d).find(([, r]) => String(r.id) === want); if (!hit) return errContent(`일정 id=${want} 이(가) 없습니다.`);
      const [k, cur] = hit; if (!!cur.done === done) return { done: true, result: { 결과: "변경 없음", 내용: cur.text } };
      const row = { ...cur, done, campusToken: token };
      const apply = (dd) => { if (Array.isArray(dd)) { const x = [...dd]; x[Number(k)] = row; return x; } return { ...dd, [k]: row }; };
      return { patch: { [k]: row }, apply, check: (dd) => { const r = list(dd).find(([, x]) => String(x.id) === want); return !!r && r[1].campusToken === token; }, result: { 결과: done ? "완료 체크" : "완료 해제", 내용: cur.text } };
    }, env);
    return plan.isError ? plan : textContent(plan.result);
  }
  if (a.op === "todo_update") {
    const want = String(a.id || ""); if (!want) return errContent("고칠 일정의 id 가 필요합니다.");
    const plan = await safeSectionWrite("todos", (d) => {
      const hit = list(d).find(([, r]) => String(r.id) === want); if (!hit) return errContent(`일정 id=${want} 이(가) 없습니다.`);
      const [k, cur] = hit; const row = { ...cur, campusToken: token };
      if (a.text != null) { const tx = String(a.text).trim(); if (!tx) return errContent("내용이 비었습니다."); row.text = tx.slice(0, 200); }
      if (a.memo != null) row.memo = String(a.memo).slice(0, 1500);
      if (a.date != null) { if (!isRealDate(String(a.date))) return errContent("date 는 YYYY-MM-DD 입니다."); row.date = String(a.date); }
      if (a.endDate != null) row.endDate = a.endDate && isRealDate(String(a.endDate)) ? String(a.endDate) : "";
      if (row.endDate && row.endDate < row.date) { const x = row.date; row.date = row.endDate; row.endDate = x; } if (row.endDate === row.date) row.endDate = "";
      if (a.done != null) row.done = !!a.done;
      const apply = (dd) => { if (Array.isArray(dd)) { const x = [...dd]; x[Number(k)] = row; return x; } return { ...dd, [k]: row }; };
      return { patch: { [k]: row }, apply, check: (dd) => { const r = list(dd).find(([, x]) => String(x.id) === want); return !!r && r[1].campusToken === token; }, result: { 결과: "일정 수정", 일정: { 날짜: row.date, 종료: row.endDate, 내용: row.text } } };
    }, env);
    return plan.isError ? plan : textContent(plan.result);
  }
  if (a.op === "todo_delete") {
    const want = String(a.id || ""); if (!want) return errContent("지울 일정의 id 가 필요합니다.");
    const plan = await safeSectionWrite("todos", (d) => {
      const hit = list(d).find(([, r]) => String(r.id) === want); if (!hit) return { done: true, result: { 결과: "이미 없음" } };
      const keep = list(d).map(([, r]) => r).filter((r) => String(r.id) !== want);
      const apply = () => keep;
      return { replace: true, patch: {}, apply, check: (dd) => !list(dd).some(([, r]) => String(r.id) === want), result: { 결과: "일정 삭제", 내용: hit[1].text } };
    }, env);
    return plan.isError ? plan : textContent(plan.result);
  }
  return errContent("알 수 없는 일정 작업");
}
// ── 입금내역 처리 (회사앱 입금내역 탭과 같은 규칙) ──
// index.html 의 payablesNameNorm / payablesNameMatch / fbEscKey 와 같아야 한다.
const payNorm = (s) => String(s || "").replace(/\(주\)|（주）|㈜|주식회사/g, "").replace(/[\s()（）\[\],.·]/g, "").toLowerCase();
const payMatch = (a, b) => { const x = payNorm(a), y = payNorm(b); if (!x || !y) return false; return x === y || (x.length >= 3 && y.length >= 3 && (x.includes(y) || y.includes(x))); };
const FB_ESC = { "~": "~7E", ".": "~2E", "#": "~23", "$": "~24", "/": "~2F", "[": "~5B", "]": "~5D" };
const FB_UNESC = { "7E": "~", "2E": ".", "23": "#", "24": "$", "2F": "/", "5B": "[", "5D": "]" };
const fbEsc = (k) => String(k).replace(/[~.#$\/[\]]/g, (c) => FB_ESC[c]);
const fbUnesc = (k) => String(k).replace(/~([0-9A-F]{2})/g, (m, h) => FB_UNESC[h] || m);

const searchNorm = (t) => String(t || "").toLowerCase().replace(/[\s()（）\[\]{}<>.,·・‧\-_/\\'"]+/g, "");
const _CORP_WORDS = /주식회사|유한책임회사|유한회사|합자회사|합명회사|재단법인|사단법인|농업회사법인|영농조합법인|협동조합/g;
const _CORP_MARKS = /㈜|㈔|\((?:주|유|합|재|사)\)|（(?:주|유|합|재|사)）/g;
const _CORP_DOT = /(^|[\s·,])(?:주|유|합|재|사)[.)]\s*/g;
const searchBare = (t) => searchNorm(String(t || "").replace(_CORP_WORDS, " ").replace(_CORP_MARKS, " ").replace(_CORP_DOT, "$1"));
const _CHO = ["ㄱ","ㄲ","ㄴ","ㄷ","ㄸ","ㄹ","ㅁ","ㅂ","ㅃ","ㅅ","ㅆ","ㅇ","ㅈ","ㅉ","ㅊ","ㅋ","ㅌ","ㅍ","ㅎ"];
const toChosung = (t) => { let o = ""; for (const ch of String(t || "")) { const c = ch.charCodeAt(0); o += (c >= 0xAC00 && c <= 0xD7A3) ? _CHO[Math.floor((c - 0xAC00) / 588)] : ch.toLowerCase(); } return o.replace(/\s+/g, ""); };
function depQueryMatcher(q) {
  const bare = String(q || "").trim(); if (!bare) return null;
  if (/^[ㄱ-ㅎ\s]{2,}$/.test(bare)) { const cho = bare.replace(/\s+/g, ""); return (txt) => toChosung(txt).includes(cho); }
  const toks = bare.split(/\s+/).filter(Boolean), tn = toks.map(searchNorm), tb = toks.map(searchBare);
  return (txt) => { const n = searchNorm(txt), b = searchBare(txt); return tn.every((t, i) => (t && n.includes(t)) || (tb[i] && b.includes(tb[i]))); };
}

async function depositInbox(env, opt = {}) {
  const S = env.FIREBASE_DB_SECRET;
  const [dep, ledgers, clients, ar] = await Promise.all([fbGet("/frw/bankDeposits", S), fbGet("/frw/ledgers", S), fbGet("/frw/clients", S), fbGet("/frw/clientAR", S)]);
  const items = asList(dep && dep.items);
  const nameMap = {}; for (const [k, v] of Object.entries((dep && dep.nameMap) || {})) nameMap[fbUnesc(k)] = v;
  const names = new Set();
  asList(clients).forEach((c) => c.name && names.add(String(c.name).trim()));
  Object.values(ledgers || {}).forEach((m) => asList(m && m.clients).forEach((c) => c.name && names.add(String(c.name).trim())));
  Object.keys(ar || {}).forEach((k) => names.add(fbUnesc(k).trim()));
  const clientNames = [...names].filter(Boolean).sort((a, b) => a.localeCompare(b, "ko"));
  const suggest = (n) => nameMap[payNorm(n)] || clientNames.find((c) => payMatch(c, n)) || "";
  const unpaid = {};
  Object.keys(ledgers || {}).sort().reverse().forEach((ym) => asList(ledgers[ym] && ledgers[ym].clients).forEach((c) => {
    if (c.status !== "미입금") return; const n = String(c.name || "").trim(); if (!n) return;
    (unpaid[n] = unpaid[n] || []).push({ ym, id: c.id, total: toNumber(c.total), supply: toNumber(c.supply) });
  }));
  // 날짜 표기가 섞여 있어도(2026-7-5 · 2026.07.05 · 20260705) 최신순이 맞게 숫자로 맞춘 키로 비교
  const dkey = (x) => { const m = String(x.date || "").match(/(\d{4})\D*(\d{1,2})\D*(\d{1,2})/); const t = String(x.time || "").match(/(\d{1,2})\D*(\d{2})?\D*(\d{2})?/);
    return (m ? m[1] + m[2].padStart(2, "0") + m[3].padStart(2, "0") : "00000000") + (t ? t[1].padStart(2, "0") + (t[2] || "00") + (t[3] || "00") : "000000"); };
  const byDate = (a, b) => dkey(b).localeCompare(dkey(a));
  const off = Math.max(0, Number(opt.offset) || 0), lim = Math.min(200, Math.max(1, Number(opt.limit) || 40));
  const bizF = opt.biz === "nj" || opt.biz === "corp" ? opt.biz : null;
  const qm = depQueryMatcher(opt.q);
  const pendAll = items.filter((x) => x.status === "pending" && (!bizF || (x.biz === "corp" ? "corp" : "nj") === bizF)
    && (!qm || qm([x.name, x.memo, suggest(x.name)].filter(Boolean).join("\u0001")))).sort(byDate);
  const pending = pendAll.slice(off, off + lim)
    .map((x) => ({ id: x.id, date: x.date, time: x.time || "", name: x.name || "", amount: toNumber(x.amount), biz: x.biz === "corp" ? "corp" : "nj", memo: x.memo || "", suggest: suggest(x.name) }));
  // 전체 보기(opt.all): 미처리·처리 구분 없이 최신순
  let all = null, allFiltered = 0;
  if (opt.all) {
    const allAll = items.filter((x) => (!bizF || (x.biz === "corp" ? "corp" : "nj") === bizF)
      && (!qm || qm([x.name, x.memo, x.client, suggest(x.name)].filter(Boolean).join("\u0001")))).sort(byDate);
    allFiltered = allAll.length;
    all = allAll.slice(off, off + lim).map((x) => ({ id: x.id, date: x.date, time: x.time || "", name: x.name || "", amount: toNumber(x.amount), biz: x.biz === "corp" ? "corp" : "nj", memo: x.memo || "",
      status: x.status === "done" ? "done" : "pending", client: x.client || "", link: x.link || null, doneAt: x.doneAt || null, suggest: x.status === "done" ? "" : suggest(x.name) }));
  }
  const done = items.filter((x) => x.status === "done").sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0)).slice(0, 15)
    .map((x) => ({ id: x.id, date: x.date, name: x.name || "", amount: toNumber(x.amount), client: x.client || "", link: x.link || null, doneAt: x.doneAt || null }));
  // 화면에 나온 입금의 추천 거래처 미입금 청구만 넘겨 응답을 작게 유지한다
  const need = new Set([...pending, ...(all || [])].map((x) => x.suggest).filter(Boolean));
  const unpaidSmall = {}; for (const n of need) if (unpaid[n]) unpaidSmall[n] = unpaid[n].filter((u) => u.total > 0).slice(0, 6);
  return { pendingCount: items.filter((x) => x.status === "pending").length, filtered: pendAll.length, filteredTotal: pendAll.reduce((t, x) => t + toNumber(x.amount), 0), offset: off, limit: lim, pending, done, ...(all ? { all, allFiltered, totalCount: items.length } : {}), unpaid: unpaidSmall, clientNames };
}
// 거래처 하나의 미입금 청구 (팝업에서 거래처를 바꿨을 때)
async function unpaidOf(env, name) {
  const L = await fbGet("/frw/ledgers", env.FIREBASE_DB_SECRET); const n = String(name || "").trim(); const out = [];
  Object.keys(L || {}).sort().reverse().forEach((ym) => asList(L[ym] && L[ym].clients).forEach((c) => { if (c.status === "미입금" && String(c.name || "").trim() === n && toNumber(c.total) > 0) out.push({ ym, id: c.id, total: toNumber(c.total), supply: toNumber(c.supply) }); }));
  return { name: n, unpaid: out.slice(0, 12) };
}

async function toolDepositProcess(a, env) {
  const S = env.FIREBASE_DB_SECRET;
  const want = String(a.depositId || ""), client = String(a.client || "").trim();
  const token = String(a.token || `${Date.now()}`).slice(0, 64);
  const link = a.link && typeof a.link === "object" ? a.link : { kind: "none" };
  if (!want) return errContent("depositId 가 필요합니다.");
  if (!client) return errContent("거래처(client)를 정해 주세요.");
  const bd = await fbGet("/frw/bankDeposits", S);
  const items = (bd && bd.items) || [];
  const ent = (Array.isArray(items) ? items.map((r, i) => [String(i), r]) : Object.entries(items)).find(([, r]) => r && String(r.id) === want);
  if (!ent) return errContent(`입금 id=${want} 이(가) 없습니다.`);
  const dep = ent[1];
  if (dep.status === "done") return dep.campusToken === token ? textContent({ 결과: "이미 반영됨" }) : errContent(`이미 처리된 입금입니다 (거래처: ${dep.client || "-"}).`);
  let finalLink = { kind: "none" };
  // ① 장부 청구 → 입금완료
  if (link.kind === "ledger") {
    const ym = String(link.ym || ""), cid = String(link.clientId || "");
    const r = await safeSectionWrite("ledgers", (d) => {
      const arr = d && d[ym] && d[ym].clients;
      const list = Array.isArray(arr) ? arr.map((x, i) => [String(i), x]) : Object.entries(arr || {});
      const hit = list.find(([, x]) => x && String(x.id) === cid);
      if (!hit) return errContent(`${ym} 장부에 해당 청구가 없습니다.`);
      const [k, cur] = hit;
      if (cur.status === "입금완료") return { done: true };
      if (cur.status !== "미입금") return errContent(`이 청구는 '${cur.status}' 상태라 바꾸지 않습니다.`);
      const row = { ...cur, status: "입금완료", campusToken: token };
      const apply = (dd) => { const o = { ...(dd || {}) }; const m = { ...(o[ym] || {}) }; const cl = Array.isArray(m.clients) ? [...m.clients] : { ...(m.clients || {}) }; cl[k] = row; m.clients = cl; o[ym] = m; return o; };
      return { patch: { [`${ym}/clients/${k}`]: row }, apply, check: (dd) => { const x = dd && dd[ym] && dd[ym].clients && dd[ym].clients[k]; return !!x && x.status === "입금완료"; } };
    }, env);
    if (r.isError) return r;
    finalLink = { kind: "ledger", ym, clientId: cid };
  } else if (link.kind === "ar") {
    // ② 미수금 원장에 입금 기록
    const key = fbEsc(client), entryId = Date.now();
    const r = await safeSectionWrite("clientAR", (d) => {
      const cur = (d && d[key]) || { entries: [] };
      const entries = Array.isArray(cur.entries) ? cur.entries : Object.values(cur.entries || {});
      if (entries.some((e) => e && e.campusToken === token)) return { done: true };
      const row = { id: entryId, type: "입금", desc: `은행입금 (${dep.name || ""})`, amount: toNumber(dep.amount), date: dep.date, campusToken: token };
      const next = { ...cur, entries: [...entries, row] };
      return { patch: { [key]: next }, apply: (dd) => ({ ...(dd || {}), [key]: next }),
        check: (dd) => { const c = dd && dd[key]; const es = c ? (Array.isArray(c.entries) ? c.entries : Object.values(c.entries || {})) : []; return es.some((e) => e && e.campusToken === token); } };
    }, env);
    if (r.isError) return r;
    finalLink = { kind: "ar", entryId };
  }
  // ③ 입금 행 처리완료 + 입금자명→거래처 기억
  const nmKey = fbEsc(payNorm(dep.name));
  const r3 = await safeSectionWrite("bankDeposits", (d) => {
    const its = (d && d.items) || [];
    const e = (Array.isArray(its) ? its.map((x, i) => [String(i), x]) : Object.entries(its)).find(([, x]) => x && String(x.id) === want);
    if (!e) return errContent("입금 행이 사라졌습니다.");
    const [k, cur] = e;
    if (cur.status === "done") return cur.campusToken === token ? { done: true } : errContent("그 사이 다른 기기에서 처리됐습니다.");
    const row = { ...cur, status: "done", client, link: finalLink, doneAt: Date.now(), campusToken: token };
    const patch = { [`items/${k}`]: row }; if (nmKey) patch[`nameMap/${nmKey}`] = client;
    const apply = (dd) => { const o = { ...(dd || {}) }; const it = Array.isArray(o.items) ? [...o.items] : { ...(o.items || {}) }; it[k] = row; o.items = it; o.nameMap = { ...(o.nameMap || {}), ...(nmKey ? { [nmKey]: client } : {}) }; return o; };
    return { patch, apply, check: (dd) => { const x = dd && dd.items && dd.items[k]; return !!x && x.campusToken === token; } };
  }, env);
  if (r3.isError) return r3;
  return textContent({ 결과: "입금완료 처리", 입금: { 날짜: dep.date, 입금자: dep.name, 금액: toNumber(dep.amount) }, 거래처: client, 연결: finalLink });
}

// 여러 입금 → 한 거래처. 장부 청구 하나에 묶거나(ledger) 입금마다 미수금 원장(ar) 또는 연결 없음(none).
async function toolDepositBatch(a, env) {
  const S = env.FIREBASE_DB_SECRET;
  const ids = (Array.isArray(a.depositIds) ? a.depositIds : []).map(String).slice(0, 200);
  const client = String(a.client || "").trim(), token = String(a.token || `${Date.now()}`).slice(0, 64);
  const link = a.link && typeof a.link === "object" ? a.link : { kind: "none" };
  if (!ids.length) return errContent("선택한 입금이 없습니다.");
  if (!client) return errContent("거래처(client)를 정해 주세요.");
  const bd = await fbGet("/frw/bankDeposits", S);
  const all = (Array.isArray(bd && bd.items) ? bd.items : Object.values((bd && bd.items) || {})).filter(Boolean);
  const deps = ids.map((id) => all.find((x) => String(x.id) === id)).filter(Boolean);
  if (deps.length !== ids.length) return errContent("선택한 입금 중 없는 건이 있습니다. 새로고침 후 다시 시도해 주세요.");
  const already = deps.filter((x) => x.status === "done" && x.campusToken !== token);
  if (already.length) return errContent(`이미 처리된 입금 ${already.length}건이 섞여 있습니다 (${already.map((x) => x.name).slice(0, 3).join(", ")}).`);
  const total = deps.reduce((t, x) => t + toNumber(x.amount), 0);
  const linkOf = {};
  if (link.kind === "ledger") {
    const ym = String(link.ym || ""), cid = String(link.clientId || "");
    const r = await safeSectionWrite("ledgers", (d) => {
      const arr = d && d[ym] && d[ym].clients;
      const list = Array.isArray(arr) ? arr.map((x, i) => [String(i), x]) : Object.entries(arr || {});
      const hit = list.find(([, x]) => x && String(x.id) === cid);
      if (!hit) return errContent(`${ym} 장부에 해당 청구가 없습니다.`);
      const [k, cur] = hit; if (cur.status === "입금완료") return { done: true };
      if (cur.status !== "미입금") return errContent(`이 청구는 '${cur.status}' 상태라 바꾸지 않습니다.`);
      const row = { ...cur, status: "입금완료", campusToken: token };
      const apply = (dd) => { const o = { ...(dd || {}) }; const m = { ...(o[ym] || {}) }; const cl = Array.isArray(m.clients) ? [...m.clients] : { ...(m.clients || {}) }; cl[k] = row; m.clients = cl; o[ym] = m; return o; };
      return { patch: { [`${ym}/clients/${k}`]: row }, apply, check: (dd) => { const x = dd && dd[ym] && dd[ym].clients && dd[ym].clients[k]; return !!x && x.status === "입금완료"; } };
    }, env);
    if (r.isError) return r;
    deps.forEach((x) => { linkOf[x.id] = { kind: "ledger", ym, clientId: cid }; });
  } else if (link.kind === "ar") {
    const key = fbEsc(client), base = Date.now();
    const adds = deps.map((x, i) => ({ id: base + i, type: "입금", desc: `은행입금 (${x.name || ""})`, amount: toNumber(x.amount), date: x.date, campusToken: `${token}#${i}` }));
    const r = await safeSectionWrite("clientAR", (d) => {
      const cur = (d && d[key]) || { entries: [] };
      const entries = Array.isArray(cur.entries) ? cur.entries : Object.values(cur.entries || {});
      if (entries.some((e) => e && e.campusToken === `${token}#0`)) return { done: true };
      const next = { ...cur, entries: [...entries, ...adds] };
      return { patch: { [key]: next }, apply: (dd) => ({ ...(dd || {}), [key]: next }),
        check: (dd) => { const c = dd && dd[key]; const es = c ? (Array.isArray(c.entries) ? c.entries : Object.values(c.entries || {})) : []; return es.some((e) => e && e.campusToken === `${token}#0`); } };
    }, env);
    if (r.isError) return r;
    deps.forEach((x, i) => { linkOf[x.id] = { kind: "ar", entryId: adds[i].id }; });
  } else deps.forEach((x) => { linkOf[x.id] = { kind: "none" }; });
  const r3 = await safeSectionWrite("bankDeposits", (d) => {
    const its = (d && d.items) || [];
    const ents = Array.isArray(its) ? its.map((x, i) => [String(i), x]) : Object.entries(its);
    const patch = {}, rows = {};
    for (const [k, cur] of ents) { if (!cur || !linkOf[cur.id]) continue;
      if (cur.status === "done" && cur.campusToken !== token) return errContent("그 사이 다른 기기에서 처리된 입금이 있습니다. 새로고침 후 다시 시도해 주세요.");
      const row = { ...cur, status: "done", client, link: linkOf[cur.id], doneAt: Date.now(), campusToken: token }; patch[`items/${k}`] = row; rows[k] = row; }
    deps.forEach((x) => { const nk = fbEsc(payNorm(x.name)); if (nk) patch[`nameMap/${nk}`] = client; });
    const apply = (dd) => { const o = { ...(dd || {}) }; const it = Array.isArray(o.items) ? [...o.items] : { ...(o.items || {}) }; for (const [k, v] of Object.entries(rows)) it[k] = v; o.items = it; return o; };
    return { patch, apply, check: (dd) => Object.keys(rows).every((k) => dd && dd.items && dd.items[k] && dd.items[k].campusToken === token) };
  }, env);
  if (r3.isError) return r3;
  return textContent({ 결과: "일괄 입금완료", 건수: deps.length, 합계: total, 거래처: client, 연결: link.kind === "ledger" ? { 월: link.ym } : link.kind });
}

async function toolDepositUndo(a, env) {
  const S = env.FIREBASE_DB_SECRET, want = String(a.depositId || "");
  const bd = await fbGet("/frw/bankDeposits", S);
  const all = (Array.isArray(bd && bd.items) ? bd.items : Object.values((bd && bd.items) || {})).filter(Boolean);
  const dep = all.find((x) => String(x.id) === want);
  if (!dep) return errContent(`입금 id=${want} 이(가) 없습니다.`);
  if (dep.status !== "done") return textContent({ 결과: "이미 미처리 상태" });
  const link = dep.link || {};
  if (link.kind === "ledger") {
    const siblings = all.filter((x) => String(x.id) !== want && x.status === "done" && x.link && x.link.kind === "ledger" && x.link.ym === link.ym && String(x.link.clientId) === String(link.clientId));
    if (!siblings.length) {
      const r = await safeSectionWrite("ledgers", (d) => {
        const arr = d && d[link.ym] && d[link.ym].clients;
        const list = Array.isArray(arr) ? arr.map((x, i) => [String(i), x]) : Object.entries(arr || {});
        const hit = list.find(([, x]) => x && String(x.id) === String(link.clientId));
        if (!hit || hit[1].status !== "입금완료") return { done: true };
        const [k, cur] = hit; const row = { ...cur, status: "미입금" };
        const apply = (dd) => { const o = { ...(dd || {}) }; const m = { ...(o[link.ym] || {}) }; const cl = Array.isArray(m.clients) ? [...m.clients] : { ...(m.clients || {}) }; cl[k] = row; m.clients = cl; o[link.ym] = m; return o; };
        return { patch: { [`${link.ym}/clients/${k}`]: row }, apply, check: (dd) => { const x = dd && dd[link.ym] && dd[link.ym].clients && dd[link.ym].clients[k]; return !!x && x.status === "미입금"; } };
      }, env);
      if (r.isError) return r;
    }
  } else if (link.kind === "ar") {
    const key = fbEsc(dep.client || "");
    const r = await safeSectionWrite("clientAR", (d) => {
      const cur = d && d[key]; if (!cur) return { done: true };
      const entries = (Array.isArray(cur.entries) ? cur.entries : Object.values(cur.entries || {})).filter(Boolean);
      if (!entries.some((e) => String(e.id) === String(link.entryId))) return { done: true };
      const next = { ...cur, entries: entries.filter((e) => String(e.id) !== String(link.entryId)) };
      return { patch: { [key]: next }, apply: (dd) => ({ ...(dd || {}), [key]: next }), check: (dd) => { const c = dd && dd[key]; const es = c ? (Array.isArray(c.entries) ? c.entries : Object.values(c.entries || {})) : []; return !es.some((e) => e && String(e.id) === String(link.entryId)); } };
    }, env);
    if (r.isError) return r;
  }
  const r3 = await safeSectionWrite("bankDeposits", (d) => {
    const its = (d && d.items) || [];
    const e = (Array.isArray(its) ? its.map((x, i) => [String(i), x]) : Object.entries(its)).find(([, x]) => x && String(x.id) === want);
    if (!e) return errContent("입금 행이 사라졌습니다.");
    const [k, cur] = e; if (cur.status !== "done") return { done: true };
    const row = { ...cur, status: "pending", client: "", link: null };
    const apply = (dd) => { const o = { ...(dd || {}) }; const it = Array.isArray(o.items) ? [...o.items] : { ...(o.items || {}) }; it[k] = row; o.items = it; return o; };
    return { patch: { [`items/${k}`]: row }, apply, check: (dd) => { const x = dd && dd.items && dd.items[k]; return !!x && x.status === "pending"; } };
  }, env);
  if (r3.isError) return r3;
  return textContent({ 결과: "되돌림", 입금자: dep.name, 금액: toNumber(dep.amount), 거래처: dep.client });
}

async function toolCampusWrite(a, env) {
  const op = String(a.op || "");
  if (op === "intake") return await toolRecordIntake(a, env);
  if (op === "ledger_status") return await toolLedgerStatus(a, env);
  if (op === "todo_add" || op === "todo_done" || op === "todo_update" || op === "todo_delete") return await toolTodo(a, env);
  if (op === "deposit_process") return await toolDepositProcess(a, env);
  if (op === "deposit_undo") return await toolDepositUndo(a, env);
  if (op === "deposit_batch") return await toolDepositBatch(a, env);
  if (op === "tax_paid") return await toolMarkTaxPaid({ id: a.id, paidDate: a.paidDate ?? "" }, env);
  if (op === "quote_save") return await toolQuoteSave(a, env);
  if (op === "po_save") return await toolPoSave(a, env);
  if (op === "stock_adjust") return await toolStockAdjust(a, env);
  if (op === "hr_payroll") return await toolHrPayroll(a, env);
  if (op === "hr_employee") return await toolHrEmployee(a, env);
  if (op === "bank_sms_hint") {
    // 은행 문자 자동 등록 — 이 숫자가 들어 있는 문자만 받는다 (앱 입금내역 카드의 「회사 통장 번호 앞자리」와 같은 값)
    const hint = String(a.hint ?? "").replace(/\D/g, "").slice(0, 8);
    if (hint && hint.length < 3) return errContent("3자리 이상 넣어 주세요.");
    await fbPatch("/frw_bank_sms", { acctHint: hint }, env.FIREBASE_DB_SECRET);
    const cur = await fbGet("/frw_bank_sms", env.FIREBASE_DB_SECRET);
    return textContent({ 결과: hint ? "계좌 앞자리 저장" : "계좌 앞자리 해제", 앞자리: (cur && cur.acctHint) || "", 문자주소: cur && cur.token ? "발급됨" : "아직 없음 (앱에서 켜기)" });
  }
  if (op === "note_add" || op === "daily_append") return await toolNoteSave(a, env);
  if (op === "payable_pay" || op === "payable_pay_delete") return await toolPayablePay(a, env);
  if (op === "sales_import") return textContent(await salesImport(env, { fileName: a.fileName, from: a.from, to: a.to, rows: a.rows }));
  if (op === "sales_row_update" || op === "sales_row_delete") return await toolSalesRow(a, env);
  if (op === "orders_batch" || op === "order_update" || op === "order_delete") return await toolOrders(a, env);
  return errContent(`알 수 없는 쓰기: ${op}`);
}

// ── 일정 탭 메모: 중요 메모 추가 / 하루 기록 덧붙이기 (캠퍼스 보관소에서 넘김) ──
// notes = [{ id, title, body, category, color, pinned, clientId, tags, atts, createdAt, updatedAt }] — 앱 목록은 updatedAt 순이라 끝에 붙여도 맨 위에 보인다.
// dailyNotes = { "YYYY-MM-DD": { text, star, atts, updatedAt } } — 그 날 글이 있으면 빈 줄 하나 띄우고 끝에 덧붙인다.
const NOTE_CAT_COLOR = { "거래처": "#DB6B2E", "회의": "#3B82F6", "아이디어": "#8B5CF6", "이슈": "#EF4444", "기타": "#64748B" };
async function toolNoteSave(a, env) {
  const token = String(a.token || `${Date.now()}`).slice(0, 64);
  const body = String(a.body ?? a.text ?? "").trim().slice(0, 20000);
  if (!body) return errContent("내용(body)이 필요합니다.");
  if (a.op === "note_add") {
    const title = String(a.title || "").trim().slice(0, 120) || "(제목 없음)";
    const category = NOTE_CAT_COLOR[a.category] ? a.category : "기타";
    const list = (d) => (Array.isArray(d) ? d.map((r, i) => [String(i), r]) : Object.entries(d || {})).filter(([, r]) => r);
    const plan = await safeSectionWrite("notes", (d) => {
      if (list(d).some(([, r]) => r.campusToken === token)) return { done: true, result: { 결과: "이미 반영됨" } };
      const key = Array.isArray(d) || d == null ? String(d ? d.length : 0) : `c${Date.now()}`;
      const ids = new Set(list(d).map(([, r]) => String(r.id))); let id = Date.now(); while (ids.has(String(id))) id++;
      const now = Date.now();
      const row = { id, title, body, category, color: NOTE_CAT_COLOR[category], pinned: !!a.pinned, clientId: null, tags: ["캠퍼스"], atts: [], createdAt: now, updatedAt: now, campusToken: token, fromCampus: true };
      const apply = (dd) => { if (Array.isArray(dd) || dd == null) { const x = [...(dd || [])]; x[Number(key)] = row; return x; } return { ...dd, [key]: row }; };
      return { patch: { [key]: row }, apply, check: (dd) => list(dd).some(([, r]) => r.campusToken === token), result: { 결과: "중요 메모 추가", 제목: title, 분류: category, 고정: !!a.pinned } };
    }, env);
    return plan.isError ? plan : textContent(plan.result);
  }
  const date = String(a.date || kstToday());
  if (!isRealDate(date)) return errContent("date 는 YYYY-MM-DD 입니다.");
  const plan = await safeSectionWrite("dailyNotes", (d) => {
    const cur = (d && d[date]) || {};
    if (cur.campusTokens && String(cur.campusTokens).split(",").includes(token)) return { done: true, result: { 결과: "이미 반영됨" } };
    const old = String(cur.text || "").trimEnd();
    const row = { ...cur, text: old ? `${old}\n\n${body}` : body, star: !!cur.star || !!a.star, atts: Array.isArray(cur.atts) ? cur.atts : [], updatedAt: Date.now(),
      campusTokens: [...String(cur.campusTokens || "").split(",").filter(Boolean).slice(-9), token].join(",") };
    const apply = (dd) => ({ ...(dd || {}), [date]: row });
    return { patch: { [date]: row }, apply, check: (dd) => !!(dd && dd[date] && String(dd[date].campusTokens || "").split(",").includes(token)), result: { 결과: "하루 기록에 덧붙임", 날짜: date, 글자수: body.length } };
  }, env);
  return plan.isError ? plan : textContent(plan.result);
}

// ── 이카운트 판매현황 줄 (/frw_sales/<YYYY-MM-DD> = [행]) — 캠퍼스에서 보기·고치기·지우기 ──
// 같은 기간 엑셀을 다시 올리면 그 기간이 통째로 바뀌므로, 여기서 고친 줄도 다음 업로드 때 덮인다.
const SALES_DAY = /^\d{4}-\d{2}-\d{2}$/;
const salesUrl = (path, env, q = "") => `https://${FB_HOST}/frw_sales${path}.json?${q ? q + "&" : ""}auth=${encodeURIComponent(env.FIREBASE_DB_SECRET)}`;
async function salesDays(env, from, to) {
  const q = `orderBy=${encodeURIComponent('"$key"')}&startAt=${encodeURIComponent(JSON.stringify(from))}&endAt=${encodeURIComponent(JSON.stringify(to))}`;
  const r = await fetch(salesUrl("", env, q)); if (!r.ok) throw new Error(`Firebase ${r.status}`);
  return (await r.json()) || {};
}
const salesList = (v) => (Array.isArray(v) ? v : Object.values(v || {}));
async function salesRows(env, o) {
  const today = kstToday();
  const to = SALES_DAY.test(o.to || "") ? o.to : today;
  const from = SALES_DAY.test(o.from || "") ? o.from : new Date(Date.parse(to) - 29 * 86400e3).toISOString().slice(0, 10);
  const byDay = await salesDays(env, from, to);
  const m = depQueryMatcher(o.q);
  const rows = [];
  for (const d of Object.keys(byDay).sort().reverse()) salesList(byDay[d]).forEach((r, i) => {
    if (!r) return;
    if (o.client && (r.c || "") !== o.client) return;
    if (o.name && !String(r.name || "").startsWith(o.name)) return;
    if (m && !m(`${r.c || ""} ${r.name || ""} ${r.code || ""} ${r.spec || ""}`)) return;
    rows.push({ d, i, c: r.c || "", code: r.code || "", name: r.name || "", spec: r.spec || "", qty: r.qty || 0, price: r.price || 0, supply: r.supply || 0, vat: r.vat || 0, total: r.total || r.supply || 0, wh: r.wh || "", ...(r.slip ? { slip: true, no: r.no || "" } : {}), ...(r.edited ? { edited: r.edited } : {}) });
  });
  const off = Math.max(0, parseInt(o.offset) || 0), lim = Math.min(5000, Math.max(1, parseInt(o.limit) || 200));
  return { from, to, count: rows.length, qty: rows.reduce((t, r) => t + r.qty, 0), total: rows.reduce((t, r) => t + r.total, 0), offset: off, limit: lim, rows: rows.slice(off, off + lim) };
}
// 줄 하나 고치기 {d, i, match:{name,c,total}, fields:{d?, c, name, code, spec, qty, price, supply, vat, total}} / 지우기 {rows:[{d,i,match}]}
async function toolSalesRow(a, env) {
  const same = (r, mt) => !mt || ((mt.name == null || String(r.name || "") === String(mt.name)) && (mt.c == null || String(r.c || "") === String(mt.c)) && (mt.total == null || Math.round(Number(r.total || r.supply || 0)) === Math.round(Number(mt.total))));
  const getDay = async (d) => { const r = await fetch(salesUrl(`/${d}`, env)); if (!r.ok) throw new Error(`Firebase ${r.status}`); return salesList(await r.json()).filter(Boolean); };
  const putDay = async (d, list) => { const r = await fetch(salesUrl(`/${d}`, env), { method: "PUT", body: JSON.stringify(list.length ? list : null) }); if (!r.ok) throw new Error(`Firebase ${r.status}`); };
  const num = (v) => { const x = Number(String(v ?? "").replace(/[,\s원]/g, "")); return Number.isFinite(x) ? x : 0; };
  if (a.op === "sales_row_update") {
    const d = String(a.d || ""), i = parseInt(a.i);
    if (!SALES_DAY.test(d) || !(i >= 0)) return errContent("d(날짜)와 i(순번)가 필요합니다.");
    const list = await getDay(d), cur = list[i];
    if (!cur) return errContent(`${d} 의 ${i}번 줄이 없습니다. 목록을 새로 불러와 주세요.`);
    if (!same(cur, a.match)) return errContent("그 사이 판매 기록이 바뀌었습니다(다시 올린 엑셀 등). 목록을 새로 불러와 주세요.");
    const F = a.fields || {}, row = { ...cur };
    for (const k of ["c", "name", "code", "spec", "wh"]) if (F[k] != null) row[k] = String(F[k]).trim().slice(0, k === "name" ? 120 : 80);
    for (const k of ["qty", "price", "supply", "vat", "total"]) if (F[k] != null && F[k] !== "") row[k] = num(F[k]);
    if (!row.name && !row.code) return errContent("품목명은 비울 수 없습니다.");
    row.edited = kstToday();
    const nd = F.d && F.d !== d ? normalizeDate(F.d) : d;
    if (!SALES_DAY.test(nd) || !isRealDate(nd)) return errContent("날짜가 잘못됐습니다.");
    if (nd === d) { list[i] = row; await putDay(d, list); }
    else { row.d = nd; const nl = await getDay(nd); nl.push(row); await putDay(nd, nl); list.splice(i, 1); await putDay(d, list); }
    return textContent({ 결과: "판매 줄 수정", 날짜: nd, 이전: cur, 이후: row, 안내: "같은 기간 엑셀을 다시 올리면 이 수정은 덮입니다." });
  }
  const want = Array.isArray(a.rows) ? a.rows : [{ d: a.d, i: a.i, match: a.match }];
  const byD = {};
  for (const w of want) { const d = String(w && w.d || ""), i = parseInt(w && w.i); if (!SALES_DAY.test(d) || !(i >= 0)) return errContent("rows 는 [{d, i}] 입니다."); (byD[d] = byD[d] || []).push({ i, match: w.match }); }
  const gone = [];
  for (const [d, ws] of Object.entries(byD)) {
    const list = await getDay(d);
    for (const w of ws) { if (!list[w.i]) return errContent(`${d} 의 ${w.i}번 줄이 없습니다. 목록을 새로 불러와 주세요.`); if (!same(list[w.i], w.match)) return errContent(`${d} 판매 기록이 그 사이 바뀌었습니다. 목록을 새로 불러와 주세요.`); }
    const del = new Set(ws.map((w) => w.i));
    list.forEach((r, k) => del.has(k) && gone.push({ d, ...r }));
    await putDay(d, list.filter((_, k) => !del.has(k)));
  }
  return textContent({ 결과: `판매 줄 ${gone.length}건 삭제`, 삭제: gone, 안내: "같은 기간 엑셀을 다시 올리면 다시 들어옵니다." });
}

// ── 판매 현황 (orders) ── 회사앱 대시보드 「제품별 판매 현황」과 같은 배열.
// 행 = { id, date, productName, qty, unitPrice, client, clientId, note, paymentDue, paidDate } (+ 캠퍼스: spec, supply, vat, src, campusToken, fromCampus)
// 합계 = unitPrice × qty (앱과 같은 산식). 날짜가 12-31·수량 1·거래처 없음·100만원 이상이면 '연간 합계'로 본다(앱에 손으로 넣은 2025 연간 합계 행).
const ordList = (d) => (Array.isArray(d) ? d.map((r, i) => [String(i), r]) : Object.entries(d || {})).filter(([, r]) => r && typeof r === "object");
const ordAmt = (r) => Math.round(toNumber(r.unitPrice) * (parseInt(r.qty) || 0));
const ordAnnual = (r) => /-12-31$/.test(String(r.date || "")) && (parseInt(r.qty) || 0) === 1 && !String(r.client || "").trim() && toNumber(r.unitPrice) >= 1e6;
const ordDupKey = (r) => [String(r.date || ""), searchNorm(r.client), searchNorm(r.productName), searchNorm(r.spec), parseInt(r.qty) || 0, ordAmt(r)].join("|");
function ordView(r) {
  return { id: r.id, date: r.date || "", productName: r.productName || "", spec: r.spec || "", qty: parseInt(r.qty) || 0, unitPrice: toNumber(r.unitPrice), amount: ordAmt(r),
    client: r.client || "", note: r.note || "", paymentDue: r.paymentDue || "", paidDate: r.paidDate || "", ...(r.src ? { src: r.src } : {}), ...(ordAnnual(r) ? { annual: true } : {}) };
}
async function ordersRead(env, o) {
  const S = env.FIREBASE_DB_SECRET;
  const all = ordList(await fbGet("/frw/orders", S)).map(([, r]) => ordView(r));
  const m = depQueryMatcher(o.q);
  const from = o.from ? normalizeDate(o.from) : "", to = o.to ? normalizeDate(o.to) : "";
  const f = all.filter((r) => {
    if (o.annual === false && r.annual) return false;
    if (o.annual === "only" && !r.annual) return false;
    if (from && r.date < from) return false;
    if (to && r.date > to) return false;
    if (o.client && r.client !== o.client) return false;
    if (o.product && r.productName !== o.product) return false;
    if (o.paid === "paid" && !r.paidDate) return false;
    if (o.paid === "unpaid" && r.paidDate) return false;
    if (m && !m(`${r.productName} ${r.spec} ${r.client} ${r.note}`)) return false;
    return true;
  }).sort((a, b) => b.date.localeCompare(a.date) || String(b.id).localeCompare(String(a.id)));
  const group = (key, rows) => { const g = {}; rows.forEach((r) => { const k = key(r) || "(없음)"; const x = g[k] || (g[k] = { name: k, qty: 0, amount: 0, count: 0 }); x.qty += r.qty; x.amount += r.amount; x.count++; }); return Object.values(g); };
  const live = f.filter((r) => !r.annual);
  const byProduct = group((r) => r.productName, f).sort((a, b) => b.amount - a.amount);
  const byClient = group((r) => r.client, live).sort((a, b) => b.amount - a.amount);
  const byMonth = group((r) => r.date.slice(0, 7), live).sort((a, b) => a.name.localeCompare(b.name));
  const off = Math.max(0, parseInt(o.offset) || 0), lim = Math.min(1000, Math.max(1, parseInt(o.limit) || 200));
  const out = { totalCount: all.length, filtered: f.length, amount: f.reduce((t, r) => t + r.amount, 0), qty: f.reduce((t, r) => t + r.qty, 0),
    unpaid: f.filter((r) => !r.paidDate && !r.annual).reduce((t, r) => t + r.amount, 0), annualCount: f.filter((r) => r.annual).length,
    byProduct: byProduct.slice(0, o.top || 300), byClient: byClient.slice(0, o.top || 300), byMonth, offset: off, limit: lim, rows: f.slice(off, off + lim) };
  if (o.keys) out.dupKeys = all.map((r) => ordDupKey(r));
  if (o.names) {
    const [ps, clients, ledgers] = await Promise.all([fbGet("/frw/products", S), fbGet("/frw/clients", S), fbGet("/frw/ledgers", S)]);
    const names = new Set();
    asList(clients).forEach((c) => c.name && names.add(String(c.name).trim()));
    Object.values(ledgers || {}).forEach((mm) => asList(mm && mm.clients).forEach((c) => c.name && names.add(String(c.name).trim())));
    all.forEach((r) => r.client && names.add(r.client.trim()));
    const pn = new Set(asList(ps).map((p) => String(p.name || "").trim()).filter(Boolean));
    all.forEach((r) => r.productName && !r.annual && pn.add(r.productName.trim()));
    out.productNames = [...pn].sort((a, b) => a.localeCompare(b, "ko"));
    out.clientNames = [...names].filter(Boolean).sort((a, b) => a.localeCompare(b, "ko"));
  }
  return out;
}
async function toolOrders(a, env) {
  const token = String(a.token || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`).slice(0, 64);
  const withRow = (d, key, row) => { if (Array.isArray(d) || d == null) { const x = [...(d || [])]; x[Number(key)] = row; return x; } return { ...d, [key]: row }; };
  const hasToken = (d) => ordList(d).some(([, r]) => r.campusToken === token);
  if (a.op === "orders_batch") {
    const rows = (Array.isArray(a.rows) ? a.rows : []).slice(0, 500).map((r) => {
      const qty = parseInt(toNumber(r.qty)) || 0, supply = toNumber(r.supply);
      let unitPrice = toNumber(r.unitPrice); if (!unitPrice && supply && qty) unitPrice = Math.round(supply / qty * 100) / 100;
      return { date: normalizeDate(r.date), productName: String(r.productName || "").trim().slice(0, 120), spec: String(r.spec || "").trim().slice(0, 60), qty, unitPrice,
        client: String(r.client || "").trim().slice(0, 80), note: String(r.note || "").trim().slice(0, 200), paymentDue: r.paymentDue ? normalizeDate(r.paymentDue) : "", paidDate: r.paidDate ? normalizeDate(r.paidDate) : "",
        ...(supply ? { supply } : {}), ...(r.vat != null && r.vat !== "" ? { vat: toNumber(r.vat) } : {}) };
    });
    const bad = rows.findIndex((r) => !isRealDate(r.date) || !r.productName || !r.qty);
    if (!rows.length) return errContent("기록할 행이 없습니다.");
    if (bad >= 0) return errContent(`${bad + 1}번째 행이 잘못됐습니다 (날짜 YYYY-MM-DD·제품명·수량 필요): ${JSON.stringify(rows[bad])}`);
    const skipDup = a.skipDup !== false;
    const plan = await safeSectionWrite("orders", (d) => {
      if (hasToken(d)) return { done: true, result: { 결과: "이미 반영됨 (같은 요청)" } };
      const list = ordList(d), seen = new Set(skipDup ? list.map(([, r]) => ordDupKey(r)) : []);
      const ids = new Set(list.map(([, r]) => String(r.id))); let id = Date.now(); while (ids.has(String(id))) id++;
      const base = Array.isArray(d) || d == null ? (d ? d.length : 0) : null;
      const patch = {}; let n = 0, dup = 0;
      rows.forEach((r) => {
        const k = ordDupKey(r); if (skipDup && seen.has(k)) { dup++; return; } seen.add(k);
        const key = base != null ? String(base + n) : `c${Date.now()}_${n}`;
        while (ids.has(String(id))) id++; ids.add(String(id));
        patch[key] = { id: id++, ...r, clientId: "", src: String(a.src || "campus").slice(0, 20), campusToken: n === 0 ? token : `${token}#${n}`, fromCampus: true };
        n++;
      });
      if (!n) return { done: true, result: { 결과: "새로 넣을 행 없음 (모두 이미 있음)", 겹침: dup } };
      const apply = (dd) => { let out = dd; for (const [k, v] of Object.entries(patch)) out = withRow(out, k, v); return out; };
      return { patch, apply, check: hasToken, result: { 결과: `판매 ${n}건 기록`, 기록: n, 겹쳐서뺌: dup, 합계: Object.values(patch).reduce((t, r) => t + ordAmt(r), 0) } };
    }, env);
    return plan.isError ? plan : textContent(plan.result);
  }
  if (a.op === "order_update") {
    const want = String(a.id ?? ""); if (!want) return errContent("id 가 필요합니다.");
    const F = a.fields || {}, ch = {};
    if (F.date != null) { const dt = normalizeDate(F.date); if (!isRealDate(dt)) return errContent("date 가 잘못됐습니다."); ch.date = dt; }
    if (F.productName != null) { ch.productName = String(F.productName).trim().slice(0, 120); if (!ch.productName) return errContent("제품명은 비울 수 없습니다."); }
    if (F.qty != null) { ch.qty = parseInt(toNumber(F.qty)) || 0; if (!ch.qty) return errContent("수량은 0이 아니어야 합니다."); }
    if (F.unitPrice != null) ch.unitPrice = toNumber(F.unitPrice);
    for (const k of ["client", "note", "spec"]) if (F[k] != null) ch[k] = String(F[k]).trim().slice(0, 200);
    for (const k of ["paymentDue", "paidDate"]) if (F[k] != null) { const v = F[k] ? normalizeDate(F[k]) : ""; if (v && !isRealDate(v)) return errContent(`${k} 가 잘못됐습니다.`); ch[k] = v; }
    if (!Object.keys(ch).length) return errContent("바꿀 항목(fields)이 없습니다.");
    const plan = await safeSectionWrite("orders", (d) => {
      const hit = ordList(d).find(([, r]) => String(r.id) === want);
      if (!hit) return errContent(`판매 기록 id=${want} 가 없습니다.`);
      const [key, cur] = hit;
      if (cur.campusEdit === token) return { done: true, result: { 결과: "이미 반영됨" } };
      const row = { ...cur, ...ch, campusEdit: token, editedAt: Date.now() };
      return { patch: { [key]: row }, apply: (dd) => withRow(dd, key, row), check: (dd) => ordList(dd).some(([, r]) => r.campusEdit === token),
        result: { 결과: "판매 기록 수정", 이전: ordView(cur), 이후: ordView(row) } };
    }, env);
    return plan.isError ? plan : textContent(plan.result);
  }
  // order_delete: ids 배열 — 배열 전체를 다시 써야 해서 replace
  const ids = new Set((Array.isArray(a.ids) ? a.ids : [a.id]).filter((x) => x != null && x !== "").map(String));
  if (!ids.size) return errContent("지울 ids 가 필요합니다.");
  const plan = await safeSectionWrite("orders", (d) => {
    const list = ordList(d), gone = list.filter(([, r]) => ids.has(String(r.id)));
    if (!gone.length) return { done: true, result: { 결과: "지울 행 없음 (이미 지워짐)" } };
    const keep = list.filter(([, r]) => !ids.has(String(r.id))).map(([, r]) => r);
    return { replace: true, patch: {}, apply: () => keep, check: (dd) => !ordList(dd).some(([, r]) => ids.has(String(r.id))),
      result: { 결과: `판매 ${gone.length}건 삭제`, 삭제: gone.map(([, r]) => ordView(r)) } };
  }, env);
  return plan.isError ? plan : textContent(plan.result);
}

// ── 공급처 미지급 정산 (회사앱 매입 → 거래처 탭 → 미지급 정산과 같은 규칙) ──
// payables = { [공급처명(fbEsc)]: { openingBalance, openingDate, payments:[{id,date,amount,memo}], manualBuys:[…] } }
function payKeyOf(P, supplier) {
  const keys = Object.keys(P || {});
  const exact = keys.find((k) => fbUnesc(k) === supplier);
  if (exact) return exact;
  const hits = keys.filter((k) => payMatch(fbUnesc(k), supplier));
  return hits.length === 1 ? hits[0] : (hits.length ? { many: hits.map(fbUnesc) } : null);
}
async function payablesOf(env, supplierRaw) {
  const supplier = String(supplierRaw || "").trim();
  const [P, I] = await Promise.all([fbGet("/frw/payables", env.FIREBASE_DB_SECRET), fbGet("/frw/fabricIntakes", env.FIREBASE_DB_SECRET)]);
  if (!supplier) return { 공급처목록: Object.keys(P || {}).map(fbUnesc) };
  const key = payKeyOf(P, supplier);
  if (key && key.many) return { 오류: "여러 공급처가 맞습니다. 정확한 이름을 넣어 주세요.", 후보: key.many };
  if (!key) { const cand = Object.keys(P || {}).map(fbUnesc).filter((n) => payNorm(n).includes(payNorm(supplier))); if (cand.length) return { 오류: "미지급 원장 공급처 이름을 정확히 넣어 주세요.", 후보: cand }; }
  const name = key ? fbUnesc(key) : supplier;
  const c = (key && P[key]) || {};
  const openDate = c.openingDate || "", opening = Number(c.openingBalance) || 0;
  const buys = asList(I).filter((r) => r && payMatch(r.supplier, name) && (!openDate || String(r.date || "") >= openDate)).map((r) => {
    const q = (r.status === "반품" ? -1 : 1) * (Number(r.qty) || 0);
    return { date: r.date || "", 품목: r.materialName || "", 수량: q, 단가: Number(r.unitPrice) || 0, 매입액: Math.round(q * (Number(r.unitPrice) || 0) * 1.1) };
  }).filter((r) => r.매입액 !== 0);
  const pays = asList(c.payments).map((x) => ({ id: x.id, date: x.date || "", 금액: Number(x.amount) || 0, 메모: x.memo || "", ...(x.fromCampus ? { 캠퍼스: true } : {}) }));
  const manual = asList(c.manualBuys).map((x) => ({ id: x.id, date: x.date || "", 금액: Number(x.amount) || 0, 메모: x.memo || "" }));
  const buyT = buys.reduce((a, r) => a + r.매입액, 0) + manual.reduce((a, r) => a + r.금액, 0), payT = pays.reduce((a, r) => a + r.금액, 0);
  return { 공급처: name, 원장있음: !!key, 기초잔액: opening, 기초일: openDate, 매입합계: buyT, 지급합계: payT, 미지급잔액: Math.round(opening + buyT - payT),
    지급: pays.sort((a, b) => a.date.localeCompare(b.date)), 수동매입: manual, 매입건수: buys.length, 최근매입: buys.sort((a, b) => b.date.localeCompare(a.date)).slice(0, 40) };
}
async function toolPayablePay(a, env) {
  const supplier = String(a.supplier || "").trim();
  if (!supplier) return errContent("supplier(공급처)가 필요합니다.");
  const P0 = await fbGet("/frw/payables", env.FIREBASE_DB_SECRET);
  let key = payKeyOf(P0, supplier);
  if (key && key.many) return errContent(`여러 공급처가 맞습니다: ${key.many.join(", ")}`);
  if (a.op === "payable_pay_delete") {
    if (!key) return errContent(`미지급 원장이 없는 공급처: ${supplier}`);
    const id = String(a.id || "");
    const plan = await safeSectionWrite("payables", (d) => {
      const c = (d && d[key]) || {};
      const list = asList(c.payments);
      const hit = list.find((x) => String(x.id) === id);
      if (!hit) return { done: true, result: { 결과: "이미 없음", id } };
      const row = { ...c, payments: list.filter((x) => String(x.id) !== id) };
      return { patch: { [key]: row }, apply: (dd) => ({ ...(dd || {}), [key]: row }), check: (dd) => !asList(dd && dd[key] && dd[key].payments).some((x) => String(x.id) === id),
        result: { 결과: "지급 삭제", 공급처: fbUnesc(key), 일자: hit.date, 금액: Number(hit.amount) || 0, 메모: hit.memo || "" } };
    }, env);
    return plan.isError ? plan : textContent(plan.result);
  }
  const amount = Math.round(Number(String(a.amount ?? "").replace(/[,\s원]/g, "")));
  if (!(amount > 0)) return errContent("amount(지급액)는 0보다 큰 숫자여야 합니다.");
  const date = String(a.date || kstToday());
  if (!isRealDate(date)) return errContent("date 는 YYYY-MM-DD 입니다.");
  if (!key && !a.create) return errContent(`미지급 원장이 없는 공급처입니다: ${supplier}. 새로 만들려면 create:true (공급처 이름 정확히).`);
  if (!key) key = fbEsc(supplier);
  const token = String(a.token || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`).slice(0, 64);
  const memo = String(a.memo || "").slice(0, 120);
  const plan = await safeSectionWrite("payables", (d) => {
    const c = (d && d[key]) || { openingBalance: "", openingDate: "", payments: [], manualBuys: [] };
    const list = asList(c.payments);
    if (list.some((x) => x.campusToken === token)) return { done: true, result: { 결과: "이미 반영됨 (같은 요청)" } };
    const ids = new Set(list.map((x) => String(x.id)));
    let id = `cp${Date.now().toString(36)}`; while (ids.has(id)) id += "x";
    const pay = { id, date, amount, memo, fromCampus: true, campusToken: token };
    const row = { openingBalance: c.openingBalance ?? "", openingDate: c.openingDate ?? "", manualBuys: asList(c.manualBuys), ...c, payments: [...list, pay] };
    return { patch: { [key]: row }, apply: (dd) => ({ ...(dd || {}), [key]: row }), check: (dd) => asList(dd && dd[key] && dd[key].payments).some((x) => x.campusToken === token),
      result: { 결과: "지급(입금) 등록", 공급처: fbUnesc(key), id, 일자: date, 금액: amount, 메모: memo, 되돌리기: `_write {op:'payable_pay_delete', supplier, id:'${id}'}` } };
  }, env);
  return plan.isError ? plan : textContent(plan.result);
}

// ── 인사 관리: 직원 목록·달별 급여대장 ──
// payrolls = { "2026-10": { status: "draft"|"closed", rows: { [empId]: {base, allow, meal, np, hi, lt, ei, it, lo, adv} }, snap, closedAt } }
// 앱은 rows 의 값을 "그 달에 고친 값"으로 보고 비어 있는 칸만 자동 계산한다. 세무사 급여대장을 그대로 옮길 때 모든 칸을 채운다.
const HR_FIELDS = ["base", "allow", "meal", "np", "hi", "lt", "ei", "it", "lo", "adv"];
const hrNameKey = (s) => String(s || "").replace(/\s+/g, "");
async function hrRead(env, ym) {
  const [emps, pays] = await Promise.all([fbGet("/frw/employees", env.FIREBASE_DB_SECRET), fbGet("/frw/payrolls", env.FIREBASE_DB_SECRET)]);
  const employees = asList(emps).map((e) => ({ id: e.id, 이름: e.name, 직급: e.role || "", 소속: e.biz || "", 입사일: e.joined || "", 퇴사일: e.leftAt || "",
    기본급: toNumber(e.base), 수당: toNumber(e.allow), 식대: e.meal, 소득세: toNumber(e.incomeTax), 급여일: e.payDay || "" }));
  const p = pays && typeof pays === "object" ? pays : {};
  return { 직원수: employees.length, 직원: employees, 급여대장달: Object.keys(p).sort(), ...(ym ? { [ym]: p[ym] || null } : {}) };
}
// 직원 기본값(기본급·수당·식대·간이세액표 소득세)을 이름으로 찾아 고친다. create:true 면 없는 사람을 새로 등록(입사일 필수).
// 앱의 직원 저장(saveEmp)과 같은 모양 — 숫자는 정수로, updatedAt 갱신.
async function toolHrEmployee(a, env) {
  const rows = Array.isArray(a.rows) ? a.rows.slice(0, 60) : [];
  if (!rows.length) return errContent("rows 가 비었습니다 ([{name, base, allow, meal, incomeTax, role, biz, joined}]).");
  const NUM = ["base", "allow", "meal", "incomeTax", "payDay"], TXT = ["role", "biz", "joined", "phone", "memo", "payBank", "payAccount", "payHolder"];
  const now = new Date().toISOString();
  const list = (d) => (Array.isArray(d) ? d.map((r, i) => [String(i), r]) : Object.entries(d || {})).filter(([, r]) => r);
  const pick = (r) => { const o = {}; for (const f of NUM) if (r[f] !== undefined && r[f] !== null && r[f] !== "") o[f] = Math.round(toNumber(r[f]));
    for (const f of TXT) if (r[f] !== undefined && r[f] !== null && r[f] !== "") o[f] = String(r[f]).trim(); return o; };
  const out = { 고침: [], 추가: [], 못함: [] };
  const plan = await safeSectionWrite("employees", (d) => {
    const ents = list(d), patch = {}; let arr = Array.isArray(d) ? [...d] : null, obj = Array.isArray(d) ? null : { ...(d || {}) };
    out.고침 = []; out.추가 = []; out.못함 = [];
    let nextIdx = Array.isArray(d) ? d.length : 0;
    for (const r of rows) {
      const hit = ents.filter(([, e]) => hrNameKey(e.name) === hrNameKey(r.name) && (!r.biz || !e.biz || String(e.biz) === String(r.biz)));
      const vals = pick(r);
      if (hit.length === 1) {
        const [k, e] = hit[0]; const row = { ...e, ...vals, updatedAt: now };
        patch[k] = row; if (arr) arr[Number(k)] = row; else obj[k] = row; out.고침.push({ 이름: e.name, ...vals });
      } else if (!hit.length && a.create && vals.joined && /^\d{4}-\d{2}-\d{2}$/.test(vals.joined)) {
        const row = { id: Date.now() * 1000 + Math.floor(Math.random() * 1000), name: String(r.name).trim(), role: "", biz: "", probationEnd: "", birthday: "", phone: "",
          base: 0, allow: 0, meal: 200000, incomeTax: 0, memo: "", leftAt: "", ...vals, createdAt: now, updatedAt: now };
        const k = arr ? String(nextIdx++) : `c${row.id}`;
        patch[k] = row; if (arr) arr[Number(k)] = row; else obj[k] = row; out.추가.push({ 이름: row.name, ...vals });
      } else out.못함.push({ 이름: r.name, 사유: hit.length ? "같은 이름이 여러 명" : "직원 목록에 없음 (create:true 와 joined 로 새로 등록 가능)" });
    }
    if (!Object.keys(patch).length) return errContent(`고칠 직원이 없습니다: ${JSON.stringify(out.못함)}`);
    const want = Object.values(patch);
    return { patch, apply: () => arr || obj,
      check: (dd) => want.every((w) => list(dd).some(([, e]) => String(e.id) === String(w.id) && e.updatedAt === w.updatedAt)) };
  }, env);
  if (plan.isError) return plan;
  return textContent({ 결과: "직원 정보 저장", ...out });
}
async function toolHrPayroll(a, env) {
  const ym = String(a.ym || "");
  if (!/^\d{4}-\d{2}$/.test(ym)) return errContent('ym 은 "YYYY-MM" 형식이어야 합니다.');
  const rows = Array.isArray(a.rows) ? a.rows.slice(0, 60) : [];
  if (!rows.length) return errContent("rows 가 비었습니다 ([{name, base, allow, meal, np, hi, lt, ei, it, lo, adv}]).");
  const emps = asList(await fbGet("/frw/employees", env.FIREBASE_DB_SECRET));
  const matched = [], missing = [];
  for (const r of rows) {
    const cand = emps.filter((e) => hrNameKey(e.name) === hrNameKey(r.name) && (!a.biz || String(e.biz || "") === String(a.biz)));
    if (cand.length !== 1) { missing.push({ 이름: r.name, 사유: cand.length ? "같은 이름이 여러 명" : "직원 목록에 없음" }); continue; }
    const vals = {};
    for (const f of HR_FIELDS) if (r[f] !== undefined && r[f] !== null && r[f] !== "") vals[f] = Math.round(toNumber(r[f]));
    matched.push({ emp: cand[0], vals });
  }
  // 한 명이라도 못 찾으면 아무것도 쓰지 않는다 — 반쯤 들어간 급여대장이 더 헷갈린다
  if (missing.length && !a.partial) return textContent({ 결과: "쓰지 않음", 못찾음: missing, 안내: "앱 인사 관리 › 직원에 먼저 등록하거나 이름을 맞춘 뒤 다시 요청하세요." });
  if (!matched.length) return errContent("맞는 직원이 없습니다.");
  const same = (x, y) => HR_FIELDS.every((f) => (x || {})[f] === (y || {})[f]);
  const plan = await safeSectionWrite("payrolls", (d) => {
    const all = d && typeof d === "object" && !Array.isArray(d) ? d : {};
    const rec = all[ym] || {};
    if (rec.status === "closed") return errContent(`${ym} 급여는 이미 마감됐습니다. 앱에서 마감을 푼 뒤 다시 요청하세요.`);
    const rowsMap = { ...(rec.rows || {}) };
    for (const m of matched) rowsMap[String(m.emp.id)] = { ...m.vals };
    const next = { ...rec, status: "draft", rows: rowsMap, importedAt: new Date().toISOString() };
    return { patch: { [ym]: next }, apply: (dd) => ({ ...(dd && typeof dd === "object" && !Array.isArray(dd) ? dd : {}), [ym]: next }),
      check: (dd) => !!dd && !!dd[ym] && matched.every((m) => same(dd[ym].rows && dd[ym].rows[String(m.emp.id)], m.vals)) };
  }, env);
  if (plan.isError) return plan;
  return textContent({ 결과: `${ym} 급여 입력`, 입력: matched.map((m) => ({ 이름: m.emp.name, ...m.vals })), ...(missing.length ? { 못찾음: missing } : {}) });
}

// 캠퍼스 창고 실사 조정 — 품목코드 하나의 재고 수량을 실제 센 수량으로 바꾼다.
// 다음 엑셀 업로드가 오면 통째로 덮이므로(ERP 가 정답) 그때까지만 유효. 조정 이력은 캠퍼스 db 에 따로 남는다.
async function toolStockAdjust(a, env) {
  const code = String(a.code || "").trim(), qty = Number(a.qty);
  if (!code) return errContent("품목코드(code)가 필요합니다.");
  if (!Number.isFinite(qty)) return errContent("qty 는 숫자여야 합니다.");
  const token = String(a.token || `${Date.now()}`).slice(0, 64);
  const reason = String(a.reason || "").slice(0, 120);
  let from = null, name = "";
  const r = await safeSectionWrite("stock", (d) => {
    const items = d && d.items;
    const list = Array.isArray(items) ? items.map((x, i) => [String(i), x]) : Object.entries(items || {});
    const hit = list.find(([, x]) => x && String(x.code || "").trim() === code);
    if (!hit) return errContent(`재고에 없는 품목코드: ${code}`);
    const [k, it] = hit;
    if (it.adjustToken === token) return { done: true };
    from = toNumber(it.qty); name = it.name || code;
    const at = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 16).replace("T", " ");
    const patch = { [`items/${k}/qty`]: qty, [`items/${k}/adjustToken`]: token, [`items/${k}/adjustedAt`]: at, [`items/${k}/adjustNote`]: reason };
    return { patch, apply: (dd) => { const n = JSON.parse(JSON.stringify(dd)); const t = n.items[k]; Object.assign(t, { qty, adjustToken: token, adjustedAt: at, adjustNote: reason }); return n; },
      check: (dd) => { const x = dd && dd.items && dd.items[k]; return !!x && x.adjustToken === token && toNumber(x.qty) === qty; } };
  }, env);
  if (r && r.isError) return r;
  return textContent({ 결과: "재고 조정", 품목코드: code, 품명: name, 이전: from, 조정후: qty, 차이: from == null ? null : qty - from, 사유: reason });
}

// 캠퍼스에서 만든 견적서를 회사앱 견적 이력(quoteHistory)에 넣는다 — 앱의 저장 항목과 같은 모양(status draft, quoteStyle apple)
async function toolQuoteSave(a, env) {
  const token = String(a.token || `${Date.now()}`).slice(0, 64);
  const quote = String(a.quote || "").trim(), title = String(a.title || "").trim().slice(0, 120), client = String(a.client || "").trim().slice(0, 80);
  if (!quote) return errContent("견적서 본문(quote)이 필요합니다.");
  const products = (Array.isArray(a.products) ? a.products : []).slice(0, 60).map((p) => ({ name: String(p.name || "").slice(0, 80), grade: String(p.grade || "").slice(0, 2), price: toNumber(p.price), qty: toNumber(p.qty) || 1 }));
  const now = new Date(Date.now() + 9 * 3600 * 1000);
  const dateStr = `${now.getUTCFullYear()}.${String(now.getUTCMonth() + 1).padStart(2, "0")}.${String(now.getUTCDate()).padStart(2, "0")}`;
  const timeStr = `${String(now.getUTCHours()).padStart(2, "0")}:${String(now.getUTCMinutes()).padStart(2, "0")}`;
  const list = (d) => (Array.isArray(d) ? d.map((r, i) => [String(i), r]) : Object.entries(d || {})).filter(([, r]) => r);
  const plan = await safeSectionWrite("quoteHistory", (d) => {
    if (list(d).some(([, r]) => r.campusToken === token)) return { done: true, result: { 결과: "이미 저장됨" } };
    const key = Array.isArray(d) || d == null ? String(d ? d.length : 0) : `c${Date.now()}`;
    const ids = new Set(list(d).map(([, r]) => String(r.id))); let id = `q${Date.now().toString(36)}`; while (ids.has(id)) id += "x";
    const row = { id, title: title || products.map((p) => p.name).join(", ") || "견적서", dateStr, timeStr, savedAt: Date.now(), status: "draft", quote, quoteClient: client, quoteStyle: String(a.style || "apple"), products, fromCampus: true, campusToken: token };
    const apply = (dd) => { if (Array.isArray(dd) || dd == null) { const x = [...(dd || [])]; x[Number(key)] = row; return x; } return { ...dd, [key]: row }; };
    return { patch: { [key]: row }, apply, check: (dd) => list(dd).some(([, r]) => r.campusToken === token), result: { 결과: "견적 이력에 저장", id, 제목: row.title, 거래처: client, 품목수: products.length } };
  }, env);
  return plan.isError ? plan : textContent(plan.result);
}

// 캠퍼스 견적·발주 담당 → 발주 관리 이력(purchaseOrders)에 앱 savePOToHistory 와 같은 모양으로 추가.
// 공급처 정보는 공급처 목록(suppliers)에서 이름으로 찾아 채운다. 앱 목록은 발주일 순 정렬이라 끝에 붙여도 된다.
async function toolPoSave(a, env) {
  const token = String(a.token || `${Date.now()}`).slice(0, 64);
  const body = String(a.body || "").trim();
  if (!body) return errContent("발주서 본문(body)이 필요합니다.");
  const items = (Array.isArray(a.items) ? a.items : []).slice(0, 60).map((it) => ({ name: String(it.name || "").trim().slice(0, 80), unit: String(it.unit || "").slice(0, 30), qty: toNumber(it.qty), unitPrice: toNumber(it.unitPrice), memo: String(it.memo || "").slice(0, 120) })).filter((it) => it.name && it.qty > 0);
  if (!items.length) return errContent("품목(이름·수량)이 하나 이상 필요합니다.");
  const supName = String(a.supplier || "").trim().slice(0, 80);
  if (!supName) return errContent("공급처(supplier)가 필요합니다.");
  const sups = asList(await fbGet("/frw/suppliers", env.FIREBASE_DB_SECRET));
  const norm = (n) => String(n || "").trim().toLowerCase().replace(/\s+/g, "");
  const found = sups.find((s) => norm(s.name) === norm(supName));
  const supplier = found ? { name: found.name || "", contact: found.contact || "", phone: found.phone || "", email: found.email || "", address: found.address || "", paymentTerms: found.paymentTerms || "" } : { name: supName, contact: "", phone: "", email: "", address: "", paymentTerms: "" };
  const subtotal = items.reduce((s, it) => s + it.qty * it.unitPrice, 0);
  const now = new Date(Date.now() + 9 * 3600 * 1000);
  const ymd = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-${String(now.getUTCDate()).padStart(2, "0")}`;
  const dateStr = ymd.replaceAll("-", ".");
  const timeStr = `${String(now.getUTCHours()).padStart(2, "0")}:${String(now.getUTCMinutes()).padStart(2, "0")}`;
  const orderDate = isRealDate(String(a.orderDate || "")) ? String(a.orderDate) : ymd;
  const deliveryDate = isRealDate(String(a.deliveryDate || "")) ? String(a.deliveryDate) : "";
  const title = String(a.title || "").trim().slice(0, 120) || `${supplier.name} - ${items.map((it) => it.name).slice(0, 2).join(", ")}${items.length > 2 ? " 외" : ""}`;
  const list = (d) => (Array.isArray(d) ? d.map((r, i) => [String(i), r]) : Object.entries(d || {})).filter(([, r]) => r);
  const plan = await safeSectionWrite("purchaseOrders", (d) => {
    const dup = list(d).find(([, r]) => r.campusToken === token);
    if (dup) return { done: true, result: { 결과: "이미 저장됨", id: dup[1].id } };
    const key = Array.isArray(d) || d == null ? String(d ? d.length : 0) : `c${Date.now()}`;
    const ids = new Set(list(d).map(([, r]) => String(r.id))); let id = `po${Date.now().toString(36)}`; while (ids.has(id)) id += "x";
    const row = { id, title, dateStr, timeStr, savedAt: Date.now(), supplier, items, photos: [], orderDate, deliveryDate,
      paymentTerms: String(a.paymentTerms || "").slice(0, 80), deliveryPlace: String(a.deliveryPlace || "").slice(0, 120), memo: String(a.memo || "").slice(0, 1000),
      body, poStyle: String(a.style || "apple"), officialTerms: {}, totalAmount: subtotal + Math.round(subtotal * 0.1), fromCampus: true, campusToken: token };
    const apply = (dd) => { if (Array.isArray(dd) || dd == null) { const x = [...(dd || [])]; x[Number(key)] = row; return x; } return { ...dd, [key]: row }; };
    return { patch: { [key]: row }, apply, check: (dd) => list(dd).some(([, r]) => r.campusToken === token), result: { 결과: "발주 이력에 저장", id, 제목: title, 공급처: supplier.name, 공급처목록에있음: !!found, 품목수: items.length, 합계: row.totalAmount, 되돌리기: "회사앱 발주 관리 → 발주 이력에서 이 건 삭제" } };
  }, env);
  return plan.isError ? plan : textContent(plan.result);
}

// 세무 탭의 납부일만 기록/해제한다. 유일한 쓰기 도구이므로 대상과 형식을 엄격히 검증한다.
async function toolMarkTaxPaid(args, env) {
  const id = args.id;
  if (id === undefined || id === null || String(id).trim() === "") {
    return errContent("id가 필요합니다. get_business_section(section:\"taxes\")로 대상 건의 id를 먼저 확인하세요.");
  }
  const paidDate = String(args.paidDate ?? "");
  if (paidDate !== "" && !isRealDate(paidDate)) {
    return errContent(
      `paidDate 가 잘못됐습니다: "${paidDate}". 실제로 존재하는 YYYY-MM-DD 날짜 또는 빈 문자열이어야 합니다.`);
  }

  const data = await fbGet("/frw/taxes", env.FIREBASE_DB_SECRET);
  const found = findRecordKey(data, id);
  if (!found) return errContent(`세무 탭에 id=${id} 인 건이 없습니다.`);

  const before = found.record.paidDate || "";
  if (before === paidDate) {
    return textContent({
      결과: "변경 없음",
      사유: paidDate === "" ? "이미 미납 상태입니다." : `이미 ${paidDate} 로 기록돼 있습니다.`,
      건: { id: found.record.id, 세목: found.record.taxType, 기간: found.record.period, 사업체: found.record.biz },
    });
  }

  // 다른 기기의 옛 복사본에 덮이지 않도록 rev 를 올리는 경로로 쓴다
  await safeSectionWrite("taxes", (d) => {
    const f = findRecordKey(d, id);
    if (!f) return errContent(`세무 탭에 id=${id} 인 건이 없습니다.`);
    if ((f.record.paidDate || "") === paidDate) return { done: true };
    const row = { ...f.record, paidDate };
    const setRow = (dd) => { if (Array.isArray(dd)) { const a = [...dd]; a[Number(f.key)] = row; return a; } return { ...dd, [f.key]: row }; };
    return { patch: { [f.key]: row }, apply: setRow, check: (dd) => { const g = findRecordKey(dd, id); return !!g && (g.record.paidDate || "") === paidDate; } };
  }, env);

  return textContent({
    결과: paidDate === "" ? "납부 기록 해제" : "납부일 기록 완료",
    건: {
      id: found.record.id,
      세목: found.record.taxType,
      기간: found.record.period,
      사업체: found.record.biz,
      금액: found.record.amount,
      기한: found.record.dueDate,
    },
    이전_납부일: before || "(없음)",
    변경_납부일: paidDate || "(없음)",
  });
}

async function callTool(params, env) {
  const name = params?.name;
  const args = params?.arguments || {};
  if (!env.FIREBASE_DB_SECRET) return errContent("FIREBASE_DB_SECRET 미설정 — worker secret 확인 필요");
  try {
    if (name === "search_tenders") return await toolSearchTenders(args, env);
    if (name === "search_quotes") return await toolSearchQuotes(args, env);
    if (name === "get_business_section") return await toolGetSection(args, env);
    if (name === "search_purchases") return await toolSearchPurchases(args, env);
    if (name === "get_pricing") return await toolGetPricing(args, env);
    if (name === "get_campus_snapshot") return textContent(await buildCampusSnapshot(env));
    if (name === "record_intake") return await toolRecordIntake(args, env);
    if (name === "mark_tax_paid") return await toolMarkTaxPaid(args, env);
    if (name === "list_backups") return await toolListBackups(args, env);
    if (name === "get_backup_section") return await toolGetBackupSection(args, env);
    return errContent(`알 수 없는 도구: ${name}`);
  } catch (e) {
    return errContent(`도구 실행 오류: ${e?.message || String(e)}`);
  }
}

function rpcRespond(request, id, result, error) {
  const payload = error ? { jsonrpc: "2.0", id: id ?? null, error } : { jsonrpc: "2.0", id, result };
  const accept = request.headers.get("accept") || "";
  const cors = { "Access-Control-Allow-Origin": "*" };
  if (accept.includes("text/event-stream")) {
    const body = `event: message\ndata: ${JSON.stringify(payload)}\n\n`;
    return new Response(body, { status: 200, headers: { ...cors, "Content-Type": "text/event-stream" } });
  }
  return new Response(JSON.stringify(payload), { status: 200, headers: { ...cors, "Content-Type": "application/json" } });
}

export async function handleMcp(request, env, url) {
  if (!url) url = new URL(request.url);
  // 선택적 토큰 잠금: env.MCP_TOKEN이 설정돼 있으면 ?k=<토큰> 또는 Authorization: Bearer <토큰> 일치 필요.
  // 미설정 시 authless(공개). 민감 데이터를 노출하므로 운영 시 토큰 설정 권장.
  //   등록: npx wrangler secret put MCP_TOKEN
  //   커넥터 URL: https://<worker>/mcp?k=<토큰>
  if (env.MCP_TOKEN) {
    const provided = url.searchParams.get("k") || (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    if (provided !== env.MCP_TOKEN) {
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }
  }

  // 서버 주도 SSE 스트림(GET) 미지원 — stateless.
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
  }

  let msg;
  try {
    msg = await request.json();
  } catch {
    return rpcRespond(request, null, undefined, { code: -32700, message: "Parse error" });
  }
  if (Array.isArray(msg)) {
    return rpcRespond(request, null, undefined, { code: -32600, message: "배치 요청 미지원" });
  }

  const { id, method, params } = msg || {};

  // 알림(notification: id 없음) → 본문 없이 202.
  if (id === undefined || id === null) {
    return new Response(null, { status: 202, headers: { "Access-Control-Allow-Origin": "*" } });
  }

  if (method === "initialize") {
    return rpcRespond(request, id, {
      protocolVersion: (params && params.protocolVersion) || DEFAULT_PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
  }
  if (method === "ping") {
    return rpcRespond(request, id, {});
  }
  if (method === "tools/list") {
    return rpcRespond(request, id, { tools: TOOLS });
  }
  if (method === "tools/call") {
    const result = await callTool(params, env);
    return rpcRespond(request, id, result);
  }

  return rpcRespond(request, id, undefined, { code: -32601, message: `Method not found: ${method}` });
}


// ── 이카운트 → 앱 재고(stock) 동기화 ──
// 앱 재고 탭의 「엑셀 전체 반영」과 같은 규칙: 품목 전체 교체, 안전재고는 품목코드(없으면 이름+규격)로 이어받고,
// 바뀌기 직전 수량을 history 에 남긴다(최근 8회). 이카운트가 정답이라 캠퍼스 실사 조정도 덮인다.
// 안전장치: 0건이거나 품목 수가 절반 넘게 줄면 쓰지 않는다 (응답 형식이 바뀌었을 때 재고를 날리지 않게).
// ── 판매현황 최신 반영 안내 (Claude 가 브라우저로 이카운트 판매조회를 읽어 넣을 때) ──
// 이카운트 OpenAPI 에 판매 「조회」가 없어서, 사용자가 로그인해 둔 브라우저(Claude in Chrome 등)로 판매조회 화면을 읽는다.
// 비밀번호는 묻지도 저장하지도 않는다. 이카운트에서는 읽기만 한다. 넣기는 _write op sales_import (그 기간을 통째로 바꿈 → 중복 없음).
async function salesGuide(env, arg = "") {
  const kst = (ms) => new Date(ms + 9 * 3600e3).toISOString().slice(0, 10);
  const today = kst(Date.now());
  const monthEnd = (ym) => { const [y, m] = ym.split("-").map(Number); return `${ym}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0")}`; };
  let from, to;
  const m = String(arg || "").match(/^(\d{4}-\d{2}-\d{2})~(\d{4}-\d{2}-\d{2})$/);
  if (m) { from = m[1]; to = m[2]; }
  else {
    // 기본: 이번 달 1일 ~ 이번 달 말일 (월초 7일까지는 지난달 1일부터 — 지난달 마감 전표 수정분도 다시 받는다). 앞당겨 끊은 전표 때문에 끝은 말일.
    const d = Number(today.slice(8));
    const [y, mo] = today.split("-").map(Number);
    const prevYm = new Date(Date.UTC(y, mo - 2, 1)).toISOString().slice(0, 7);
    from = d <= 7 ? `${prevYm}-01` : `${today.slice(0, 8)}01`;
    to = monthEnd(today.slice(0, 7));
  }
  let before = null;
  try { const r = await salesSummary(env, from, to, { top: 0 }); before = { 전표: r.totals.count, 합계: r.totals.total, 마지막업로드: r.lastImport ? `${r.lastImport.at} (${r.lastImport.from}~${r.lastImport.to})` : null }; } catch {}
  const at = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 16).replace("T", " ");
  return {
    할일: "이카운트 판매조회 화면을 브라우저로 읽어 회사 앱 「판매 현황」에 최신 내역을 반영",
    기간: { from, to },
    지금_앱에_있는_것: before,
    순서: [
      "1. 브라우저 도구(Claude in Chrome 등)로 사용자의 Chrome 에서 작업한다. 브라우저 도구가 없으면 여기서 멈추고 '컴퓨터의 Chrome 에서 Claude(Claude in Chrome 옆 창)로 다시 요청해 주세요'라고 알린다.",
      "2. 새 탭에서 https://login.ecount.com 을 연다. 이미 로그인돼 있으면 ERP 로 들어간다. 로그인 화면이면 사용자에게 직접 로그인해 달라고 하고 기다린다 — 아이디·비밀번호를 묻거나 입력하지 않는다.",
      "3. 메뉴 「영업관리 → 판매 → 판매조회」(또는 화면 위 메뉴 검색에 '판매조회')를 연다. 기간을 위의 from~to 로 맞추고 조회한다. 거래처·창고 조건은 비워 둔다(전체).",
      `4. 가능하면 품목이 한 줄씩 나오는 보기(상세·품목별)로 바꿔 일자-No.·거래처명·품목명·규격·수량·단가·공급가액·부가세·합계를 읽는다. 그런 보기가 없으면 전표 목록(일자-No.·거래처명·품목명(요약)·금액합계)을 읽는다. 한 페이지에 다 안 나오면 페이지 표시 수를 최대로 하거나 모든 페이지를 넘겨 빠짐없이 읽는다. 맨 아래 합계/소계 줄은 넣지 않는다.`,
      "5. 줄마다 값을 만든다: d=일자(YYYY-MM-DD, 「20261030-2」 → 2026-10-30), no=일자-No. 의 뒤 번호(「-2」 → \"2\"), c=거래처명, name=품목명, spec=규격, qty=수량, price=단가, supply=공급가액, vat=부가세, total=합계(또는 금액합계). 숫자는 쉼표 없이, 마이너스(반품)는 그대로 음수. 전표 목록만 읽었으면 각 줄에 slip:true 를 넣고 qty 는 0.",
      "6. 화면의 총 건수·총 합계와 내가 읽은 줄 수·합계가 맞는지 확인한다. 안 맞으면 다시 읽는다.",
      `7. 반영: get_business_section 의 section 에 \`_write:\` 뒤에 JSON 을 붙여 호출 — {\"op\":\"sales_import\",\"fileName\":\"Claude 판매조회 ${at}\",\"from\":\"<기간 시작>\",\"to\":\"<기간 끝>\",\"rows\":[...]}. 그 기간 안의 기존 기록은 통째로 바뀐다(중복 없음). 줄이 300개가 넘으면 날짜를 겹치지 않게 나눠 여러 번 보낸다(각 호출의 from~to 가 그 줄들의 날짜 범위를 빈틈없이 덮게).`,
      "8. 끝나면 get_business_section 「_sales:<from>~<to>」 로 다시 읽어 사용자에게 알린다: 반영한 기간, 전표(줄) 수, 합계, 반영 전과 비교해 늘어난 건수·금액, 마이너스(반품) 전표가 있으면 그 목록.",
    ],
    지킬것: [
      "이카운트에서는 읽기만 한다 — 전표를 고치거나 지우거나 새로 만들지 않는다.",
      "비밀번호·인증번호를 묻거나 저장하지 않는다. 로그인은 사용자가 직접.",
      "확신이 없는 값(일자·금액이 안 읽힘)은 넣지 말고 사용자에게 그 줄을 알려 준다.",
    ],
  };
}
const ECOUNT_STATUS_PATH = "/frw_ecount_status";
export async function ecountSyncStock(env, by = "cron", { force = false, got: given = null } = {}) {
  const S = env.FIREBASE_DB_SECRET;
  const at = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 16).replace("T", " ");
  const record = async (st) => {
    try { await fetch(`https://${FB_HOST}${ECOUNT_STATUS_PATH}.json?auth=${encodeURIComponent(S)}`, { method: "PUT", body: JSON.stringify({ ...st, at, by }) }); } catch {}
    return st;
  };
  if (!given && !ecountConfigured(env)) return { ok: false, configured: false, message: "이카운트 연동 정보가 아직 등록되지 않았습니다" };
  let got = given;
  if (!got) { try { got = await ecountStockItems(env); } catch (e) { return record({ ok: false, error: e.message }); } }
  const fresh = got.items;
  if (!fresh.length) return record({ ok: false, error: `이카운트 재고가 0건으로 왔습니다 (재고 행 ${got.invRows}) — 반영하지 않았습니다` });
  let summary = null, plan, before = null;
  try { plan = await safeSectionWrite("stock", (d) => {
    const cur = d && typeof d === "object" ? d : {};
    const old = asList(cur.items);
    before = { source: cur.source, at: cur.updatedAt || "", items: old };
    if (!force && old.length >= 20 && fresh.length < old.length * 0.5) {
      return errContent(`품목 수가 ${old.length} → ${fresh.length} 로 크게 줄어 반영하지 않았습니다 (확인 후 강제 반영)`);
    }
    const key = (it) => String(it.code || "").trim() || `${it.name}|${it.spec || ""}`;
    const prev = new Map(old.map((it) => [key(it), it]));
    // 엑셀에 품목코드가 없던 옛 재고는 코드로 못 찾는다 → 이름이 같은 것으로 한 번 더 찾는다
    const byName = new Map(old.filter((it) => !String(it.code || "").trim()).map((it) => [String(it.name || "").trim(), it]));
    let base = Date.now();
    const items = fresh.map((it) => {
      const o = prev.get(key(it)) || byName.get(String(it.name || "").trim());
      // 이미 있던 품목은 이름·규격·단위·분류를 그대로 둔다 (엑셀 때 쓰던 표기 유지 — 화면·매칭이 흔들리지 않게)
      return { ...it, id: o && o.id != null ? o.id : ++base,
        name: (o && o.name) || it.name || it.code, spec: o ? (o.spec || "") : (it.spec || ""), unit: (o && o.unit) || it.unit || "", cat: (o && o.cat) || it.cat || "",
        safeQty: o && o.safeQty != null ? o.safeQty : "" };
    });
    let history = Array.isArray(cur.history) ? cur.history.slice() : asList(cur.history);
    if (old.length) {
      // 품목코드가 키가 된다 — "NFWF25/090" 처럼 Firebase 금지문자(/ . 등)는 앱과 같은 ~HEX 로 바꿔 저장 (안 하면 저장이 400 으로 실패)
      const qty = {}; old.forEach((it) => { qty[fbEsc(key(it))] = toNumber(it.qty); });
      history.push({ updatedAt: cur.updatedAt || "", fileName: cur.fileName || "", qty });
      if (history.length > 8) history = history.slice(-8);
    }
    const changed = items.filter((it) => { const o = prev.get(key(it)); return !o || toNumber(o.qty) !== toNumber(it.qty); }).length;
    summary = { 품목수: items.length, 바뀐품목: changed, 이전품목수: old.length };
    const next = { ...cur, items, history, updatedAt: at, fileName: "이카운트 자동 연동", source: "ecount" };
    const patch = { items, history, updatedAt: at, fileName: "이카운트 자동 연동", source: "ecount" };
    return { patch, apply: () => next, check: (dd) => !!dd && dd.updatedAt === at && asList(dd.items).length === items.length };
  }, env); } catch (e) { return record({ ok: false, error: `재고 저장 실패: ${e.message}` }); }
  if (plan.isError) return record({ ok: false, error: (plan.content && plan.content[0] && plan.content[0].text) || "반영 실패" });
  try { await recordStockMoves(env, fresh, before, at, by); } catch (e) { console.error("[ecount] 출고 기록 실패:", e?.message ?? e); }
  return record({ ok: true, ...summary, test: !!got.test });
}
export async function ecountStatus(env) {
  const S = env.FIREBASE_DB_SECRET;
  const [st, req, seen] = ecountConfigured(env) ? await Promise.all([fbGet(ECOUNT_STATUS_PATH, S).catch(() => null), fbGet(ECOUNT_REQ_PATH, S).catch(() => null), fbGet(ECOUNT_SEEN_PATH, S).catch(() => null)]) : [null, null, null];
  // 중계 컴퓨터별 마지막 확인 시각 — 1분마다 요청을 확인하므로, 몇 분 넘게 소식이 없으면 꺼졌거나 잠자기 중
  const relays = Object.entries(seen || {}).map(([dev, ts]) => ({ dev, label: relayDevLabel(dev), ts: Number(ts) || 0 })).sort((a, b) => b.ts - a.ts);
  // 테스트/실서버는 실제로 성공한 마지막 동기화 기준 (키 종류를 자동 판별하므로)
  return { configured: ecountConfigured(env), direct: ecountDirect(env), test: st && typeof st.test === "boolean" ? st.test : String(env.ECOUNT_TEST ?? "true") !== "false", last: st || null, request: liveReq(req), relays, now: Date.now() };
}

// ── 새로고침 요청 (정해진 시간 없이, 부를 때만) ──
// 앱 「새로고침」 단추나 Claude 가 요청을 걸어 두면, 사무실 맥이 1분마다 확인하다가 그때만 이카운트를 조회해 보낸다.
// 맥이 잠자기 중이면 깨어난 뒤 처리한다. 12시간 지난 요청은 버린다(어제 저녁 요청이 다음 날 아침에 도는 것 방지).
const ECOUNT_REQ_PATH = "/frw_ecount_request";
const REQ_TTL = 12 * 3600e3;
const liveReq = (r) => (r && r.ts && Date.now() - Number(r.ts) < REQ_TTL ? r : null);
const kstAtMs = (at) => Date.parse(String(at || "").replace(" ", "T") + ":00+09:00");
export async function ecountRequest(env, by = "app", { cancel = false } = {}) {
  if (!ecountConfigured(env)) return { ok: false, configured: false, error: "이카운트 연동 정보가 아직 등록되지 않았습니다" };
  if (cancel) { await clearReq(env); return { ok: true, cancelled: true, message: "새로고침 요청을 취소했어요" }; }
  if (ecountDirect(env)) return ecountSyncStock(env, by);
  const S = env.FIREBASE_DB_SECRET;
  const [st, req] = await Promise.all([fbGet(ECOUNT_STATUS_PATH, S).catch(() => null), fbGet(ECOUNT_REQ_PATH, S).catch(() => null)]);
  if (liveReq(req)) return { ok: true, queued: true, already: true, message: "이미 요청돼 있어요 — 켜져 있는 중계 컴퓨터가 1분 안에 가져옵니다", requestedAt: req.at };
  // 이카운트 실서버는 같은 조회를 10분에 1번만 받는다 → 막힐 요청은 걸지 않는다
  const lastMs = st && st.at ? kstAtMs(st.at) : NaN;
  if (Number.isFinite(lastMs) && Date.now() - lastMs < 10 * 60e3) {
    const next = new Date(lastMs + 11 * 60e3 + 9 * 3600e3).toISOString().slice(11, 16);
    return { ok: false, wait: true, error: `이카운트는 10분에 한 번만 조회돼요 — ${next} 이후에 다시 눌러 주세요 (마지막 ${String(st.at).slice(11)})` };
  }
  const at = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 16).replace("T", " ");
  await fetch(`https://${FB_HOST}${ECOUNT_REQ_PATH}.json?auth=${encodeURIComponent(S)}`, { method: "PUT", body: JSON.stringify({ at, ts: Date.now(), by }) });
  return { ok: true, queued: true, message: "새로고침을 요청했어요 — 사무실 맥·집 PC 중 켜져 있는 컴퓨터가 1분 안에 가져옵니다", requestedAt: at };
}
// 중계 컴퓨터 이름 (헤더 X-Relay-Dev) — 사무실 맥·집 PC 가 같은 요청을 둘 다 처리하지 않게 먼저 잡은 한 대만 처리한다
const RELAY_DEVS = { "office-mac": "사무실 맥", "home-pc": "집 PC" };
export const relayDevLabel = (dev) => RELAY_DEVS[dev] || (dev ? String(dev).slice(0, 20) : "사무실 맥");
const CLAIM_TTL = 3 * 60e3;   // 잡은 컴퓨터가 3분 안에 못 보내면(꺼짐·끊김) 다른 컴퓨터가 이어받는다
const ECOUNT_SEEN_PATH = "/frw_ecount_seen";   // { <dev>: 마지막으로 요청을 확인한 시각(ms) }
export async function ecountPending(env, dev = "") {
  const S = env.FIREBASE_DB_SECRET;
  if (dev && /^[a-z0-9-]{1,20}$/.test(dev)) {
    try { await fetch(`https://${FB_HOST}${ECOUNT_SEEN_PATH}/${dev}.json?auth=${encodeURIComponent(S)}`, { method: "PUT", body: String(Date.now()) }); } catch {}
  }
  const { etag, value } = await fbGetTagged(ECOUNT_REQ_PATH, S);
  const req = liveReq(value);
  if (!req) return { pending: false };
  const c = req.claim;
  if (c && c.dev !== dev && Date.now() - Number(c.ts) < CLAIM_TTL) return { pending: false };
  const won = await fbPutIfMatch(ECOUNT_REQ_PATH, { ...req, claim: { dev, ts: Date.now(), label: relayDevLabel(dev) } }, etag, S);
  return won ? { pending: true, at: req.at } : { pending: false };
}
const clearReq = (env) => fetch(`https://${FB_HOST}${ECOUNT_REQ_PATH}.json?auth=${encodeURIComponent(env.FIREBASE_DB_SECRET)}`, { method: "DELETE" }).catch(() => {});
// ── 출고·입고 추정 ──
// 새로고침마다 「직전 이카운트 수량 → 이번 수량」 차이를 남긴다. 줄어든 만큼 = 출고(판매·샘플·불량 포함), 늘어난 만큼 = 입고(반품 포함).
// 앱에서 손으로 고친 수량(실사 조정·엑셀)과 섞이지 않게, 기준은 늘 직전 「이카운트 원본 수량」(/frw_ecount_last)이다.
//   /frw_ecount_last          = { at, qty: { 품목코드(이스케이프): 수량 } }
//   /frw_stock_moves/<날짜>/<id> = { at, from, by, out: {코드: 수량}, in: {코드: 수량} }   — 날짜 = 새로고침한 날(KST)
const ECOUNT_LAST_PATH = "/frw_ecount_last";
const MOVES_PATH = "/frw_stock_moves";
async function recordStockMoves(env, fresh, prev, at, by) {
  const S = env.FIREBASE_DB_SECRET;
  const last = await fbGet(ECOUNT_LAST_PATH, S).catch(() => null);
  let base = null, from = "";
  if (last && last.qty) { base = {}; for (const [k, v] of Object.entries(last.qty)) base[fbUnesc(k)] = toNumber(v); from = last.at || ""; }
  else if (prev && prev.source === "ecount") {   // 처음 한 번: 직전 재고가 이카운트에서 온 것이면 그걸 기준으로
    base = {}; for (const it of prev.items) if (String(it.code || "").trim()) base[String(it.code).trim()] = toNumber(it.qty);
    from = prev.at;
  }
  const now = {}; for (const it of fresh) now[it.code] = toNumber(it.qty);
  if (base) {
    const out = {}, inn = {};
    for (const code of new Set([...Object.keys(base), ...Object.keys(now)])) {
      const d = (now[code] || 0) - (base[code] || 0);
      if (d < 0) out[fbEsc(code)] = -d; else if (d > 0) inn[fbEsc(code)] = d;
    }
    if (Object.keys(out).length || Object.keys(inn).length) {
      const day = at.slice(0, 10);
      await fetch(`https://${FB_HOST}${MOVES_PATH}/${day}/${Date.now()}.json?auth=${encodeURIComponent(S)}`, { method: "PUT", body: JSON.stringify({ at, from, by, out, in: inn }) });
    }
  }
  const qty = {}; for (const [k, v] of Object.entries(now)) qty[fbEsc(k)] = v;
  await fetch(`https://${FB_HOST}${ECOUNT_LAST_PATH}.json?auth=${encodeURIComponent(S)}`, { method: "PUT", body: JSON.stringify({ at, qty }) });
}

// 기간(KST 날짜, 양끝 포함) 출고·입고 합계 — 품목(사이즈 묶음)별·날짜별
export async function stockMoves(env, from, to) {
  const S = env.FIREBASE_DB_SECRET;
  const q = `orderBy=${encodeURIComponent('"$key"')}&startAt=${encodeURIComponent(JSON.stringify(from))}&endAt=${encodeURIComponent(JSON.stringify(to))}`;
  const r = await fetch(`https://${FB_HOST}${MOVES_PATH}.json?${q}&auth=${encodeURIComponent(S)}`);
  if (!r.ok) throw new Error(`Firebase ${r.status}`);
  const byDay = (await r.json()) || {};
  const stock = await fbGet("/frw/stock", S).catch(() => null);
  const info = new Map(asList(stock && stock.items).map((it) => [String(it.code || "").trim(), it]));
  const per = new Map(), days = [];
  let syncs = 0, first = "", lastAt = "";
  for (const day of Object.keys(byDay).sort()) {
    let dOut = 0, dIn = 0;
    for (const e of Object.values(byDay[day] || {})) {
      if (!e) continue;
      syncs++; if (!first || (e.from || e.at) < first) first = e.from || e.at; if (e.at > lastAt) lastAt = e.at;
      for (const [kind, map] of [["out", e.out], ["in", e.in]]) for (const [k, v] of Object.entries(map || {})) {
        const code = fbUnesc(k), n = toNumber(v);
        const row = per.get(code) || { code, out: 0, in: 0 }; row[kind] += n; per.set(code, row);
        if (kind === "out") dOut += n; else dIn += n;
      }
    }
    days.push({ date: day, out: dOut, in: dIn });
  }
  // 「방염 춘추복 상의(2025) [100]」 → 품목 「방염 춘추복 상의(2025)」 · 사이즈 「100」 으로 묶는다
  const groups = new Map();
  for (const row of per.values()) {
    const it = info.get(row.code) || {};
    const name = String(it.name || row.code);
    const m = name.match(/^(.*?)\s*\[([^\]]+)\]\s*$/);
    const base = m ? m[1] : name, size = m ? m[2] : (row.code.includes("/") ? row.code.split("/").pop() : "");
    const g = groups.get(base) || { name: base, out: 0, in: 0, sizes: [] };
    g.out += row.out; g.in += row.in; g.sizes.push({ code: row.code, size, out: row.out, in: row.in, qty: it.qty != null ? toNumber(it.qty) : null });
    groups.set(base, g);
  }
  const products = [...groups.values()].map((g) => ({ ...g, sizes: g.sizes.sort((a, b) => String(a.size).localeCompare(String(b.size), "ko", { numeric: true })) }))
    .sort((a, b) => b.out - a.out || b.in - a.in);
  const sum = (k) => products.reduce((t, g) => t + g[k], 0);
  return { from, to, syncs, span: syncs ? { from: first, to: lastAt } : null, totalOut: sum("out"), totalIn: sum("in"), products, days };
}

// 이카운트는 등록된 IP 에서만 API 를 받는다(테스트 서버 포함). Cloudflare 는 나가는 IP 가 계속 바뀌어
// 직접 호출이 막히므로, 기본은 사무실 맥(등록된 고정 IP)이 받아서 보내 주는 중계 방식이다.
// ECOUNT_DIRECT="true" 면(고정 IP 를 쓸 수 있게 되면) 서버가 직접 가져온다.
export const ecountDirect = (env) => String(env.ECOUNT_DIRECT || "") === "true";

// 사무실 맥이 보낸 이카운트 원본 → 재고 반영. body = { inv: <재고 API 응답>, prod: <품목조회 응답>, error?, api? }
// 인증: 헤더 X-Relay-Key = SHA-256(ECOUNT_API_KEY) 16진수 — 맥과 서버가 같은 키를 갖고 있을 때만 통과.
export async function ecountRelayKey(env) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(env.ECOUNT_API_KEY || "").trim()));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
export async function ecountRelayPush(env, body, dev = "") {
  const label = relayDevLabel(dev);
  const S = env.FIREBASE_DB_SECRET;
  const at = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 16).replace("T", " ");
  await clearReq(env);   // 성공이든 실패든 요청은 처리됨 (실패는 띠에 이유가 뜨고, 다시 누르면 된다)
  if (body && body.error) {
    try { await fetch(`https://${FB_HOST}${ECOUNT_STATUS_PATH}.json?auth=${encodeURIComponent(S)}`, { method: "PUT", body: JSON.stringify({ ok: false, error: `[${label}] ${String(body.error).slice(0, 300)}`, at, by: label }) }); } catch {}
    return { ok: false, recorded: true };
  }
  const inv = ecountRows((body && body.inv) || {}), prod = ecountRows((body && body.prod) || {});
  const got = { ...buildStockItems(inv, prod), test: false };
  return ecountSyncStock(env, label, { got });
}
