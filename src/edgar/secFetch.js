export async function secGetText(url, userAgent) {
  const res = await fetch(url, {
    headers: {
      "user-agent": userAgent,
      "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
    }
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`SEC text fetch failed ${res.status}: ${url} :: ${t.slice(0, 200)}`);
  }
  return await res.text();
}
