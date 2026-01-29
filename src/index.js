export default {
  async fetch(request, env, ctx) {
    return new Response("Worker is live", { status: 200 });
  }
};
