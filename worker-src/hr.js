// 인사 관리 — 서버(아침 알림)에서 쓰는 급여 계산.
// index.html 의 hrPayDate·hrCalcRow 와 같은 규칙이어야 한다 (앱은 한 파일이라 가져다 쓸 수 없어 옮겨 둔다).

// 공휴일 — 급여일이 쉬는 날이면 앞 영업일로 당긴다. 앱의 HR_HOLIDAYS 와 같게 유지할 것.
const HOLIDAYS = new Set([
  "2026-01-01", "2026-02-16", "2026-02-17", "2026-02-18", "2026-03-01", "2026-03-02", "2026-05-01", "2026-05-05",
  "2026-05-24", "2026-05-25", "2026-06-03", "2026-06-06", "2026-08-15", "2026-08-17", "2026-09-24", "2026-09-25",
  "2026-09-26", "2026-10-03", "2026-10-05", "2026-10-09", "2026-12-25",
  "2027-01-01", "2027-02-05", "2027-02-06", "2027-02-07", "2027-02-08", "2027-03-01", "2027-05-01", "2027-05-05",
  "2027-05-13", "2027-06-06", "2027-08-15", "2027-08-16", "2027-09-14", "2027-09-15", "2027-09-16", "2027-10-03",
  "2027-10-04", "2027-10-09", "2027-10-11", "2027-12-25", "2027-12-27",
]);
const RATES = { np: 0.0475, npMin: 400000, npMax: 6370000, hi: 0.03595, ltOfHi: 0.1314, ei: 0.009, mealFree: 200000, localOfIt: 0.1 };

const ymd = (d) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
const parse = (s) => { const [y, m, d] = String(s).split("-").map(Number); return new Date(Date.UTC(y, (m || 1) - 1, d || 1)); };
const addDays = (s, n) => { const d = parse(s); d.setUTCDate(d.getUTCDate() + n); return ymd(d); };
const isOff = (s) => { const w = parse(s).getUTCDay(); return w === 0 || w === 6 || HOLIDAYS.has(s); };
const monthEnd = (ym) => { const [y, m] = ym.split("-").map(Number); return ymd(new Date(Date.UTC(y, m, 0))); };
const shiftMonth = (ym, n) => { const [y, m] = ym.split("-").map(Number); const d = new Date(Date.UTC(y, m - 1 + n, 1)); return ymd(d).slice(0, 7); };

export function payDate(ym, day) {
  const last = Number(monthEnd(ym).slice(8));
  let d = `${ym}-${String(Math.min(Math.max(1, Number(day) || 25), last)).padStart(2, "0")}`;
  for (let i = 0; i < 15 && isOff(d); i++) d = addDays(d, -1);
  return d;
}

const num = (v) => { const n = Number(String(v ?? "").replace(/,/g, "")); return Number.isFinite(n) ? Math.round(n) : 0; };
const has = (v) => v !== undefined && v !== null && v !== "";
const floor10 = (x) => Math.floor(Math.round((Number(x) || 0) * 1000) / 1000 / 10) * 10;
function calcNet(s) {
  const base = num(s.base), allow = num(s.allow), meal = num(s.meal);
  const taxable = Math.max(0, base + allow + meal - Math.min(Math.max(meal, 0), RATES.mealFree));
  const np = has(s.np) ? num(s.np) : (taxable > 0 ? floor10(Math.min(Math.max(taxable, RATES.npMin), RATES.npMax) * RATES.np) : 0);
  const hi = has(s.hi) ? num(s.hi) : floor10(taxable * RATES.hi);
  const lt = has(s.lt) ? num(s.lt) : floor10(hi * RATES.ltOfHi);
  const ei = has(s.ei) ? num(s.ei) : floor10(taxable * RATES.ei);
  const it = num(s.it);
  const lo = has(s.lo) ? num(s.lo) : floor10(it * RATES.localOfIt);
  return base + allow + meal - (np + hi + lt + ei + it + lo + num(s.adv));
}
const list = (v) => (Array.isArray(v) ? v : v && typeof v === "object" ? Object.values(v) : []).filter(Boolean);

// today(KST) 기준 within 일 안에 급여일이 오는 사람들 → [{ name, date, daysLeft, net, biz }]
export function upcomingPays(data, today, within = 2) {
  const emps = list(data.employees);
  const pays = data.payrolls && typeof data.payrolls === "object" ? data.payrolls : {};
  const settings = data.hrSettings && typeof data.hrSettings === "object" ? data.hrSettings : {};
  const out = [];
  for (const ym of [today.slice(0, 7), shiftMonth(today.slice(0, 7), 1)]) {
    const rec = pays[ym] || {};
    for (const e of emps) {
      if (!e.joined || e.joined > monthEnd(ym) || (e.leftAt && e.leftAt < `${ym}-01`)) continue;
      const d = payDate(ym, Number(e.payDay) || Number(settings.payDay) || 25);
      const left = Math.round((parse(d) - parse(today)) / 86400000);
      if (left < 0 || left > within) continue;
      let net;
      const snap = rec.status === "closed" && Array.isArray(rec.snap) ? rec.snap.find((s) => String(s.empId) === String(e.id)) : null;
      if (snap) net = calcNet(snap);
      else {
        const o = (rec.rows && rec.rows[e.id]) || {};
        net = calcNet({
          base: has(o.base) ? o.base : e.base, allow: has(o.allow) ? o.allow : e.allow,
          meal: has(o.meal) ? o.meal : (has(e.meal) ? e.meal : RATES.mealFree), it: has(o.it) ? o.it : e.incomeTax,
          np: o.np, hi: o.hi, lt: o.lt, ei: o.ei, lo: o.lo, adv: o.adv,
        });
      }
      out.push({ name: e.name, date: d, daysLeft: left, net, biz: e.biz || "", drafted: !!(rec.rows && rec.rows[e.id]) || !!snap });
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || String(a.name).localeCompare(String(b.name)));
}

export function payLines(pays) {
  const when = (p) => (p.daysLeft === 0 ? "오늘" : p.daysLeft === 1 ? "내일" : `${p.daysLeft}일 뒤`);
  return pays.map((p) => `· ${when(p)}(${Number(p.date.slice(5, 7))}/${Number(p.date.slice(8))}) ${p.name} ${p.net.toLocaleString("ko-KR")}원${p.drafted ? "" : " (기본값 기준)"}`);
}
