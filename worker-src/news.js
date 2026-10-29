// ─── 뉴스 (뉴스 탭) ───
// 앱이 rss2json(외부 무료 서비스)로 구글 뉴스를 읽던 건 막히면 「Load failed」. 서버가 직접 받게 했더니
// 구글 뉴스는 Cloudflare 서버에서 오는 요청을 503 으로 막을 때가 많다 → 출처를 차례로 시도한다:
//   ① 네이버 뉴스 검색 API (시크릿 NAVER_CLIENT_ID · NAVER_CLIENT_SECRET 이 있을 때만, 한국어 피드)
//   ② 구글 뉴스 RSS (브라우저처럼 요청)   ③ 빙 뉴스 RSS (같은 검색어)   ④ rss2json 경유 구글 뉴스
// 아무 주소나 대신 받아 주지 않게 피드(검색어)는 여기 정한 것만.
//   GET /api/news?feed=ko-economy[&fresh=1] → { ok, feed, via, items:[{ title, link, date, source, desc }], fetchedAt, tried }
// 성공한 결과는 30분 동안 Cloudflare 캐시에 둔다.
export const NEWS_FEEDS = {
  "ko-economy": { q: "경제 OR 제조업 OR 수출", naver: "제조업 수출 경제", lang: "ko" },
  "fr-safety": { q: "방염 OR 난연 OR 방화복 OR 소방복 OR 산업안전", naver: "방염복 산업안전", lang: "ko" },
  "fr-industry": { q: "조선 OR 플랜트 OR 석유화학 안전", naver: "조선 플랜트 석유화학 안전", lang: "ko" },
  "global-fr": { q: "flame resistant workwear OR FR clothing", lang: "en" },
};
const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const decode = (s) => String(s || "")
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
  .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
const tag = (xml, name) => { const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i")); return m ? decode(m[1]).trim() : ""; };
const stripHtml = (s) => decode(String(s || "")).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
// 빙 뉴스 링크는 bing.com/news/apiclick.aspx?…&url=원문 — 원문 주소로 바꾼다
const unwrapLink = (link) => { try { const u = new URL(link); if (/bing\.com$/i.test(u.hostname) && u.searchParams.get("url")) return u.searchParams.get("url"); } catch {} return link; };
export function parseRss(xml) {
  const items = [];
  for (const m of String(xml || "").matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)) {
    const x = m[1];
    const source = tag(x, "source") || tag(x, "News:Source");
    let title = stripHtml(tag(x, "title"));
    if (source && title.endsWith(` - ${source}`)) title = title.slice(0, -(source.length + 3));   // 구글 뉴스는 제목 끝에 「 - 언론사」
    const desc = stripHtml(tag(x, "description")).slice(0, 200);
    const link = unwrapLink(tag(x, "link"));
    if (!title || !/^https?:\/\//.test(link)) continue;
    items.push({ title, link, date: tag(x, "pubDate"), source, desc: desc === title || desc.startsWith(title) ? "" : desc });
    if (items.length >= 40) break;
  }
  return items;
}
const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } };
async function viaNaver(f, env) {
  if (!env.NAVER_CLIENT_ID || !env.NAVER_CLIENT_SECRET || f.lang !== "ko") return null;
  const r = await fetch(`https://openapi.naver.com/v1/search/news.json?query=${encodeURIComponent(f.naver || f.q)}&display=40&sort=date`, { headers: { "X-Naver-Client-Id": env.NAVER_CLIENT_ID, "X-Naver-Client-Secret": env.NAVER_CLIENT_SECRET } });
  if (!r.ok) throw new Error(`네이버 ${r.status}`);
  const j = await r.json();
  return (j.items || []).map(it => ({ title: stripHtml(it.title), link: it.originallink || it.link, date: it.pubDate, source: host(it.originallink || it.link), desc: stripHtml(it.description).slice(0, 200) })).filter(x => x.title && x.link);
}
async function viaGoogle(f) {
  const loc = f.lang === "en" ? "hl=en-US&gl=US&ceid=US:en" : "hl=ko&gl=KR&ceid=KR:ko";
  const r = await fetch(`https://news.google.com/rss/search?q=${encodeURIComponent(f.q)}&${loc}`, { headers: { "User-Agent": BROWSER_UA, "Accept": "application/rss+xml, application/xml;q=0.9, */*;q=0.8", "Accept-Language": f.lang === "en" ? "en-US,en;q=0.9" : "ko-KR,ko;q=0.9" } });
  if (!r.ok) throw new Error(`구글 ${r.status}`);
  return parseRss(await r.text());
}
async function viaBing(f) {
  const loc = f.lang === "en" ? "cc=US&setlang=en-US" : "cc=KR&setlang=ko-KR";
  const r = await fetch(`https://www.bing.com/news/search?q=${encodeURIComponent(f.q)}&format=rss&${loc}`, { headers: { "User-Agent": BROWSER_UA, "Accept": "application/rss+xml, application/xml;q=0.9, */*;q=0.8", "Accept-Language": f.lang === "en" ? "en-US,en;q=0.9" : "ko-KR,ko;q=0.9" } });
  if (!r.ok) throw new Error(`빙 ${r.status}`);
  return parseRss(await r.text());
}
async function viaRss2json(f) {
  const loc = f.lang === "en" ? "hl=en-US&gl=US&ceid=US:en" : "hl=ko&gl=KR&ceid=KR:ko";
  const r = await fetch(`https://api.rss2json.com/v1/api.json?rss_url=${encodeURIComponent(`https://news.google.com/rss/search?q=${encodeURIComponent(f.q)}&${loc}`)}`);
  const j = await r.json().catch(() => ({}));
  if (j.status !== "ok") throw new Error(`rss2json ${j.message || r.status}`);
  return (j.items || []).map(it => ({ title: stripHtml(it.title), link: it.link, date: it.pubDate, source: it.author || "", desc: stripHtml(it.description).slice(0, 200) }));
}
export async function newsFeed(feedKey, { fresh = false, env = {} } = {}) {
  const f = NEWS_FEEDS[feedKey];
  if (!f) return { ok: false, error: "없는 뉴스 묶음입니다" };
  const cache = typeof caches !== "undefined" ? caches.default : null;
  const ck = new Request(`https://nj-news-cache.local/v2/${feedKey}`);
  if (cache && !fresh) { const hit = await cache.match(ck); if (hit) return await hit.json(); }
  const tried = [];
  for (const [via, fn] of [["naver", viaNaver], ["google", viaGoogle], ["bing", viaBing], ["rss2json", viaRss2json]]) {
    try {
      const items = await fn(f, env);
      if (items == null) continue;                       // 이 출처는 안 씀(키 없음)
      if (!items.length) { tried.push(`${via}: 0건`); continue; }
      const out = { ok: true, feed: feedKey, via, items, fetchedAt: new Date().toISOString(), tried };
      if (cache) await cache.put(ck, new Response(JSON.stringify(out), { headers: { "Content-Type": "application/json", "Cache-Control": "max-age=1800" } }));
      return out;
    } catch (e) { tried.push(e && e.message || String(e)); }
  }
  return { ok: false, error: `뉴스 출처가 모두 응답하지 않아요 (${tried.join(" · ")})`, tried };
}
