export default {
  async fetch(request, env, ctx) {
    try {
      return new Response("Minerlytics DEV is running ✅", {
        headers: { "content-type": "text/plain" },
      });
    } catch (err) {
      return new Response(
        "Worker error:\n" + (err?.stack || err?.message || String(err)),
        { status: 500, headers: { "content-type": "text/plain" } }
      );
    }
  },
};
