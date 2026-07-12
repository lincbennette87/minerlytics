function decodeXml(value = "") {
  return String(value || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();
}

function tagValue(block, tagName) {
  const pattern = new RegExp(`<${tagName}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tagName}>`, "i");
  const match = String(block || "").match(pattern);
  return match ? decodeXml(match[1]) : "";
}

function normalizeDate(value) {
  if (!value) return "";
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : "";
}

export function googleRssUrl(query = "") {
  const q = String(query || "").trim() || "gold mining stocks";
  return `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`;
}

export function parseRssItems(xml = "", limit = 25) {
  const safeLimit = Math.min(Math.max(Number(limit || 25), 1), 100);
  const blocks = String(xml || "").match(/<item\b[\s\S]*?<\/item>/gi) || [];

  return blocks.slice(0, safeLimit).map((block) => {
    const source = tagValue(block, "source");
    const pubDate = tagValue(block, "pubDate");
    return {
      title: tagValue(block, "title"),
      link: tagValue(block, "link"),
      source,
      publisher: source,
      pubDate,
      published_at: normalizeDate(pubDate),
      date: normalizeDate(pubDate),
      description: tagValue(block, "description")
    };
  }).filter((item) => item.title || item.link);
}
