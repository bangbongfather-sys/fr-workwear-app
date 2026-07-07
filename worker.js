// Cloudflare Worker — 정적 자산 서빙 + 노션 To Do List 동기화 프록시 + Firebase RTDB 프록시
//                     + 입찰 모니터링 (조달청 OpenAPI 일일 폴링)
//
// 환경 변수 (Cloudflare 대시보드에서 설정):
//   NOTION_TOKEN        (Secret) — 노션 Internal Integration Token (secret_xxx)
//   NOTION_TODO_DSID    (Plain)  — To Do List 데이터베이스 ID
//                                   (현재값: 2c70e386-6388-818e-9ad9-000bfd99e1c4)
//   FIREBASE_DB_SECRET  (Secret) — Firebase Realtime Database 비밀 키 (legacy DB secret).
//                                   Firebase 콘솔 → 프로젝트 설정 → 서비스 계정 → 데이터베이스 비밀번호.
//                                   클라이언트에는 절대 노출되지 않고 이 워커만 사용.
//   G2B_SERVICE_KEY     (Secret) — 공공데이터포털 나라장터 OpenAPI Decoding 인증키.
//                                   data.go.kr 마이페이지 → 오픈API → 개발계정에서 발급.
//                                   입찰 모니터링 모듈(/api/tenders/*) 전용.
//   MATCH_THRESHOLD     (Plain)  — 입찰 매칭 임계값 (기본 7). wrangler.jsonc vars로 설정.
//
// Cron Triggers (wrangler.jsonc → triggers.crons):
//   "0 18 * * *" — UTC 18:00 = KST 03:00, 매일 입찰 폴링 자동 실행

import { handleTendersApi } from "./worker-src/tenders/router.js";
import { runDailyPoll } from "./worker-src/tenders/poll.js";
import { sendTenderNotification } from "./worker-src/tenders/notify.js";
import { runDeadlineCheck } from "./worker-src/tenders/deadline-check.js";
import { runChangeHistoryPoll } from "./worker-src/tenders/change-history.js";
import { handleMcp } from "./worker-src/mcp.js";

