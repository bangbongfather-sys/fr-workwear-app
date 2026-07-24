// ── Claude 커스텀 커넥터용 MCP 서버 (authless, stateless Streamable HTTP) ──
//
// claude.ai → 설정 → 커넥터 → 커스텀 커넥터 추가 → URL: https://<worker>/mcp
//
// 프로토콜: JSON-RPC 2.0 over HTTP POST /mcp.
//  - 세션/서버주도 스트리밍 없음(stateless). 단일 요청-응답만 처리.
//  - 클라이언트가 Accept: text/event-stream 요청 시 단일 message 이벤트(SSE)로 응답, 아니면 JSON.
//  - 인증 없음 — 개인/내부용. 민감 쓰기 도구는 추가하지 않고 읽기 전용만 노출.
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
  "stock", "payables", "bankDeposits", "prodTrash", "companySeal",
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

function computeProduct(p, materials, laborItems) {
  const mats = materials || [];
  const labor = laborItems || [];
  const spec = getActiveSpec(p) || p;
  const fCost = (spec.fabrics || []).reduce((s, f) => {
    const m = f.matId !== "" && f.matId != null ? mats.find((x) => x.id == f.matId) : null;
    return s + (m ? m.price * parseFloat(f.qty || 0) : 0);
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
    description: "단가 계산기의 제품별 A~D 등급 단가를 계산해 반환합니다. (원단비+공임+관리비+등급마진/오버라이드 반영)",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "제품명 부분검색 (선택, 없으면 전체)" },
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
];

async function fbGet(node, secret) {
  const url = `https://${FB_HOST}${node}.json?auth=${encodeURIComponent(secret)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Firebase ${res.status}`);
  return await res.json();
}

function textContent(obj) {
  const text = typeof obj === "string" ? obj : JSON.stringify(obj, null, 2);
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

async function toolGetSection(args, env) {
  const section = String(args.section || "");
  // 배포 확인용 마커 — 어떤 커밋이 라이브인지 원격에서 검증 (Claude가 배포 상태 점검에 사용)
  if (section === "_version") {
    return { content: [{ type: "text", text: JSON.stringify({ build: "2026-07-24-notion-calendar", note: "일정 캘린더 노션 캘린더식 재디자인 — 플랫 헤어라인 그리드(셀 간격 제거), 날짜 숫자 오른쪽 위·오늘 붉은 원, 인접 월 날짜 흐리게 표시, 이벤트를 제목·날짜·완료 체크가 있는 카드로 확대, 월 헤더에 ‹ 오늘 › 내비게이션 통합"}) }] };
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

async function toolGetPricing(args, env) {
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
  const out = filtered.map((p) => {
    const c = computeProduct(p, mats, labor);
    const gradePrices = {};
    for (const g of c.gradeList) gradePrices[g] = round(c.grades[g]);
    return {
      제품명: p.name,
      원가: round(c.base),
      관리비포함원가: round(c.beforeMargin),
      등급단가: gradePrices,
      선택등급: c.selectedGrade,
    };
  });
  return textContent({ 제품수: out.length, 제품: out });
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
