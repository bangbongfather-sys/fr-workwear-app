// 판매 로봇 시험용 가짜 이카운트 + 가짜 회사 앱 — 실제 이카운트에서 본 화면 순서를 그대로 흉내 낸다.
//  - 로그인을 누르면 다른 주소의 로그인 화면으로 옮겨 가고(잠깐 빈 화면), 그 뒤 「2단계 인증」 창이 뜨거나(twofa) 바로 들어간다
//  - 인증 창은 「모바일 기기등록」이 먼저 보이고 문자·메일은 smsDelay 뒤에 붙는다(2026-11-20 실제 화면)
//  - 문자를 고르면 숫자 6칸 + 「인증번호확인」. 맞는 번호는 654321
//  - 첫 화면은 homeDelay 뒤에 「판매조회」 글자가 보인다. homeBlankOnce 면 처음 한 번은 끝내 안 보인다(새로 고치면 보임)
//  - 판매조회 목록 요청은 BASE_DATE_FROM/TO · PAGE_SIZE(최대 200) · PAGE_CURRENT · WRITE_DATE_*(최초 작성일 조건) 를 따른다
import http from "node:http";

export function startFake(opt = {}) {
  const o = { port: 8791, twofa: true, smsDelay: 3000, noSms: false, homeDelay: 2000, homeBlankOnce: false, noWriteFilter: false, codes: ["111111", "654321"], noCode: false, ...opt };
  const st = { push: null, ev: [], needs: 0, polls: 0, homeLoads: 0 };
  const TODAY = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  const addD = (d, k) => new Date(Date.parse(d) + k * 864e5).toISOString().slice(0, 10);
  // 가짜 전표: 2024-12-01 ~ 2026-12-31 하루 2건. 보통 전표 날짜 하루 전에 입력. 3의 배수 날(오늘 뒤 20일 안)은 오늘 입력. 5의 배수 날 1번 전표는 오늘 고침(v=2)
  const ALL = [];
  for (let t = Date.parse("2024-12-01"); t <= Date.parse("2026-12-31"); t += 864e5) {
    const d = new Date(t).toISOString().slice(0, 10), dd = Number(d.slice(8));
    for (let k = 1; k <= 2; k++) {
      let cd = `${addD(d, -1)} 10:0${k}`; if (dd % 3 === 0 && d > TODAY && d < addD(TODAY, 20)) cd = `${TODAY} 14:0${k}`;
      let wd = cd, v = 1; if (dd % 5 === 0 && k === 1 && d < TODAY) { wd = `${TODAY} 09:3${k}`; v = 2; }
      ALL.push({ "SELL.IO_DATE_NO": `${d.replace(/-/g, "/")}-${k}`, "SELL.CUST_DES": k === 1 ? "가나상공(주)" : "대림전설(주)", "SELL.PROD_DES": "방염 동계 솜바지(2026) [32] 외 1건", "SELL.TOT_AMT": k === 1 ? 110000 : -11000, WDATE: `${wd}:12.345`, VERSION_NO: v, _cd: cd.slice(0, 10) });
    }
  }
  const login = `<!doctype html><meta charset=utf-8><title>이카운트 로그인</title><body><div id=root></div><div id=pop></div>
<script>
var z=location.pathname.indexOf('erp_login')>=0;
var formHtml='<form id=f onsubmit="event.preventDefault(); go()"><input id=com_code placeholder="회사코드"><input id=id placeholder="아이디"><input id=passwd type=password placeholder="비밀번호"><input type=checkbox id=loginck><button id=save>로그인</button></form>';
function go(){ if(document.getElementById('passwd').value==='pw1234' && document.getElementById('com_code').value==='123456'){ location.href='/ecount/Login/erp_login'; } else { location.href='/ecount/Login/erp_login?bad=1'; } }
if(!z){ document.getElementById('root').innerHTML=formHtml; }
else { setTimeout(function(){ document.getElementById('root').innerHTML=formHtml; if(location.search.indexOf('bad=1')>=0) return; ${o.twofa ? "setTimeout(pop, 2500);" : "setTimeout(function(){ location.href='/ecount/ERP'; }, 2000);"} }, 1500); }
function pop(){document.getElementById('pop').innerHTML='<div>추가 보안 인증</div><div class="wrapper-page-inform"><div class="page-inform-title">2단계 인증<div class="sub-text">ERP 로그인 보안설정에 따라 2단계 인증절차를 진행합니다.<br>아래 인증방식 중 하나를 선택해 주세요.</div></div><div class="page-inform-contents"><div class="wrapper-2fa" id=w2><div class="auth-method register-device"><div class="auth-method-title">모바일 기기등록</div></div><div><button type="button">전화상담 요청</button></div></div></div></div>';
 ${o.noSms ? "" : `setTimeout(function(){ document.getElementById('w2').insertAdjacentHTML('afterbegin','<div class="auth-method" onclick="alert(1)"><div class="auth-method-title">복구 Email 1</div><div class="auth-method-contents">(nj********@naver.com)</div></div><div class="auth-method" onclick="sms()"><div class="auth-method-title">SMS</div><div class="auth-method-contents">(010****3079)</div></div>'); }, ${o.smsDelay});`}}
function sms(){fetch('/ecount/sms-sent');document.getElementById('pop').innerHTML='<div>추가 보안 인증</div><div class="email-verify"><div class="verifiy-title">인증 완료하기</div><div class="verifiy-sub-title">010****3079 에서 확인한 인증코드를 입력해 주세요.</div><div id=boxes>'+[0,1,2,3,4,5].map(function(){return '<input type=text class="form-control" inputmode=numeric autocomplete=one-time-code maxlength=1 oninput="if(this.value&&this.nextElementSibling)this.nextElementSibling.focus()">'}).join('')+'</div><button type=button class="btn btn-primary" onclick="chk()">인증번호확인</button><div>승인 유효시간</div><div>04:57</div><div class="auth-method-waiting-retry"><span>재전송</span></div><div id=msg></div><button type="button">전화상담 요청</button></div>';}
function chk(){var c=[].map.call(document.querySelectorAll('#boxes input'),function(e){return e.value}).join(''); fetch('/ecount/code-tried?c='+c); if(c==='654321'){location.href='/ecount/ERP';}else{document.getElementById('msg').textContent='인증번호가 일치하지 않습니다.';}}
</script>`;
  const erp = (show) => `<!doctype html><meta charset=utf-8><title>ECOUNT ERP</title><body><div id=home></div>
<script>${show ? `setTimeout(function(){document.getElementById('home').innerHTML='<input placeholder="메뉴검색" id=inputFavMSearch><div>이카운트 시작하기</div><a href="#" onclick="event.preventDefault(); show()">판매조회</a>';}, ${o.homeDelay});` : ""}
function show(){document.body.insertAdjacentHTML('beforeend','<h2>판매조회</h2><div>2026/10/18 ~ 2026/12/17</div><button id=b onclick=go()>검색(F8)</button><div id=g></div>'); go();}
function go(){fetch('/ecount/ECAPI/SVC/Common/SlipTransfer/GetListXFormSlipCommon?ec_req_sid=X',{method:'POST',headers:{'Content-Type':'application/json','X-Ec':'1'},body:JSON.stringify({Request:{Data:{BASE_DATE_FROM:'20261018',BASE_DATE_TO:'20261217',PAGE_SIZE:26,PAGE_CURRENT:1,FORM_TYPE:'SR030',WRITE_DATE_SELECT:'N',WRITE_DATE_DATECHK:0,WRITE_DATE_FROM:'',WRITE_DATE_TO:''}}})}).then(r=>r.json()).then(j=>{document.getElementById('g').textContent=j.Data.TotalCount+'건'})}
</script>`;
  const body = (q) => new Promise((res) => { let b = ""; q.on("data", (c) => (b += c)); q.on("end", () => res(b)); });
  const json = (s, v) => { s.setHeader("content-type", "application/json"); s.end(JSON.stringify(v)); };
  const server = http.createServer(async (q, s) => {
    const u = q.url;
    if (u.startsWith("/ecount/Login")) { s.setHeader("content-type", "text/html; charset=utf-8"); return s.end(login); }
    if (u.startsWith("/ecount/ERP")) { st.homeLoads++; s.setHeader("content-type", "text/html; charset=utf-8"); return s.end(erp(!(o.homeBlankOnce && st.homeLoads === 1))); }
    if (u.startsWith("/ecount/ECAPI/SVC/Common/SlipTransfer/GetListXFormSlipCommon")) {
      const r = JSON.parse(await body(q)).Request.Data; const f = r.BASE_DATE_FROM, t = r.BASE_DATE_TO;
      const wf = !o.noWriteFilter && r.WRITE_DATE_SELECT === "Y" ? String(r.WRITE_DATE_FROM).replace(/-/g, "") : "";
      const ds = (x) => x["SELL.IO_DATE_NO"].slice(0, 10).replace(/\//g, "");
      const hit = ALL.filter((x) => ds(x) >= f && ds(x) <= t && (!wf || x._cd.replace(/-/g, "") === wf)).sort((a, b) => b["SELL.IO_DATE_NO"].localeCompare(a["SELL.IO_DATE_NO"]));
      const size = Math.min(r.PAGE_SIZE, 200), pg = r.PAGE_CURRENT;
      return json(s, { Data: { TotalCount: hit.length, Data: hit.slice((pg - 1) * size, pg * size).map(({ _cd, ...x }) => x) }, Status: "200" });
    }
    if (u.startsWith("/ecount/sms-") || u.startsWith("/ecount/code-tried")) { st.ev.push(u.slice(8)); return s.end("ok"); }
    if (u === "/api/ecount/websales/auth") {
      if (q.method === "POST") { const b = await body(q); st.needs++; st.polls = 0; st.ev.push(`need ${b}`); return json(s, { ok: true }); }
      st.polls++; if (o.noCode || st.polls < 2) return json(s, { wait: true });
      return json(s, { code: o.codes[Math.min(st.needs, o.codes.length) - 1] });
    }
    if (u === "/api/ecount/websales/pending") return json(s, { pending: false });
    if (u === "/api/ecount/websales/push") { st.push = JSON.parse(await body(q)); return json(s, { ok: true, saved: true }); }
    s.statusCode = 404; s.end("no");
  });
  return new Promise((res) => server.listen(o.port, "127.0.0.1", () => res({ st, ALL, TODAY, close: () => new Promise((r) => server.close(r)) })));
}
