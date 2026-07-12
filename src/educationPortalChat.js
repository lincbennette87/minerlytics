const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "content-type,authorization,x-api-key"
};

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...CORS_HEADERS
    }
  });
}

export function educationOptions() {
  return new Response(null, {
    status: 204,
    headers: CORS_HEADERS
  });
}

function fallbackAnswer(question) {
  const topic = String(question || "").trim();
  if (!topic) {
    return "Ask a mining, finance, geology, permitting, or investing education question and I will explain it in plain language.";
  }

  return [
    `Here is a practical way to think about "${topic}".`,
    "Start with the asset, then separate geology, mining method, processing route, jurisdiction, capital needs, operating costs, and balance sheet risk. Strong mining analysis usually comes from comparing those pieces across companies rather than treating one metric as the whole story."
  ].join(" ");
}

export async function handleEducationPortalChat(request, env) {
  const body = await request.json().catch(() => ({}));
  const question = String(body.question || body.message || body.prompt || "").trim();

  if (!question) {
    return json({ ok: false, error: "Missing question." }, 400);
  }

  if (!env?.AI) {
    return json({
      ok: true,
      answer: fallbackAnswer(question),
      source: "fallback"
    });
  }

  try {
    const result = await env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
      messages: [
        {
          role: "system",
          content: "You are Minerlytics Education Portal. Explain mining, geology, finance, and public-company concepts clearly, accurately, and concisely for investors."
        },
        { role: "user", content: question }
      ],
      max_tokens: 700
    });

    return json({
      ok: true,
      answer: result?.response || result?.text || fallbackAnswer(question),
      source: "workers_ai"
    });
  } catch (error) {
    return json({
      ok: true,
      answer: fallbackAnswer(question),
      source: "fallback",
      warning: String(error?.message || error)
    });
  }
}
