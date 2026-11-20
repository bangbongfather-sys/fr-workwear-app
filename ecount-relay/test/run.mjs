// 판매 로봇 자동 시험 — 가짜 이카운트로 여러 상황을 차례로 돌려, 하나라도 틀리면 실패로 끝난다.
//   node ecount-relay/test/run.mjs            (전부)
//   node ecount-relay/test/run.mjs 문자        (이름에 「문자」가 들어간 것만)
// 필요한 것: 이 폴더에 playwright-core (npm i playwright-core@1.49.1), Chrome (NJ_CHROME 로 경로 지정 가능)
// 로봇은 GitHub 에서 도는 모습 그대로(GITHUB_ACTIONS=true) 시험한다. 「맥」이 붙은 것만 맥 모습으로.
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startFake } from "./fake-ecount.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROBOT = join(HERE, "web.mjs.test.mjs");
copyFileSync(join(HERE, "..", "web.mjs"), ROBOT);   // playwright-core 를 이 폴더에서 찾도록 옆에 복사
const CHROME = process.env.NJ_CHROME || ["/usr/bin/google-chrome", "/opt/pw-browsers/chromium-1243/chrome-linux64/chrome"].find((p) => existsSync(p));
const addD = (d, k) => new Date(Date.parse(d) + k * 864e5).toISOString().slice(0, 10);
const TODAY = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const M0 = `${TODAY.slice(0, 7)}-01`;
const FROM = addD(M0, -20).slice(0, 8) + "01", TO = (() => { const [y, m] = TODAY.split("-").map(Number); const n = new Date(Date.UTC(y, m + 1, 0)); return n.toISOString().slice(0, 10); })();

function runRobot(args, { mac = false, password = "pw1234", extra = {} } = {}) {
  const dir = join(HERE, ".work"); rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, NJ_APP: "http://127.0.0.1:8791", NJ_LOGIN_URL: "http://127.0.0.1:8791/ecount/Login/", NJ_CHROME: CHROME, NJ_RELAY: "testkey", NJ_DIR: dir,
    NJ_ECOUNT_COM: "123456", NJ_ECOUNT_WEB_ID: "robot", NJ_ECOUNT_WEB_PW: password, NJ_AUTH_POLLS: "8", NJ_HOME_WAIT: "12000", ...(mac ? {} : { GITHUB_ACTIONS: "true", RUNNER_TEMP: dir }), ...extra };
  return new Promise((res) => { const t0 = Date.now(); const p = spawn(process.execPath, [ROBOT, ...args], { env, cwd: HERE }); let out = ""; p.stdout.on("data", (c) => (out += c)); p.stderr.on("data", (c) => (out += c));
    const kill = setTimeout(() => p.kill("SIGKILL"), 240000); p.on("close", (code) => { clearTimeout(kill); res({ code, out, secs: Math.round((Date.now() - t0) / 1000) }); }); });
}

