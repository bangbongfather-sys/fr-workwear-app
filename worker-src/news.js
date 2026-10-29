// ─── 뉴스 (뉴스 탭) ───
// 예전엔 앱이 rss2json(외부 무료 서비스)을 거쳐 구글 뉴스 RSS 를 읽었는데, 그 서비스가 막히면(한도·장애) 「Load failed」.
// 이제 서버가 구글 뉴스 RSS 를 직접 받아 JSON 으로 돌려준다. 아무 주소나 대신 받아 주지 않게 피드는 여기 정한 것만.
//   GET /api/news?feed=ko-economy → { ok, feed, items:[{ title, link, date, source, desc }], fetchedAt }
// 30분 동안 Cloudflare 캐시에 둔다 (여러 기기에서 열어도 구글에 한 번만).
export const NEWS_FEEDS = {
  "ko-economy": "https://news.google.com/rss/search?q=경제+OR+제조업+OR+수출&hl=ko&gl=KR&ceid=KR:ko",
  "fr-safety": "https://news.google.com/rss/search?q=방염+OR+난연+OR+방화복+OR+소방복+OR+산업안전&hl=ko&gl=KR&ceid=KR:ko",
  "fr-industry": "https://news.google.com/rss/search?q=조선+OR+플랜트+OR+석유화학+안전&hl=ko&gl=KR&ceid=KR:ko",
  "global-fr": "https://news.google.com/rss/search?q=flame+resistant+workwear+OR+FR+clothing&hl=en&gl=US&ceid=US:en",
};
const decode = (s) => String(s || "")
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
  .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
const tag = (xml, name) => { const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i")); return m ? decode(m[1]).trim() : ""; };
export function parseRss(xml) {
  const items = [];
  for (const m of String(xml || "").matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)) {
    const x = m[1];
    const source = tag(x, "source");
    let title = tag(x, "title");
    if (source && title.endsWith(` - ${source}`)) title = title.slice(0, -(source.length + 3));   // 구글 뉴스는 제목 끝에 「 - 언론사」
    const desc = tag(x, "description").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
    const link = tag(x, "link");
    if (!title || !/^https?:\/\//.test(link)) continue;
    items.push({ title, link, date: tag(x, "pubDate"), source, desc: desc === title || desc.startsWith(title) ? "" : desc });
    if (items.length >= 40) break;
  }
  return items;
}
export async function newsFeed(feedKey, { fresh = false } = {}) {
  const url = NEWS_FEEDS[feedKey];
  if (!url) return { ok: false, error: "없는 뉴스 묶음입니다" };
  const cache = typeof caches !== "undefined" ? caches.default : null;
  const ck = new Request(`https://nj-news-cache.local/${feedKey}`);
  if (cache && !fresh) { const hit = await cache.match(ck); if (hit) return await hit.json(); }
  const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; NJSafetyNews/1.0)", "Accept": "application/rss+xml, application/xml, text/xml" } });
  if (!r.ok) return { ok: false, error: `구글 뉴스 응답 ${r.status}` };
  const items = parseRss(await r.text());
  const out = { ok: true, feed: feedKey, items, fetchedAt: new Date().toISOString() };
  if (cache && items.length) await cache.put(ck, new Response(JSON.stringify(out), { headers: { "Content-Type": "application/json", "Cache-Control": "max-age=1800" } }));
  return out;
}
