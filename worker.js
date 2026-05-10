// Cloudflare Worker — 정적 자산 서빙 + 노션 To Do List 동기화 프록시
//
// 환경 변수 (Cloudflare 대시보드에서 설정):
//   NOTION_TOKEN     (Secret) — 노션 Internal Integration Token (secret_xxx)
//   NOTION_TODO_DSID (Plain)  — To Do List 데이터베이스 ID
//                                (현재값: 2c70e386-6388-818e-9ad9-000bfd99e1c4)

const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
          "Access-Control-Max-Age": "86400",
        },
      });
    }

    // 노션 동기화 API
    if (url.pathname.startsWith("/api/notion/")) {
      return handleNotionApi(request, env, url);
    }

    // 그 외 모든 요청은 정적 자산 (index.html 등)
    return env.ASSETS.fetch(request);
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