const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";
const FB_HOST = "njsafety-2ee24-default-rtdb.asia-southeast1.firebasedatabase.app";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
          "Access-Control-Max-Age": "86400",
        },
      });
    }

    // 노션 동기화 API
    if (url.pathname.startsWith("/api/notion/")) {
      return handleNotionApi(request, env, url);
    }

    // Firebase RTDB 프록시 (클라이언트가 Firebase URL/시크릿을 직접 보지 않게 우회)
    if (url.pathname === "/api/sync" || url.pathname.startsWith("/api/sync/")) {
      return handleFirebaseSync(request, env, url);
    }

    // 카카오톡 일정 알림 (나에게 보내기)
    if (url.pathname.startsWith("/api/kakao/")) {
      return handleKakaoApi(request, env, url);
    }

    // 입찰 모니터링 API (조달청 폴링 + 키워드 시드 등)
    if (url.pathname === "/api/tenders" || url.pathname.startsWith("/api/tenders/")) {
      return handleTendersApi(request, env, url);
    }

    // Claude 커스텀 커넥터용 MCP 서버 (Streamable HTTP, authless)
    if (url.pathname === "/mcp" || url.pathname === "/mcp/") {
      return handleMcp(request, env, url);
    }

    // 그 외 모든 요청은 정적 자산 (index.html 등)
    return env.ASSETS.fetch(request);
  },

  // Cron Trigger 자동 실행 진입점.
  // wrangler.jsonc의 triggers.crons에 등록된 스케줄이 발동하면 호출됨.
  // event.cron 값으로 어떤 스케줄이 호출됐는지 분기.
  // ctx.waitUntil은 Worker가 백그라운드 작업 완료까지 살아있도록 보장 (장기 fetch에 필수).
  async scheduled(event, env, ctx) {
    console.log(`[scheduled] cron 실행: ${event.cron} @ ${new Date(event.scheduledTime).toISOString()}`);

    // KST 03:00 (UTC 18:00) — 입찰 데이터 폴링
    if (event.cron === "0 18 * * *") {
      ctx.waitUntil(
        runDailyPoll(env)
          .then((result) => console.log(`[scheduled] 일일 폴링 완료:`, result))
          .catch((err) => console.error(`[scheduled] 일일 폴링 실패:`, err?.message ?? err))
      );
      return;
    }

    // KST 08:30 (UTC 23:30) — 이메일 알림 발송 + 카카오톡 아침 일정 브리핑
    // (카카오는 별도 cron을 추가하면 5개 한도에 걸릴 수 있어 이 아침 슬롯에 합쳐 발송)
    if (event.cron === "30 23 * * *") {
      const appUrl = "https://fr-workwear-app.njsafety91.workers.dev";
      ctx.waitUntil(
        sendTenderNotification(env, appUrl)
          .then((result) => console.log(`[scheduled] 이메일 알림 완료:`, result))
          .catch((err) => console.error(`[scheduled] 이메일 알림 실패:`, err?.message ?? err))
      );
      ctx.waitUntil(
        sendKakaoDailyBriefing(env)
          .then((r) => console.log(`[scheduled] 카카오 브리핑:`, r))
          .catch((err) => console.error(`[scheduled] 카카오 브리핑 실패:`, err?.message ?? err))
      );
      return;
    }

    // KST 09:00, 14:00 (UTC 00:00, 05:00) — Phase 4A 마감 임박 점검
    if (event.cron === "0 0,5 * * *") {
      const appUrl = "https://fr-workwear-app.njsafety91.workers.dev";
      ctx.waitUntil(
        runDeadlineCheck(env, appUrl)
          .then((result) => console.log(`[scheduled] 마감 임박 점검 완료:`, result))
          .catch((err) => console.error(`[scheduled] 마감 임박 점검 실패:`, err?.message ?? err))
      );
      return;
    }

    // KST 11:00, 16:00 (UTC 02:00, 07:00) — Phase 4B 변경이력 폴링
    if (event.cron === "0 2,7 * * *") {
      const appUrl = "https://fr-workwear-app.njsafety91.workers.dev";
      ctx.waitUntil(
        runChangeHistoryPoll(env, appUrl)
          .then((result) => console.log(`[scheduled] 변경이력 폴링 완료:`, result))
          .catch((err) => console.error(`[scheduled] 변경이력 폴링 실패:`, err?.message ?? err))
      );
      return;
    }

    console.warn(`[scheduled] 등록되지 않은 cron 스케줄: ${event.cron}`);
  },
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Content-Type": "application/json; charset=utf-8",
};

async function handleNotionApi(request, env, url) {
  if (!env.NOTION_TOKEN || !env.NOTION_TODO_DSID) {
    return new Response(JSON.stringify({
      error: "NOTION_TOKEN 또는 NOTION_TODO_DSID 환경변수가 설정되지 않았습니다."
    }), { status: 500, headers: corsHeaders });
  }

  const notionHeaders = {
    "Authorization": `Bearer ${env.NOTION_TOKEN}`,
    "Notion-Version": NOTION_VERSION,
    "Content-Type": "application/json",
  };

  // /api/notion/todo            → POST(생성)
  // /api/notion/todo/<pageId>   → PATCH(수정), DELETE(아카이브)
  const m = url.pathname.match(/^\/api\/notion\/todo(?:\/([a-zA-Z0-9-]+))?\/?$/);
  if (!m) {
    return new Response(JSON.stringify({ error: "Not found" }), { status: 404, headers: corsHeaders });
  }
  const pageId = m[1];

  try {
    if (request.method === "POST" && !pageId) {
      const body = await request.json();
      if (!body.text) {
        return new Response(JSON.stringify({ error: "text 필수" }), { status: 400, headers: corsHeaders });
      }
      const properties = buildProperties(body);
      const res = await fetch(`${NOTION_API}/pages`, {
        method: "POST",
        headers: notionHeaders,
        body: JSON.stringify({
          parent: { database_id: env.NOTION_TODO_DSID },
          properties,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        return new Response(JSON.stringify({ error: data.message || `Notion HTTP ${res.status}`, details: data }), { status: res.status, headers: corsHeaders });
      }
      return new Response(JSON.stringify({ notionPageId: data.id, url: data.url }), { status: 200, headers: corsHeaders });
    }

    if (request.method === "PATCH" && pageId) {
      const body = await request.json();
      const properties = buildProperties(body);
      const res = await fetch(`${NOTION_API}/pages/${pageId}`, {
        method: "PATCH",
        headers: notionHeaders,
        body: JSON.stringify({ properties }),
      });
      const data = await res.json();
      if (!res.ok) {
        return new Response(JSON.stringify({ error: data.message || `Notion HTTP ${res.status}`, details: data }), { status: res.status, headers: corsHeaders });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: corsHeaders });
    }

    if (request.method === "DELETE" && pageId) {
      const res = await fetch(`${NOTION_API}/pages/${pageId}`, {
        method: "PATCH",
        headers: notionHeaders,
        body: JSON.stringify({ archived: true }),
      });
      const data = await res.json();
      if (!res.ok) {
        return new Response(JSON.stringify({ error: data.message || `Notion HTTP ${res.status}`, details: data }), { status: res.status, headers: corsHeaders });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: corsHeaders });
    }

    return new Response(JSON.stringify({ error: "지원하지 않는 메서드/경로" }), { status: 405, headers: corsHeaders });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message || "내부 오류" }), { status: 500, headers: corsHeaders });
  }
}

