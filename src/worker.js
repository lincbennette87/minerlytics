export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // Protect /api/* with x-api-key
    if (path.startsWith("/api/")) {
      const key = request.headers.get("x-api-key") || "";
      if (!env.WORKER_API_KEY || key !== env.WORKER_API_KEY) {
        return json({ ok: false, error: "Unauthorized" }, 401);
      }
    }

    if (path === "/") return new Response("ok");

    // GET /api/youtube/seen?video_id=...
    if (path === "/api/youtube/seen" && request.method === "GET") {
      const video_id = url.searchParams.get("video_id");
      if (!video_id) return json({ ok: false, error: "video_id required" }, 400);

      const row = await env.DB.prepare(
        "SELECT video_id FROM youtube_videos WHERE video_id = ?"
      ).bind(video_id).first();

      if (!row) return json({ seen: false }, 200);

      const symbols = await env.DB.prepare(
        "SELECT symbol FROM youtube_video_symbols WHERE video_id = ?"
      ).bind(video_id).all();

      return json({ seen: true, symbols: (symbols.results || []).map(r => r.symbol) }, 200);
    }

    // POST /api/ingest/youtube
    if (path === "/api/ingest/youtube" && request.method === "POST") {
      let body;
      try { body = await request.json(); }
      catch { return json({ ok: false, error: "Invalid JSON" }, 400); }

      const video_id = body.video_id;
      if (!video_id) return json({ ok: false, error: "video_id required" }, 400);

      const title = body.title || "";
      const channel = body.channel || "";
      const published_at = body.published_at || "";
      const urlStr = body.url || "";
      const segments = Array.isArray(body.segments) ? body.segments : [];
      const symbol_tags = Array.isArray(body.symbol_tags) ? body.symbol_tags : [];

      const stmts = [];

      // 1) video row (only once)
      stmts.push(
        env.DB.prepare(
          `INSERT OR IGNORE INTO youtube_videos (video_id, title, channel, published_at, url)
           VALUES (?, ?, ?, ?, ?)`
        ).bind(video_id, title, channel, published_at, urlStr)
      );

      // 2) tags (multi-symbol supported)
      for (const sym of symbol_tags) {
        if (!sym) continue;
        stmts.push(
          env.DB.prepare(
            `INSERT OR IGNORE INTO youtube_video_symbols (video_id, symbol)
             VALUES (?, ?)`
          ).bind(video_id, String(sym).toUpperCase())
        );
      }

      // 3) segments
      for (const s of segments) {
        if (!s || typeof s.text !== "string") continue;
        const start = Number(s.start ?? 0);
        const duration = Number(s.duration ?? 0);
        const text = s.text;

        stmts.push(
          env.DB.prepare(
            `INSERT INTO youtube_segments (video_id, start, duration, text)
             VALUES (?, ?, ?, ?)`
          ).bind(video_id, start, duration, text)
        );
      }

      try { await env.DB.batch(stmts); }
      catch (e) { return json({ ok: false, error: "DB error", detail: String(e) }, 500); }

      return json({ ok: true, video_id, segments: segments.length }, 200);
    }

    return json({ ok: false, error: "Not found" }, 404);
  },
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
