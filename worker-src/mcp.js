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
  const stockOut = {
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
        const fieldDiff = ["name", "marketPrice", "memo", "category", "include", "activeSpecId"].filter((f) => JSON.stringify(b[f]) !== JSON.stringify(l[f])).map((f) => ({ field: f, backup: b[f], live: l[f] }));
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