// Firebase RTDB 프록시
//
// 경로 매핑:
//   /api/sync                       → /frw.json            (메인 데이터: GET/PUT/PATCH)
//   /api/sync/backup/YYYY-MM-DD[_HH] → /frw_backup_<slot>.json (백업 스냅샷: GET/PUT, 4시간 슬롯)
//
// 보안: FIREBASE_DB_SECRET가 Firebase RTDB ?auth= 쿼리에 자동 부착되어, Firebase 규칙은
// 'auth != null'로 잠가도 동작. 시크릿은 워커 환경에만 있고 클라이언트로 새지 않음.
async function handleFirebaseSync(request, env, url) {
  if (!env.FIREBASE_DB_SECRET) {
    return new Response(JSON.stringify({
      error: "FIREBASE_DB_SECRET 환경변수가 설정되지 않았습니다. wrangler secret put FIREBASE_DB_SECRET 로 등록하세요."
    }), { status: 500, headers: corsHeaders });
  }

  // 경로 매칭
  let fbPath;
  if (url.pathname === "/api/sync" || url.pathname === "/api/sync/") {
    fbPath = "/frw.json";
  } else if (url.pathname === "/api/sync/rev") {
    // (레거시) 전역 리비전 번호 — _revs 도입 후 미사용. 하위호환 위해 경로 유지.
    fbPath = "/frw/_rev.json";
  } else if (url.pathname === "/api/sync/revs") {
    // 섹션별 충돌 감지용 리비전 맵 (경량 GET). frw 전체를 받지 않고 _revs 객체만 조회.
    fbPath = "/frw/_revs.json";
  } else {
    // YYYY-MM-DD (일일) 또는 YYYY-MM-DD_HH (4시간 슬롯) 둘 다 허용
    const m = url.pathname.match(/^\/api\/sync\/backup\/(\d{4}-\d{2}-\d{2}(?:_\d{2})?)\/?$/);
    if (!m) {
      return new Response(JSON.stringify({ error: "Not found", path: url.pathname }), { status: 404, headers: corsHeaders });
    }
    fbPath = `/frw_backup_${m[1]}.json`;
  }

  // 허용 메서드 화이트리스트
  const method = request.method;
  if (!["GET", "PUT", "PATCH"].includes(method)) {
    return new Response(JSON.stringify({ error: `메서드 ${method} 미지원 (GET/PUT/PATCH만 허용)` }), { status: 405, headers: corsHeaders });
  }

  // Firebase 호출
  const fbUrl = `https://${FB_HOST}${fbPath}?auth=${encodeURIComponent(env.FIREBASE_DB_SECRET)}`;
  const body = method === "GET" ? undefined : await request.text();
  try {
    const res = await fetch(fbUrl, {
      method,
      headers: { "Content-Type": "application/json" },
      body,
    });
    const text = await res.text();
    // Firebase 응답을 그대로 전달 (단, 시크릿이 헤더에 들어가지 않게 자체 corsHeaders로 응답)
    return new Response(text, {
      status: res.status,
      headers: corsHeaders,
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message || "Firebase 프록시 오류" }), { status: 502, headers: corsHeaders });
  }
}

