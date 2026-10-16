// ── 이카운트 판매현황 (엑셀로 가져오기) ──
// 이카운트 OpenAPI 에 판매 「조회」가 없어서, 앱 재고 탭에 판매현황 엑셀을 끌어다 놓으면 앱이 읽어 여기로 보낸다.
//   /frw_sales/<YYYY-MM-DD> = [ { d, c(거래처), code, name, spec, qty, price, supply(공급가), vat, total(합계), wh(창고) } ]
//   /frw_sales_meta        = { imports: [ { at, fileName, from, to, count, qty, total } ] }  (최근 30회)
// 같은 기간을 다시 올리면 그 기간의 날짜들을 통째로 바꾼다 → 중복 없이 몇 번이고 다시 올려도 된다.

const FB_HOST = "njsafety-2ee24-default-rtdb.asia-southeast1.firebasedatabase.app";   // mcp.js·worker.js 와 같게
const SALES_PATH = "/frw_sales";
const META_PATH = "/frw_sales_meta";
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const n = (v) => { const x = Number(String(v ?? "").replace(/[,\s원]/g, "")); return Number.isFinite(x) ? x : 0; };
const str = (v, max = 80) => String(v ?? "").trim().slice(0, max);
const url = (path, S, q = "") => `https://${FB_HOST}${path}.json?${q ? q + "&" : ""}auth=${encodeURIComponent(S)}`;
const addDay = (d, k) => { const t = new Date(d + "T00:00:00Z"); t.setUTCDate(t.getUTCDate() + k); return t.toISOString().slice(0, 10); };
const kstNow = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 16).replace("T", " ");

export async function salesImport(env, body) {
  const S = env.FIREBASE_DB_SECRET;
  const from = String(body && body.from || ""), to = String(body && body.to || "");
  if (!DAY.test(from) || !DAY.test(to) || from > to) return { ok: false, error: "기간(from·to)이 잘못됐습니다" };
  const span = Math.round((Date.parse(to) - Date.parse(from)) / 86400e3) + 1;
  if (span > 800) return { ok: false, error: "한 번에 800일까지만 올릴 수 있습니다" };
  const raw = Array.isArray(body.rows) ? body.rows : [];
  if (raw.length > 20000) return { ok: false, error: "행이 너무 많습니다 (2만 줄까지)" };
  const byDay = {};
  for (const r of raw) {
    const d = String(r && r.d || "");
    if (!DAY.test(d) || d < from || d > to) continue;
    const row = { d, c: str(r.c), code: str(r.code, 40), name: str(r.name, 120), spec: str(r.spec, 40), qty: n(r.qty), price: n(r.price), supply: n(r.supply), vat: n(r.vat), total: n(r.total), wh: str(r.wh, 30) };
    if (!row.name && !row.code) continue;
    (byDay[d] = byDay[d] || []).push(row);
  }
  // 기간 안의 모든 날짜를 바꾼다 (판매가 없던 날은 지운다)
  const patch = {};
  for (let d = from; d <= to; d = addDay(d, 1)) patch[d] = byDay[d] || null;
  const r = await fetch(url(SALES_PATH, S), { method: "PATCH", body: JSON.stringify(patch) });
  if (!r.ok) return { ok: false, error: `저장 실패 (Firebase ${r.status})` };
  const rows = Object.values(byDay).flat();
  const sum = (k) => rows.reduce((t, x) => t + x[k], 0);
  const entry = { at: kstNow(), fileName: str(body.fileName, 100), from, to, count: rows.length, qty: sum("qty"), total: sum("total") || sum("supply") };
  try {
    const m = await (await fetch(url(META_PATH, S))).json();
    const imports = (m && Array.isArray(m.imports) ? m.imports : []).concat(entry).slice(-30);
    await fetch(url(META_PATH, S), { method: "PUT", body: JSON.stringify({ imports }) });
  } catch {}
  return { ok: true, ...entry };
}

