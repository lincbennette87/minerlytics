export async function onRequestPost(context) {
  const { request, env } = context;

  const auth = request.headers.get("x-import-key");

  return new Response(JSON.stringify({
    hasHeader: !!auth,
    headerLength: auth ? auth.length : 0,
    hasEnvKey: !!env.IMPORT_KEY,
    envKeyLength: env.IMPORT_KEY ? env.IMPORT_KEY.length : 0,
    headerPreview: auth ? auth.slice(0, 4) : null,
    envPreview: env.IMPORT_KEY ? env.IMPORT_KEY.slice(0, 4) : null
  }), {
    headers: { "content-type": "application/json" }
  });
}
