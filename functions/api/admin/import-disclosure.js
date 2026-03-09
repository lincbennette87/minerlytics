export async function onRequestPost(context) {
  const { request, env } = context;

  const auth = request.headers.get("x-import-key");

  if (!auth) {
    return new Response(JSON.stringify({ error: "Missing x-import-key header" }), {
      status: 403,
      headers: { "content-type": "application/json" }
    });
  }

  if (!env.IMPORT_KEY) {
    return new Response(JSON.stringify({ error: "IMPORT_KEY missing in Cloudflare env" }), {
      status: 403,
      headers: { "content-type": "application/json" }
    });
  }

  if (auth !== env.IMPORT_KEY) {
    return new Response(JSON.stringify({ error: "Key mismatch" }), {
      status: 403,
      headers: { "content-type": "application/json" }
    });
  }

  return new Response(JSON.stringify({ ok: true, message: "Auth passed" }), {
    headers: { "content-type": "application/json" }
  });
}
