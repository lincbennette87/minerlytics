export async function secGetJson(url, userAgent) {
  const resp = await fetch(url, {
    headers: {
      "User-Agent": userAgent, // REQUIRED by SEC
      "Accept": "application/json"
    }
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`SEC error ${resp.status} ${resp.statusText}: ${url}\n${text.slice(0, 200)}`);
  }

  return resp.json();
}

export function createThrottle(rps = 3) {
  const minGapMs = Math.ceil(1000 / rps);
  let last = 0;
  return async () => {
    const now = Date.now();
    const wait = Math.max(0, last + minGapMs - now);
    last = now + wait;
    if (wait) await new Promise(r => setTimeout(r, wait));
  };
}
