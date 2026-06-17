export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "POST,OPTIONS",
      "access-control-allow-headers": "content-type,x-api-key",
    },
  });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "POST,OPTIONS",
      "access-control-allow-headers": "content-type,x-api-key",
    },
  });
}

function cleanText(v) {
  return String(v || "").replace(/\s+/g, " ").trim();
}

function normalizePrompt(value = "") {
  return cleanText(value)
    .toLowerCase()
    .replace(/[^\w\s']/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isConversationalQuestion(question = "") {
  const q = normalizePrompt(question);
  if (!q) return false;
  return new Set([
    "hi",
    "hello",
    "hey",
    "good morning",
    "good afternoon",
    "good evening",
    "how are you",
    "how are you doing",
    "how is it going",
    "whats up",
    "what's up",
    "thanks",
    "thank you",
    "ok thanks",
  ]).has(q) || /^(hi|hello|hey)\b/.test(q);
}

function buildConversationalAnswer(question = "") {
  const q = normalizePrompt(question);
  if (q.includes("thank")) {
    return "You're welcome. I'm here whenever you want to learn about mining investing, project economics, risk, royalties, producers, developers, explorers, or anything from the Education Portal transcript library.";
  }

  return [
    "Hi, I'm doing well and ready to help with mining education.",
    "You can ask me to explain junior miner economics, IRR and payback, royalty and streaming companies, management quality, dilution, permitting risk, or red flags from the Education Portal transcripts.",
  ].join("\n\n");
}

function detectEducationIntent(question = "") {
  const q = normalizePrompt(question);
  return {
    conversational: isConversationalQuestion(q),
    summary: /\b(summary|summarize|main lessons|key lessons|takeaways)\b/.test(q),
    simple: /\b(simple|beginner|plain english|explain like)\b/.test(q),
    risk: /\b(risk|risks|red flag|red flags|avoid|warning)\b/.test(q),
    economics: /\b(irr|npv|payback|capex|opex|margin|cash flow|economics|valuation)\b/.test(q),
    followUp: /\b(what about|and what|more|expand|continue|why|how so)\b/.test(q),
  };
}

function buildKeywordList(question, history) {
  const historyText = Array.isArray(history)
    ? history.map((m) => String(m?.content || "")).join(" ")
    : "";

  const combined = `${question} ${historyText}`
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);

  const stop = new Set([
    "the","a","an","and","or","but","if","then","than","so","of","for","to","in","on","at","by",
    "with","from","about","into","over","after","before","under","again","further","once",
    "what","which","who","whom","this","that","these","those","am","is","are","was","were","be",
    "been","being","have","has","had","do","does","did","can","could","should","would","will",
    "just","ask","tell","me","please","explain","simple","simpler","more","lesson","lessons",
    "video","videos","transcript","transcripts","education","portal","minerlytics"
  ]);

  const seen = new Set();
  const keywords = [];

  for (const word of combined) {
    if (word.length < 3) continue;
    if (stop.has(word)) continue;
    if (seen.has(word)) continue;
    seen.add(word);
    keywords.push(word);
    if (keywords.length >= 10) break;
  }

  const intent = detectEducationIntent(question);
  if (intent.risk) keywords.push("risk", "risks", "red", "flags");
  if (intent.economics) keywords.push("irr", "npv", "payback", "capex", "cash", "flow", "economics");
  if (intent.summary) keywords.push("lessons", "takeaways", "summary");

  return Array.from(new Set(keywords)).slice(0, 14);
}

async function fetchRelevantRows(DB, question, history) {
  const keywords = buildKeywordList(question, history);
  let rows = [];

  if (keywords.length > 0) {
    const clauses = [];
    const params = [];

    for (const kw of keywords) {
      clauses.push(`lower(Transcript_Text) LIKE ?`);
      params.push(`%${kw}%`);
    }

    const sql = `
      SELECT *
      FROM Education_Portal
      WHERE ${clauses.join(" OR ")}
      LIMIT 8
    `;

    const result = await DB.prepare(sql).bind(...params).all();
    rows = result?.results || [];
  }

  if (!rows.length) {
    const fallback = await DB.prepare(`
      SELECT *
      FROM Education_Portal
      LIMIT 5
    `).all();

    rows = fallback?.results || [];
  }

  return rows;
}

function buildContext(rows) {
  if (!rows.length) return "No transcript context found.";

  return rows.map((row, i) => {
    const transcript = String(
      row?.Transcript_Text ||
      row?.transcript_text ||
      row?.text ||
      ""
    )
      .replace(/\s+/g, " ")
      .slice(0, 2400);

    return `SOURCE ${i + 1}
Video ID: ${row?.video_id || "Unknown"}
Transcript:
${transcript}`;
  }).join("\n\n====================\n\n");
}

function buildHistory(history) {
  return (Array.isArray(history) ? history : [])
    .slice(-4)
    .map((m) => `${m?.role === "assistant" ? "Assistant" : "User"}: ${String(m?.content || "").slice(0, 300)}`)
    .join("\n");
}

function buildSourceList(rows) {
  return (rows || []).map((r) => ({
    video_id: r.video_id || null,
    video_name: r.video_name || null,
  }));
}

export async function onRequestPost(context) {
  try {
    const { request, env } = context;
    const body = await request.json();
    const question = cleanText(body?.question || "");
    const history = Array.isArray(body?.history) ? body.history : [];

    if (!question) {
      return json({ error: "Question is required." }, 400);
    }

    if (isConversationalQuestion(question)) {
      return json({
        answer: buildConversationalAnswer(question),
        sources: [],
        intent: detectEducationIntent(question),
      });
    }

    if (!env.DB) {
      return json({ error: "Missing D1 binding 'DB'." }, 500);
    }

    if (!env.AI) {
      return json({ error: "Missing AI binding 'AI'." }, 500);
    }

    const rows = await fetchRelevantRows(env.DB, question, history);
    const transcriptContext = buildContext(rows);
    const priorConversation = buildHistory(history);
    const intent = detectEducationIntent(question);

    const result = await env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
  prompt: `You are the Minerlytics Education Portal AI Assistant.
Answer primarily from transcript context.
Be concise, clear, educational, and structured.
Do not invent answers.
If transcript context is limited, say so and suggest a better question.
For beginner/simple questions, use plain English.
For risk questions, separate risk, why it matters, and what to check.
For economics questions, explain the metric and how investors use it.
End with "Source basis:" and list relevant video names when available.

Conversation:
${priorConversation || "None"}

Question:
${question}

Transcript Context:
${transcriptContext}

Detected intent:
${JSON.stringify(intent)}`
});
    const answer =
      (typeof result === "string" && result) ||
      result?.response ||
      result?.result ||
      "I could not generate an answer from the transcript library.";

    return json({
      answer,
      sources: buildSourceList(rows),
      intent,
    });
  } catch (err) {
    return json({ error: err?.message || "Education portal chat failed." }, 500);
  }
}