// 품목명 「방염 춘추복 상의(2025) [100]」 → 품목 「방염 춘추복 상의(2025)」 · 사이즈 「100」
function splitName(name, spec, code) {
  const m = String(name || "").match(/^(.*?)\s*\[([^\]]+)\]\s*$/);
  if (m) return [m[1], m[2]];
  if (spec) return [name, spec];
  return [name || code, String(code || "").includes("/") ? String(code).split("/").pop() : ""];
}

// 기간 요약 — 합계 · 품목(사이즈 묶음)별 · 거래처별 · 날짜별 + 그 기간 중 엑셀이 들어온 범위
export async function salesSummary(env, from, to, { top = 80 } = {}) {
  const S = env.FIREBASE_DB_SECRET;
  const q = `orderBy=${encodeURIComponent('"$key"')}&startAt=${encodeURIComponent(JSON.stringify(from))}&endAt=${encodeURIComponent(JSON.stringify(to))}`;
  const [rr, mr] = await Promise.all([fetch(url(SALES_PATH, S, q)), fetch(url(META_PATH, S))]);
  if (!rr.ok) throw new Error(`Firebase ${rr.status}`);
  const byDay = (await rr.json()) || {};
  const meta = mr.ok ? await mr.json() : null;
  const groups = new Map(), clients = new Map(), days = [];
  const tot = { count: 0, qty: 0, supply: 0, vat: 0, total: 0 };
  for (const d of Object.keys(byDay).sort()) {
    const list = Array.isArray(byDay[d]) ? byDay[d] : Object.values(byDay[d] || {});
    let dq = 0, dt = 0;
    for (const r of list) {
      if (!r) continue;
      const amt = r.total || r.supply || 0;
      tot.count++; tot.qty += r.qty || 0; tot.supply += r.supply || 0; tot.vat += r.vat || 0; tot.total += amt;
      dq += r.qty || 0; dt += amt;
      const [base, size] = splitName(r.name, r.spec, r.code);
      const g = groups.get(base) || { name: base, qty: 0, total: 0, sizes: new Map() };
      g.qty += r.qty || 0; g.total += amt;
      const zk = size || r.code || "";
      const z = g.sizes.get(zk) || { size: size || "", code: r.code || "", qty: 0, total: 0 };
      z.qty += r.qty || 0; z.total += amt; g.sizes.set(zk, z);
      groups.set(base, g);
      const ck = r.c || "(거래처 없음)";
      const c = clients.get(ck) || { name: ck, qty: 0, total: 0, count: 0 };
      c.qty += r.qty || 0; c.total += amt; c.count++; clients.set(ck, c);
    }
    days.push({ date: d, qty: dq, total: dt });
  }
  const products = [...groups.values()]
    .map((g) => ({ name: g.name, qty: g.qty, total: g.total, sizes: [...g.sizes.values()].sort((a, b) => String(a.size).localeCompare(String(b.size), "ko", { numeric: true })) }))
    .sort((a, b) => b.qty - a.qty || b.total - a.total);
  const clientList = [...clients.values()].sort((a, b) => b.total - a.total || b.qty - a.qty);
  // 이 기간 중 엑셀로 들어온 범위 (빈 날이 「판매 없음」인지 「아직 안 올림」인지 구분용)
  const covered = (meta && Array.isArray(meta.imports) ? meta.imports : [])
    .filter((i) => i && i.to >= from && i.from <= to)
    .map((i) => ({ from: i.from < from ? from : i.from, to: i.to > to ? to : i.to, at: i.at, fileName: i.fileName }));
  const lastImport = meta && Array.isArray(meta.imports) && meta.imports.length ? meta.imports[meta.imports.length - 1] : null;
  return { from, to, totals: tot, products: products.slice(0, top), productCount: products.length, clients: clientList.slice(0, 50), clientCount: clientList.length, days, covered, lastImport };
}
