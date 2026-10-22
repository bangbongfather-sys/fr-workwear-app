// ── 명세서(거래명세서·송장) 사진 → 입고 행 ──
// 매입 현황 「명세서 찍어 입고」: 앱이 사진(여러 장)을 줄여 보내면 Claude 비전이 품목·사이즈·수량·단가를 읽어 JSON 으로 돌려준다.
// 등록은 앱이 한다(미리보기에서 사용자가 고친 뒤). 서버는 읽기만 — ANTHROPIC_API_KEY(시크릿)가 없으면 no_key 로 알려
// 앱이 견적 탭에 저장된 키로 직접 부르게 한다.

export const INVOICE_PROMPT = (supplier, names) => `사진은 공장·업체가 보낸 거래명세서(송장·납품서)입니다. ${supplier ? `보낸 곳: ${supplier}. ` : ""}표의 품목을 읽어 JSON 만 출력하세요.

형식:
{"date":"YYYY-MM-DD 또는 빈 문자열","supplier":"명세서에 적힌 공급자 상호 또는 빈 문자열","items":[{"name":"품목명","size":"사이즈(없으면 빈 문자열)","qty":수량,"unit":"벌·yard·개 등(없으면 빈 문자열)","unitPrice":단가 또는 null,"amount":금액 또는 null}],"total":합계 또는 null,"memo":"읽기 애매한 부분 한 줄(없으면 빈 문자열)"}

규칙:
- 헤더·합계·소계·부가세 줄은 items 에 넣지 않는다.
- 사이즈가 가로로 칸칸이(90·95·100… 아래 수량) 적힌 표면, 수량이 있는 사이즈마다 item 을 하나씩 만든다. 수량 0·빈칸은 뺀다.
- 손글씨 숫자는 자릿수를 주의해서 읽고, 수량×단가=금액이 맞는지 확인한다. 안 맞으면 memo 에 적는다.
- 숫자는 쉼표·원 없이 숫자로.
${names && names.length ? `- 품목명은 가능하면 이 목록의 이름으로 맞춘다(같은 물건일 때만): ${names.slice(0, 40).join(" / ")}\n` : ""}- 명세서가 아니거나 표를 못 읽으면 {"items":[],"memo":"이유"} 만 출력한다.
- JSON 외의 글은 쓰지 않는다.`;

export function parseInvoiceJson(text) {
  const t = String(text || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  const s = t.indexOf("{"), e = t.lastIndexOf("}");
  if (s < 0 || e < s) throw new Error("명세서 내용을 읽지 못했습니다");
  const j = JSON.parse(t.slice(s, e + 1));
  const num = (v) => { if (v == null || v === "") return null; const n = Number(String(v).replace(/[,\s원]/g, "")); return Number.isFinite(n) ? n : null; };
  const items = (Array.isArray(j.items) ? j.items : []).map((x) => ({
    name: String(x && x.name || "").trim().slice(0, 80),
    size: String(x && x.size != null ? x.size : "").trim().slice(0, 20),
    qty: num(x && x.qty),
    unit: String(x && x.unit || "").trim().slice(0, 10),
    unitPrice: num(x && x.unitPrice),
    amount: num(x && x.amount),
  })).filter((x) => x.name && x.qty);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(j.date || "")) ? j.date : "";
  return { date, supplier: String(j.supplier || "").trim().slice(0, 60), items, total: num(j.total), memo: String(j.memo || "").slice(0, 300) };
}

export async function invoiceOcr(env, body) {
  if (!env.ANTHROPIC_API_KEY) return { ok: false, code: "no_key", error: "서버에 Claude API 키(ANTHROPIC_API_KEY)가 없습니다" };
  const images = (Array.isArray(body && body.images) ? body.images : []).slice(0, 6)
    .filter((im) => im && /^image\/(jpeg|png|webp|gif)$/.test(im.type || "") && typeof im.data === "string" && im.data.length < 6_000_000);
  if (!images.length) return { ok: false, error: "사진이 없습니다" };
  const supplier = String(body.supplier || "").slice(0, 60);
  const names = Array.isArray(body.names) ? body.names.map((n) => String(n).slice(0, 60)).slice(0, 40) : [];
  const content = [
    ...images.map((im) => ({ type: "image", source: { type: "base64", media_type: im.type, data: im.data } })),
    { type: "text", text: INVOICE_PROMPT(supplier, names) + (images.length > 1 ? `\n- 사진 ${images.length}장은 같은 명세서의 여러 쪽이거나 여러 장입니다. 모두 합쳐 items 하나로 만든다(같은 줄이 두 사진에 겹쳐 찍혔으면 한 번만).` : "") },
  ];
  const model = env.OCR_MODEL || "claude-sonnet-5-5";
  try {
    const ctrl = new AbortController(); const tm = setTimeout(() => ctrl.abort(), 85000);
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST", signal: ctrl.signal,
      headers: { "content-type": "application/json", "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model, max_tokens: 4000, messages: [{ role: "user", content }] }),
    });
    clearTimeout(tm);
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, error: `Claude API 응답 ${r.status}: ${(j.error && j.error.message) || ""}`.slice(0, 300) };
    const text = (j.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
    return { ok: true, model, ...parseInvoiceJson(text) };
  } catch (e) {
    return { ok: false, error: e && e.name === "AbortError" ? "시간 초과(85초) — 사진 수를 줄여 다시 해 주세요" : `읽기 실패: ${e && e.message}` };
  }
}
