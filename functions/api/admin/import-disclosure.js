export async function onRequestPost(context) {
  const { request, env } = context;

  const auth = request.headers.get("x-import-key");

  if (!auth) {
    return new Response(JSON.stringify({
      error: "Missing x-import-key header"
    }), {
      status: 403,
      headers: { "content-type": "application/json" }
    });
  }

  if (!env.IMPORT_KEY) {
    return new Response(JSON.stringify({
      error: "IMPORT_KEY not set in Cloudflare env"
    }), {
      status: 403,
      headers: { "content-type": "application/json" }
    });
  }

  if (auth !== env.IMPORT_KEY) {
    return new Response(JSON.stringify({
      error: "x-import-key does not match IMPORT_KEY",
      headerLength: auth.length,
      envLength: env.IMPORT_KEY.length
    }), {
      status: 403,
      headers: { "content-type": "application/json" }
    });
  }

  return new Response(JSON.stringify({ ok: true }), {
    headers: { "content-type": "application/json" }
  });
}
