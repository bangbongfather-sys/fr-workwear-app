// ── 노션 「To Do List」 일정 페이지 — 앱(/api/notion/todo)과 커넥터(add_todo·update_todo)가 같이 쓰는 한 경로 ──
// 앱에서 일정을 추가하면 노션 페이지를 만들고 그 id(notionPageId)를 일정에 붙인다. 완료·내용·날짜를 바꾸면 페이지도 고친다.
//   NOTION_TOKEN (Secret) · NOTION_TODO_DSID (Plain) 이 있어야 동작한다. 없으면 { ok:false, off:true }.
export const NOTION_API = "https://api.notion.com/v1";
export const NOTION_VERSION = "2022-06-28";

export const notionTodoConfigured = (env) => !!(env && env.NOTION_TOKEN && env.NOTION_TODO_DSID);
export const notionHeadersOf = (env) => ({
  "Authorization": `Bearer ${env.NOTION_TOKEN}`,
  "Notion-Version": NOTION_VERSION,
  "Content-Type": "application/json",
});

// 앱 일정 필드 → 노션 속성 (이름 · 업무 기간 · 완료 · 상태 구분). 주어진 필드만 만든다.
export function buildTodoProperties(body) {
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

const fail = async (res) => {
  const data = await res.json().catch(() => ({}));
  return { ok: false, status: res.status, error: data.message || `Notion HTTP ${res.status}`, details: data };
};

// 생성 → { ok:true, notionPageId, url }
export async function notionTodoCreate(env, body) {
  if (!notionTodoConfigured(env)) return { ok: false, off: true, status: 500, error: "NOTION_TOKEN 또는 NOTION_TODO_DSID 환경변수가 설정되지 않았습니다." };
  if (!body || !body.text) return { ok: false, status: 400, error: "text 필수" };
  const res = await fetch(`${NOTION_API}/pages`, {
    method: "POST", headers: notionHeadersOf(env),
    body: JSON.stringify({ parent: { database_id: env.NOTION_TODO_DSID }, properties: buildTodoProperties(body) }),
  });
  if (!res.ok) return fail(res);
  const data = await res.json();
  return { ok: true, notionPageId: data.id, url: data.url };
}

// 수정 (주어진 필드만)
export async function notionTodoPatch(env, pageId, body) {
  if (!notionTodoConfigured(env)) return { ok: false, off: true, status: 500, error: "NOTION_TOKEN 또는 NOTION_TODO_DSID 환경변수가 설정되지 않았습니다." };
  const res = await fetch(`${NOTION_API}/pages/${pageId}`, {
    method: "PATCH", headers: notionHeadersOf(env), body: JSON.stringify({ properties: buildTodoProperties(body || {}) }),
  });
  if (!res.ok) return fail(res);
  return { ok: true };
}

// 보관(아카이브) — 앱에서 일정을 지울 때
export async function notionTodoArchive(env, pageId) {
  if (!notionTodoConfigured(env)) return { ok: false, off: true, status: 500, error: "NOTION_TOKEN 또는 NOTION_TODO_DSID 환경변수가 설정되지 않았습니다." };
  const res = await fetch(`${NOTION_API}/pages/${pageId}`, {
    method: "PATCH", headers: notionHeadersOf(env), body: JSON.stringify({ archived: true }),
  });
  if (!res.ok) return fail(res);
  return { ok: true };
}