const expRows = (ALL, f, t) => ALL.filter((x) => { const d = x["SELL.IO_DATE_NO"].slice(0, 10).replace(/\//g, "-"); return d >= f && d <= t; });
const SC = [
  { name: "문자 인증 · 인증 수단이 3초 늦게 붙음 · 틀린 번호 뒤 맞는 번호", fake: { smsDelay: 3000 }, args: ["import", FROM, TO],
    check: (r, st, ALL) => [[r.ok, "성공"], [r.rows.length === expRows(ALL, FROM, TO).length, `전표 수 ${r.rows.length}/${expRows(ALL, FROM, TO).length}`], [st.ev.filter((e) => e === "sms-sent").length === 1, "문자 1번만 보냄"],
      [st.ev.filter((e) => e.startsWith("code-tried")).length === 2, "번호 두 번 넣음"], [r.entered && r.entered.ok, "날짜별 입력 전표(작성일 조건)"], [r.rows.every((x) => x.w && x.v), "전표마다 입력 시각·고친 횟수"]] },
  { name: "문자 인증 · 인증 수단이 바로 보임", fake: { smsDelay: 0 }, args: ["import", FROM, TO], check: (r) => [[r.ok, "성공"]] },
  { name: "문자 인증 · 인증 수단이 12초 늦게 붙음", fake: { smsDelay: 12000 }, args: ["import", FROM, TO], check: (r) => [[r.ok, "성공"]] },
  { name: "맥 · 인증 없이 바로 들어감", fake: { twofa: false }, args: ["import", FROM, TO], mac: true, check: (r, st) => [[r.ok, "성공"], [!st.ev.includes("sms-sent"), "문자 안 보냄"]] },
  { name: "첫 화면이 9초 늦게 그려짐", fake: { homeDelay: 9000 }, args: ["import", FROM, TO], check: (r) => [[r.ok, "성공"]] },
  { name: "첫 화면이 처음엔 끝내 안 그려짐(새로 고치면 보임)", fake: { homeBlankOnce: true, homeDelay: 1000 }, args: ["import", FROM, TO], check: (r, st) => [[r.ok, "성공"], [st.homeLoads >= 2, "새로 고침"]] },
  { name: "최초 작성일 조건이 안 먹는 이카운트", fake: { noWriteFilter: true }, args: ["import", FROM, TO], check: (r) => [[r.ok, "판매 반영은 성공"], [r.entered && !r.entered.ok, "입력 전표는 대신 방식으로"]] },
  { name: "여러 쪽 — 2년치(1,400건 넘음)", fake: { smsDelay: 0 }, args: ["import", "2025-01-01", "2026-12-31"], check: (r, st, ALL) => [[r.ok, "성공"], [r.rows.length === expRows(ALL, "2025-01-01", "2026-12-31").length, `전표 수 ${r.rows.length}/${expRows(ALL, "2025-01-01", "2026-12-31").length}`]] },
  { name: "실패해야 함 · 문자(SMS) 인증 수단이 없음", fake: { noSms: true }, args: ["import", FROM, TO], check: (r, st) => [[!r.ok, "실패로 끝남"], [/SMS/.test(r.error), `이유: ${r.error}`], [!st.ev.includes("sms-sent"), "문자 안 보냄"]] },
  { name: "실패해야 함 · 인증번호가 끝내 안 들어옴", fake: { noCode: true }, args: ["import", FROM, TO], check: (r) => [[!r.ok, "실패로 끝남"], [/시간 안에/.test(r.error), `이유: ${r.error}`], [!r.rows || !r.rows.length, "반영 안 함"]] },
  { name: "실패해야 함 · 비밀번호가 틀림", fake: {}, args: ["import", FROM, TO], password: "wrong", check: (r, st) => [[!r.ok, "실패로 끝남"], [/로그인이 안 됐습니다/.test(r.error), `이유: ${r.error}`], [!st.ev.includes("sms-sent"), "문자 안 보냄"]] },
  { name: "아침 점검(authcheck) — 문자 칸까지만, 문자는 안 보냄", fake: { smsDelay: 3000 }, args: ["authcheck"], check: (r, st) => [[r.ok, "성공"], [r.mode === "authcheck", "점검으로 보고"], [!st.ev.includes("sms-sent"), "문자 안 보냄"]] },
  { name: "아침 점검 — 문자 칸이 없으면 실패로 알림", fake: { noSms: true }, args: ["authcheck"], check: (r, st) => [[!r.ok, "실패로 끝남"], [/SMS/.test(r.error), `이유: ${r.error}`]] },
];

const pick = process.argv[2] || "";
let bad = 0;
for (const sc of SC.filter((x) => x.name.includes(pick))) {
  const fake = await startFake(sc.fake);
  const run = await runRobot(sc.args, { mac: sc.mac, password: sc.password });
  await fake.close();
  const r = fake.st.push || { ok: false, error: `로봇이 결과를 보내지 않음\n${run.out.slice(-800)}` };
  const res = sc.check(r, fake.st, fake.ALL);
  const ok = res.every(([v]) => v);
  if (!ok) bad++;
  console.log(`${ok ? "통과" : "실패"}  ${sc.name}  (${run.secs}초)`);
  for (const [v, label] of res) console.log(`      ${v ? "·" : "✗"} ${label}`);
  if (!ok) console.log(`      마지막 단계: ${(r.steps || []).map((x) => x.name).slice(-4).join(" → ")}\n      로봇 출력: ${run.out.split("\n").slice(-4).join(" / ")}`);
}
rmSync(ROBOT, { force: true }); rmSync(join(HERE, ".work"), { recursive: true, force: true });
console.log(bad ? `\n${bad}개 실패` : "\n모두 통과");
process.exit(bad ? 1 : 0);
