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
  return String(v || "").trim();
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

  return keywords;
}

async function fetchRelevantRows(DB, question, history) {
  const keywords = buildKeywordList(question, history);
  let rows = [];

  if (keywords.length > 0) {
    const clauses = [];
    const params = [];

    for (const kw of keywords) {
      clauses.push(`lower(Transcript_Text) LIKE ?`);
      clauses.push(`lower(video_name) LIKE ?`);
      params.push(`%${kw}%`, `%${kw}%`);
    }

    const sql = `
      SELECT video_id, video_name, Transcript_Text
      FROM Education_Portal
      WHERE ${clauses.join(" OR ")}
      LIMIT 8
    `;

    const result = await DB.prepare(sql).bind(...params).all();
    rows = result?.results || [];
  }

  if (!rows.length) {
    const fallback = await DB.prepare(`
      SELECT video_id, video_name, Transcript_Text
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
    const transcript = String(row?.Transcript_Text || "").slice(0, 4000);
    return `SOURCE ${i + 1}
Video Name: ${row?.video_name || "Unknown"}
Video ID: ${row?.video_id || "Unknown"}
Transcript:
${transcript}`;
  }).join("\n\n====================\n\n");
}

function buildHistory(history) {
  return (Array.isArray(history) ? history : [])
    .slice(-8)
    .map((m) => `${m?.role === "assistant" ? "Assistant" : "User"}: ${String(m?.content || "")}`)
    .join("\n");
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

    if (!env.DB) {
      return json({ error: "Missing D1 binding 'DB'." }, 500);
    }

    if (!env.AI) {
      return json({ error: "Missing AI binding 'AI'." }, 500);
    }

    const rows = await fetchRelevantRows(env.DB, question, history);
    const transcriptContext = buildContext(rows);
    const priorConversation = buildHistory(history);

    const result = await env.AI.run("@cf/meta/llama-3.1-8b-instruct", {
      prompt: `You are the Minerlytics Education Portal AI Assistant.

Answer using the transcript context below.
Use prior conversation for follow-up questions.
Be clear, educational, and concise.
If the answer is not in the transcript context, say so directly.

PRIOR CONVERSATION
${priorConversation || "None"}

QUESTION
${question}

TRANSCRIPT CONTEXT
${transcriptContext}`
    });

    const answer =
      (typeof result === "string" && result) ||
      result?.response ||
      result?.result ||
      "I could not generate an answer from the transcript library.";

    return json({
      answer,
      sources: rows.map((r) => ({
        video_id: r.video_id || null,
        video_name: r.video_name || null,
      })),
    });
  } catch (err) {
    return json({ error: err?.message || "Education portal chat failed." }, 500);
  }
}