// 웹앱 todo → 노션 properties 매핑
//   text                → 이름 (title)
//   date / endDate      → 업무 기간 (date.start / date.end)
//                          - date 만 있으면 단일 일자 (date.end 미설정)
//                          - endDate 도 있으면 기간 (date.start ~ date.end)
//                          - date null/빈문자열이면 업무 기간 자체 제거
//   done                → 완료 (checkbox) + 상태 구분 (status: 시작 전 / 완료)
function buildProperties(body) {
  const props = {};
  if (body.text !== undefined) {
    props["이름"] = { title: [{ text: { content: String(body.text || "").slice(0, 1900) } }] };
  }
  // date 또는 endDate 중 하나라도 정의되면 업무 기간 갱신
  if (body.date !== undefined || body.endDate !== undefined) {
    const start = body.date;
    const end = body.endDate;
    if (start) {
      const dateObj = { start };
      if (end && end !== start) dateObj.end = end;
      props["업무 기간"] = { date: dateObj };
    } else {
      props["업무 기간"] = { date: null };
    }
  }
  if (body.done !== undefined) {
    props["완료"] = { checkbox: !!body.done };
    props["상태 구분"] = { status: { name: body.done ? "완료" : "시작 전" } };
  }
  return props;
}


// ─── 카카오톡 일정 알림 ───
// "나에게 보내기"(talk_message) 방식: 사장님 개인 카카오 계정으로 로그인 1회 →
// refresh token을 Firebase에 보관 → 매일 아침 cron이 오늘/내일 일정을 내 카톡으로 발송.
// 필요 시크릿: KAKAO_REST_KEY (카카오 개발자 앱의 REST API 키)
const KAKAO_TOKEN_PATH = "/frw_kakao.json";

async function fbGet(env, path) {
  const r = await fetch(`https://${FB_HOST}${path}?auth=${encodeURIComponent(env.FIREBASE_DB_SECRET)}`);
  return r.ok ? r.json() : null;
}
async function fbPut(env, path, data) {
  await fetch(`https://${FB_HOST}${path}?auth=${encodeURIComponent(env.FIREBASE_DB_SECRET)}`, {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data),
  });
}

async function kakaoRefreshAccess(env) {
  const saved = await fbGet(env, KAKAO_TOKEN_PATH);
  if (!saved || !saved.refresh_token) throw new Error("카카오 미연결 — 앱 일정 탭에서 연결하세요");
  const body = new URLSearchParams({
    grant_type: "refresh_token", client_id: env.KAKAO_REST_KEY, refresh_token: saved.refresh_token,
  });
  const r = await fetch("https://kauth.kakao.com/oauth/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body,
  });
  const j = await r.json();
  if (!j.access_token) throw new Error("토큰 갱신 실패: " + JSON.stringify(j).slice(0, 150));
  if (j.refresh_token) await fbPut(env, KAKAO_TOKEN_PATH, { ...saved, refresh_token: j.refresh_token, updated: Date.now() });
  return j.access_token;
}

