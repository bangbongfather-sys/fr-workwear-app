// ── 플래너 계산 — index.html 의 같은 함수를 그대로 옮긴 것 (앱과 서버가 같은 규칙으로 블록·주간 숫자를 계산) ──
// 앱 쪽을 고치면 여기도 같이 고친다.

export const PL_COLLECTIONS = ["plans", "years", "quarters", "weeks", "themes", "routines", "dayTemplates", "dayLogs", "checkRules", "scores", "actions", "monthReviews"];
export const PL_WK = ["일", "월", "화", "수", "목", "금", "토"];
export const plPad = (n) => String(n).padStart(2, "0");
export const plYmd = (d) => `${d.getFullYear()}-${plPad(d.getMonth() + 1)}-${plPad(d.getDate())}`;
export const plDate = (s) => { const [y, m, d] = String(s).split("-").map(Number); return new Date(y, (m || 1) - 1, d || 1, 12); };
export const plAdd = (s, n) => { const d = plDate(s); d.setDate(d.getDate() + n); return plYmd(d); };
export const plDow = (s) => plDate(s).getDay();
export const plMonday = (s) => plAdd(s, -((plDow(s) + 6) % 7));
export const plMin = (hm) => { const m = /^(\d{1,2}):(\d{2})$/.exec(hm || ""); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
export const plHM = (m) => `${plPad(Math.floor(m / 60))}:${plPad(Math.round(m) % 60)}`;
export const plMD = (s) => `${Number(s.slice(5, 7))}/${Number(s.slice(8, 10))}`;
export const plIsPeak = (plan, ymd) => !!(plan && (plan.peakMonths || []).includes(Number(ymd.slice(5, 7))));
export function plArr(v) {
  if (Array.isArray(v)) return v.filter(Boolean);
  if (v && typeof v === "object") return Object.keys(v).sort((a, b) => Number(a) - Number(b)).map(k => v[k]).filter(Boolean);
  return [];
}
export function plannerNormalize(p) {
  const src = p && typeof p === "object" && !Array.isArray(p) ? p : {};
  const out = { ...src };
  for (const k of PL_COLLECTIONS) out[k] = plArr(src[k]);
  return out;
}
export function plannerHasPlans(p) { return !!(p && plArr(p.plans).length); }
export function plThemeOf(P, plan, ymd) { const dw = plDow(ymd); return P.themes.find(t => t.planId === plan.id && Number(t.weekday) === dw) || null; }
export function plLogOf(P, plan, ymd) { return P.dayLogs.find(l => l.id === `${plan.id}|${ymd}`) || null; }
export function plWeekOf(P, plan, ymd) { return P.weeks.find(w => w.planId === plan.id && w.startDate <= ymd && ymd <= w.endDate) || null; }
export function plRangeOf(list, plan, ymd) { return list.find(x => x.planId === plan.id && x.startDate <= ymd && ymd <= x.endDate) || null; }
export function plWeekNo(plan, ymd) { return Math.round((plDate(plMonday(ymd)) - plDate(plMonday(plan.startDate))) / (7 * 864e5)) + 1; }
export function plDayBlocks(P, plan, ymd, log) {
  const dw = plDow(ymd);
  // 이 날만 넣은 일정 (빈 시간 두 번 누르기·「+ 일정」)
  const extras = Object.entries((log && log.extra) || {}).filter(([, x]) => x && x.start && x.end)
    .map(([id, x]) => ({ id, custom: true, kind: "custom", label: x.label || "새 일정", baseLabel: "", start: x.start, end: x.end, done: !!x.done, steps: [], note: x.note || "" }));
  const byStart = (a, b) => plMin(a.start) - plMin(b.start);
  if (dw === 0 || dw === 6) return { blocks: extras.sort(byStart), mode: "weekend" };
  const peak = plIsPeak(plan, ymd);
  const studyDay = !peak || (plan.peakStudyDays || []).includes(dw);
  const mode = peak && !studyDay ? "peak" : "normal";
  const tpl = P.dayTemplates.find(t => t.planId === plan.id && t.mode === mode) || P.dayTemplates.find(t => t.planId === plan.id);
  const over = (log && log.blocks) || {};
  const stepsDone = (log && log.steps) || {};
  const NUM = ["①", "②", "③", "④", "⑤", "⑥"];
  const blocks = [];
  plArr(tpl && tpl.blocks).forEach(b => {
    const o = over[b.id] || {};
    if (o.hidden) return;
    const start = o.start || b.start, end = o.end || b.end;
    let steps = plArr(b.steps).map(st => ({ ...st, doing: (o.stepText && o.stepText[st.key]) || st.doing }));
    if (!steps.length) { blocks.push({ ...b, baseLabel: b.label, label: o.label || b.label, steps: [], start, end, done: !!o.done }); return; }
    // 옛 기록에서 학습 블록 전체 길이를 바꿨다면 단계 길이도 같은 비율로
    const sum = steps.reduce((a, st) => a + Number(st.mins || 0), 0), dur = plMin(end) - plMin(start);
    if (o.start || o.end) {
      if (sum > 0 && dur > 0 && dur !== sum) { let acc = 0; steps = steps.map((st, i) => { const m = i === steps.length - 1 ? Math.max(5, dur - acc) : Math.max(5, Math.round(Number(st.mins || 0) * dur / sum / 5) * 5); acc += m; return { ...st, mins: m }; }); }
    }
    // 학습 3단계는 각각 따로인 블록 (끌기·길이·이름 따로). 완료는 단계 체크(steps)에, 셋 다 끝나면 학습 블록 1회
    let acc = plMin(start);
    const mine = [];
    steps.forEach((st, i) => {
      const id = `${b.id}_${st.key}`, so = over[id] || {};
      const useOwn = st.start && st.end && !o.start && !o.end;
      const dS = useOwn ? st.start : plHM(acc), dE = useOwn ? st.end : plHM(Math.min(1439, acc + Number(st.mins || 0)));
      acc += Number(st.mins || 0);
      if (so.hidden) return;
      mine.push({ id, kind: b.kind, parentId: b.id, stepKey: st.key, stepNo: NUM[i] || "", baseLabel: st.label, label: so.label || st.label,
        doing: st.doing, aiRole: st.aiRole, start: so.start || dS, end: so.end || dE, done: !!stepsDone[st.key], steps: [] });
    });
    const keys = mine.map(x => x.stepKey);
    mine.forEach(x => { x.groupKeys = keys; blocks.push(x); });
  });
  return { blocks: [...blocks, ...extras].sort(byStart), mode: peak ? (studyDay ? "peak-study" : "peak") : "normal" };
}
export function plWeekStats(P, plan, monday) {
  const days = [];
  let study = 0, note = 0;
  for (let i = 0; i < 7; i++) {
    const d = plAdd(monday, i), log = plLogOf(P, plan, d);
    const b = (log && log.blocks) || {}, st = (log && log.steps) || {}, n3 = (log && log.note3) || {};
    const r = { date: d, study: !!(b.study && b.study.done), note: !!st.s2, ex: !!(b.ex && b.ex.done), log: !!(n3.did || n3.learned || n3.next) };
    if (r.study) study++; if (r.note) note++;
    days.push(r);
  }
  return { days, study, note };
}
export function plRoutineDate(rule, ym) {
  const [y, m] = ym.split("-").map(Number);
  const last = new Date(y, m, 0, 12).getDate();
  if (rule === "firstMon") { for (let d = 1; d <= 7; d++) { const s = `${ym}-${plPad(d)}`; if (plDow(s) === 1) return { from: s, to: s }; } }
  if (rule === "wk2to3") return { from: `${ym}-08`, to: `${ym}-21` };
  if (rule === "lastFri") { for (let d = last; d > last - 7; d--) { const s = `${ym}-${plPad(d)}`; if (plDow(s) === 5) return { from: s, to: s }; } }
  if (rule === "lastDay") { const s = `${ym}-${plPad(last)}`; return { from: s, to: s }; }
  return null;
}
export function plTodoTime(t) {
  if (!t) return null;
  if (Number.isFinite(t.startMin)) { const s = Number(t.startMin); const d = Number(t.durMin) > 0 ? Number(t.durMin) : 60; return { s, e: Math.min(1440, s + d) }; }
  const m = /([01]?\d|2[0-3]):([0-5]\d)(?:\s*[-~–]\s*([01]?\d|2[0-3]):([0-5]\d))?/.exec(t.text || "");
  if (!m) return null;
  const s = Number(m[1]) * 60 + Number(m[2]);
  const e = m[3] != null ? Number(m[3]) * 60 + Number(m[4]) : s + 60;
  return { s, e: Math.max(e, s + 30) };
}
export function plTodosOn(todos, ymd) { return (todos || []).filter(t => t && t.date && t.date <= ymd && ymd <= (t.endDate || t.date)); }
export function plTodoBlocks(todos, ymd) {
  return plTodosOn(todos, ymd).map(t => { const tm = plTodoTime(t); return tm ? { id: "t" + t.id, todo: t, kind: "todo", label: t.text || "", baseLabel: t.text || "", start: plHM(tm.s), end: plHM(Math.min(1439, tm.e)), done: !!t.done, steps: [] } : null; }).filter(Boolean);
}
