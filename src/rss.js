const GOOGLE_NEWS_BASE = "https://news.google.com/rss/search";

export function googleRssUrl(query) {
  const q = `${query} when:7d`;
  const u = new URL(GOOGLE_NEWS_BASE);
  u.searchParams.set("q", q);
  u.searchParams.set("hl", "en-US");
  u.searchParams.set("gl", "US");
  u.searchParams.set("ceid", "US:en");
  return u.toString();
}

function textBetween(s, a, b) {
  const i = s.indexOf(a);
  if (i === -1) return "";
  const j = s.indexOf(b, i + a.length);
  if (j === -1) return "";
  return s.slice(i + a.length, j);
}

function decodeEntities(s) {
  return (s || "")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'");
}

export function parseRssItems(xml, limit = 25) {
  const items = [];
  let rest = xml || "";
  while (true) {
    const start = rest.indexOf("<item>");
    if (start === -1) break;
    const end = rest.indexOf("</item>", start);
    if (end === -1) break;
    const chunk = rest.slice(start, end + 7);
    rest = rest.slice(end + 7);

    const title = decodeEntities(textBetween(chunk, "<title>", "</title>")).trim();
    const link = decodeEntities(textBetween(chunk, "<link>", "</link>")).trim();
    const pubDate = decodeEntities(textBetween(chunk, "<pubDate>", "</pubDate>")).trim();

    const sourceChunk = decodeEntities(textBetween(chunk, "<source", "</source>"));
    const source = sourceChunk.includes(">") ? sourceChunk.slice(sourceChunk.indexOf(">") + 1).trim() : null;

    if (title && link) items.push({ title, link, pubDate, source: source || null });
    if (items.length >= limit) break;
  }
  return items;
}
