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

    // 입찰 모니터링 API (조달청 폴링 + 키워드 시드 등)
    if (url.pathname === "/api/tenders" || url.pathname.startsWith("/api/tenders/")) {
      return handleTendersApi(request, env, url);
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

    // KST 08:30 (UTC 23:30) — 이메일 알림 발송
    if (event.cron === "30 23 * * *") {
      const appUrl = "https://fr-workwear-app.njsafety91.workers.dev";
      ctx.waitUntil(
        sendTenderNotification(env, appUrl)
          .then((result) => console.log(`[scheduled] 이메일 알림 완료:`, result))
          .catch((err) => console.error(`[scheduled] 이메일 알림 실패:`, err?.message ?? err))
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
//   /api/sync/backup/YYYY-MM-DD     → /frw_backup_<date>.json (일일 백업: PUT)
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
  } else {
    const m = url.pathname.match(/^\/api\/sync\/backup\/(\d{4}-\d{2}-\d{2})\/?$/);
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
