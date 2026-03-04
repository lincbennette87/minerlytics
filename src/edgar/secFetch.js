// src/edgar/secFetch.js
// Common SEC fetch helpers (ESM / Node 20)

export function createThrottle(rps = 1) {
  const minDelayMs = Math.max(1, Math.floor(1000 / Math.max(0.1, rps)));
  let last = 0;
  return async function throttle() {
    const now = Date.now();
    const wait = Math.max(0, last + minDelayMs - now);
    if (wait) await new Promise((r) => setTimeout(r, wait));
    last = Date.now();
  };
}

function headersFor(userAgent, accept) {
  if (!userAgent) throw new Error("Missing userAgent");
  return {
    "user-agent": userAgent,
    "accept": accept || "*/*"
  };
}

export async function secGetJson(url, userAgent) {
  const res = await fetch(url, { headers: headersFor(userAgent, "application/json,text/plain,*/*") });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`SEC JSON fetch failed ${res.status}: ${url} :: ${t.slice(0, 200)}`);
  }
  return await res.json();
}

export async function secGetText(url, userAgent) {
  const res = await fetch(url, { headers: headersFor(userAgent, "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8") });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`SEC text fetch failed ${res.status}: ${url} :: ${t.slice(0, 200)}`);
  }
  return await res.text();
}
