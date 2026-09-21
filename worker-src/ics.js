// ── 아이폰·구글 캘린더 구독용 .ics 생성 ─────────────────────────────
// 아이폰 캘린더는 헤더에 토큰을 못 붙인다. 그래서 주소 안에 비밀 토큰을 둔다.
// 읽기 전용이고, 토큰을 새로 내면 이전 주소는 그 즉시 막힌다.

// RFC 5545: 역슬래시·세미콜론·쉼표·줄바꿈을 escape 한다. 안 하면 캘린더가 통째로 깨진다.
const esc = (s) => String(s == null ? "" : s)
  .replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,")
  .replace(/\r?\n/g, "\\n");

// 75옥텟 접기(folding). 한글은 3바이트라 글자 수로 자르면 규격을 넘긴다.
function fold(line) {
  const bytes = new TextEncoder().encode(line);
  if (bytes.length <= 73) return line;
  const out = [];
  let cur = "", curBytes = 0;
  for (const ch of line) {
    const n = new TextEncoder().encode(ch).length;
    const limit = out.length === 0 ? 73 : 72; // 이어지는 줄은 앞에 공백 한 칸이 붙는다
    if (curBytes + n > limit) { out.push(cur); cur = ""; curBytes = 0; }
    cur += ch; curBytes += n;
  }
  if (cur) out.push(cur);
  return out.join("\r\n ");
}

const ymdCompact = (ds) => String(ds || "").replace(/-/g, "");
// 종료일은 exclusive 다 — 하루 일정이면 다음 날을 넣어야 그 하루만 칠해진다.
function nextDay(ds) {
  const [y, m, d] = String(ds).split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + 1));
  return `${t.getUTCFullYear()}${String(t.getUTCMonth() + 1).padStart(2, "0")}${String(t.getUTCDate()).padStart(2, "0")}`;
}
const stamp = () => new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

// 시각이 잡힌 일정은 KST 로 시간까지, 아니면 하루 종일 일정.
function eventLines(t, i, opts) {
  const date = (t.date || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const title = opts.private ? "NJ 일정" : (t.text || "(제목 없음)");
  const uid = `njsafety-${t.id != null ? t.id : i}@fr-workwear-app`;
  const lines = ["BEGIN:VEVENT", `UID:${uid}`, `DTSTAMP:${stamp()}`];

  const hasTime = Number.isFinite(t.startMin) && !t.endDate;
  if (hasTime) {
    const s = Number(t.startMin), dur = Number(t.durMin) > 0 ? Number(t.durMin) : 60;
    const hhmm = (m) => `${String(Math.floor(m / 60) % 24).padStart(2, "0")}${String(m % 60).padStart(2, "0")}00`;
    lines.push(`DTSTART;TZID=Asia/Seoul:${ymdCompact(date)}T${hhmm(s)}`);
    lines.push(`DTEND;TZID=Asia/Seoul:${ymdCompact(date)}T${hhmm(Math.min(s + dur, 24 * 60 - 1))}`);
  } else {
    const end = (t.endDate || "").slice(0, 10);
    lines.push(`DTSTART;VALUE=DATE:${ymdCompact(date)}`);
    lines.push(`DTEND;VALUE=DATE:${nextDay(/^\d{4}-\d{2}-\d{2}$/.test(end) && end >= date ? end : date)}`);
  }

  lines.push(`SUMMARY:${esc((t.done ? "✓ " : "") + title)}`);
  if (!opts.private && (t.memo || "").trim()) lines.push(`DESCRIPTION:${esc(t.memo)}`);
  lines.push(`STATUS:${t.done ? "COMPLETED" : "CONFIRMED"}`);
  lines.push("END:VEVENT");
  return lines;
}

export function buildIcs(todos, opts = {}) {
  const out = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//NJ SAFETY//fr-workwear-app//KO",
    "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
    `X-WR-CALNAME:${esc(opts.name || "NJ SAFETY 일정")}`,
    "X-WR-TIMEZONE:Asia/Seoul",
    "X-PUBLISHED-TTL:PT1H", "REFRESH-INTERVAL;VALUE=DURATION:PT1H",
    // 아이폰이 KST 를 정확히 그리도록 시간대를 함께 싣는다
    "BEGIN:VTIMEZONE", "TZID:Asia/Seoul", "BEGIN:STANDARD",
    "DTSTART:19700101T000000", "TZOFFSETFROM:+0900", "TZOFFSETTO:+0900", "TZNAME:KST",
    "END:STANDARD", "END:VTIMEZONE",
  ];
  let n = 0;
  (todos || []).forEach((t, i) => {
    const ev = eventLines(t, i, opts);
    if (ev) { out.push(...ev); n++; }
  });
  out.push("END:VCALENDAR");
  return { text: out.map(fold).join("\r\n") + "\r\n", count: n };
}
