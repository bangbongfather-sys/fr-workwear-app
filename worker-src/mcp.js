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
    return { content: [{ type: "text", text: JSON.stringify({ build: "2026-07-30-ledger-row-width", note: "장부 표 행이 짧게 끊기던 문제 수정 — 전역 table 규칙의 display:block 때문에 블록 박스만 늘어나고 thead/tbody는 max-content에 머물러 행·확장 패널이 헤더보다 짧았다(측정 971px vs 헤더 1512px). 월별 장부·거래처별 미수금 표를 table-plain(display:table·width:100%)으로 전환해 헤더와 폭 일치, 가로 스크롤은 기존 래퍼가 담당(모바일 정상)"}) }] };
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
  if (section === "_stock") {
    const st = await fbGet("/frw/stock", env.FIREBASE_DB_SECRET);
    const items = asList(st && st.items).map((i) => ({ 코드: i.code, 품명: i.name, 수량: toNumber(i.qty), 안전재고: i.safeQty === "" ? null : toNumber(i.safeQty) }));
    return textContent({ 반영시각: (st && st.updatedAt) || null, 품목수: items.length, 품목: items });
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
  // 일정 전체(최근 60일~앞으로 60일, 미완료 우선) — AI 직원 조회용
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
    for (const [k, v] of Object.entries(plan.patch)) body[`${section}/${k}`] = v;
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
      const row = { id, date, endDate: "", text: text.slice(0, 200), memo: a.memo ? String(a.memo).slice(0, 300) : "", done: false, createdAt: Date.now(), atts: [], campusToken: token, fromCampus: true };
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
  const byDate = (a, b) => `${b.date} ${b.time || ""}`.localeCompare(`${a.date} ${a.time || ""}`);
  const off = Math.max(0, Number(opt.offset) || 0), lim = Math.min(200, Math.max(1, Number(opt.limit) || 40));
  const bizF = opt.biz === "nj" || opt.biz === "corp" ? opt.biz : null;
  const qm = depQueryMatcher(opt.q);
  const pendAll = items.filter((x) => x.status === "pending" && (!bizF || (x.biz === "corp" ? "corp" : "nj") === bizF)
    && (!qm || qm([x.name, x.memo, suggest(x.name)].filter(Boolean).join("\u0001")))).sort(byDate);
  const pending = pendAll.slice(off, off + lim)
    .map((x) => ({ id: x.id, date: x.date, time: x.time || "", name: x.name || "", amount: toNumber(x.amount), biz: x.biz === "corp" ? "corp" : "nj", memo: x.memo || "", suggest: suggest(x.name) }));
  const done = items.filter((x) => x.status === "done").sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0)).slice(0, 15)
    .map((x) => ({ id: x.id, date: x.date, name: x.name || "", amount: toNumber(x.amount), client: x.client || "", link: x.link || null, doneAt: x.doneAt || null }));
  // 화면에 나온 입금의 추천 거래처 미입금 청구만 넘겨 응답을 작게 유지한다
  const need = new Set(pending.map((x) => x.suggest).filter(Boolean));
  const unpaidSmall = {}; for (const n of need) if (unpaid[n]) unpaidSmall[n] = unpaid[n].filter((u) => u.total > 0).slice(0, 6);
  return { pendingCount: items.filter((x) => x.status === "pending").length, filtered: pendAll.length, filteredTotal: pendAll.reduce((t, x) => t + toNumber(x.amount), 0), offset: off, limit: lim, pending, done, unpaid: unpaidSmall, clientNames };
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
  if (op === "todo_add" || op === "todo_done") return await toolTodo(a, env);
  if (op === "deposit_process") return await toolDepositProcess(a, env);
  if (op === "deposit_undo") return await toolDepositUndo(a, env);
  if (op === "deposit_batch") return await toolDepositBatch(a, env);
  if (op === "tax_paid") return await toolMarkTaxPaid({ id: a.id, paidDate: a.paidDate ?? "" }, env);
  return errContent(`알 수 없는 쓰기: ${op}`);
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