async function kakaoSendMemo(env, text) {
  const access = await kakaoRefreshAccess(env);
  const body = new URLSearchParams({
    template_object: JSON.stringify({
      object_type: "text",
      text: text.slice(0, 950),
      link: { web_url: "https://fr-workwear-app.njsafety91.workers.dev", mobile_web_url: "https://fr-workwear-app.njsafety91.workers.dev" },
      button_title: "앱 열기",
    }),
  });
  const r = await fetch("https://kapi.kakao.com/v2/api/talk/memo/default/send", {
    method: "POST",
    headers: { "Authorization": `Bearer ${access}`, "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const j = await r.json();
  if (j.result_code !== 0) throw new Error("발송 실패: " + JSON.stringify(j).slice(0, 150));
  return true;
}

// 오늘/내일 일정 + 입찰 마감 브리핑 텍스트 (KST 기준)
async function buildKakaoBriefing(env) {
  const data = await fbGet(env, "/frw.json") || {};
  const kstNow = new Date(Date.now() + 9 * 3600000);
  const day = (off) => new Date(kstNow.getTime() + off * 86400000).toISOString().slice(0, 10);
  const today = day(0), tomorrow = day(1);
  const inRange = (t, d) => {
    const s2 = (t.date || "").slice(0, 10), e2 = (t.endDate || t.date || "").slice(0, 10);
    return s2 && s2 <= d && d <= (e2 || s2);
  };
  const todos = (data.todos || []).filter(t => !t.done);
  const lines = [];
  const tToday = todos.filter(t => inRange(t, today));
  const tTomorrow = todos.filter(t => inRange(t, tomorrow) && !inRange(t, today));
  if (tToday.length) lines.push("[오늘 일정]", ...tToday.map(t => "· " + t.text));
  if (tTomorrow.length) lines.push("", "[내일 일정]", ...tTomorrow.map(t => "· " + t.text));
  const bids = (data.bids || []).filter(b => b.status !== "종료" && (b.closeDate || "").slice(0, 10) >= today && (b.closeDate || "").slice(0, 10) <= tomorrow);
  if (bids.length) lines.push("", "[입찰 마감 임박]", ...bids.map(b => `· ${b.title} (마감 ${(b.closeDate || "").slice(5, 10)})`));
  if (lines.length === 0) return null; // 알릴 것 없음 → 발송 생략
  const [y, m2, d2] = today.split("-");
  return `📅 NJ SAFETY ${+m2}/${+d2} 아침 브리핑\n\n` + lines.join("\n");
}

async function sendKakaoDailyBriefing(env) {
  if (!env.KAKAO_REST_KEY) return { skip: "KAKAO_REST_KEY 미설정" };
  const text = await buildKakaoBriefing(env);
  if (!text) return { skip: "오늘·내일 일정 없음" };
  await kakaoSendMemo(env, text);
  return { sent: true };
}

async function handleKakaoApi(request, env, url) {
  if (!env.KAKAO_REST_KEY) {
    return new Response(JSON.stringify({ error: "KAKAO_REST_KEY 미설정 — wrangler secret put KAKAO_REST_KEY" }), { status: 500, headers: corsHeaders });
  }
  const redirectUri = `${url.origin}/api/kakao/callback`;
  try {
    if (url.pathname === "/api/kakao/login") {
      const auth = `https://kauth.kakao.com/oauth/authorize?client_id=${env.KAKAO_REST_KEY}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=talk_message`;
      return Response.redirect(auth, 302);
    }
    if (url.pathname === "/api/kakao/callback") {
      const code = url.searchParams.get("code");
      if (!code) return Response.redirect(url.origin + "/?kakao=fail", 302);
      const body = new URLSearchParams({ grant_type: "authorization_code", client_id: env.KAKAO_REST_KEY, redirect_uri: redirectUri, code });
      const r = await fetch("https://kauth.kakao.com/oauth/token", {
        method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body,
      });
      const j = await r.json();
      if (!j.refresh_token) return Response.redirect(url.origin + "/?kakao=fail", 302);
      await fbPut(env, KAKAO_TOKEN_PATH, { refresh_token: j.refresh_token, connected: Date.now() });
      return Response.redirect(url.origin + "/?kakao=ok", 302);
    }
    if (url.pathname === "/api/kakao/status") {
      const saved = await fbGet(env, KAKAO_TOKEN_PATH);
      return new Response(JSON.stringify({ connected: !!(saved && saved.refresh_token) }), { headers: corsHeaders });
    }
    if (url.pathname === "/api/kakao/test" && request.method === "POST") {
      const text = (await buildKakaoBriefing(env)) || "📅 NJ SAFETY 카카오 알림 연결 테스트입니다. 오늘·내일 등록된 일정이 없어 테스트 메시지를 보냈어요.";
      await kakaoSendMemo(env, text);
      return new Response(JSON.stringify({ ok: true }), { headers: corsHeaders });
    }
    return new Response(JSON.stringify({ error: "Not found" }), { status: 404, headers: corsHeaders });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message || String(e) }), { status: 500, headers: corsHeaders });
  }
}
