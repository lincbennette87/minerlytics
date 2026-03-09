export async function onRequestGet() {
  return new Response(JSON.stringify({
    ok: true,
    route: "/api/admin/import-disclosure",
    method: "GET"
  }), {
    headers: { "content-type": "application/json" }
  });
}

export async function onRequestPost() {
  return new Response(JSON.stringify({
    ok: true,
    route: "/api/admin/import-disclosure",
    method: "POST"
  }), {
    headers: { "content-type": "application/json" }
  });
}
