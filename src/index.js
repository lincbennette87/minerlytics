const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "content-type",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...CORS },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") return new Response("", { headers: CORS });

    if (url.pathname === "/api/health") {
      return new Response("Minerlytics DEV is running ✅", {
        headers: { "content-type": "text/plain", ...CORS },
      });
    }

    if (url.pathname === "/api/d1-test") {
      const r = await env.DB.prepare(`
        SELECT COUNT(*) as n FROM daily_ohlcv
      `).first();
      return json({ ok: true, rows_in_daily_ohlcv: r?.n ?? 0 });
    }

    return new Response("Not found", { status: 404, headers: CORS });
  },
};
