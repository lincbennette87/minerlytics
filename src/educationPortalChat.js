const CHAT_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

const EDU_CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST,OPTIONS",
  "access-control-allow-headers": "content-type,x-api-key",
};

function eduJson(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...EDU_CORS,
    },
  });
}

export function educationOptions() {
  return new Response(null, {
    status: 204,
    headers: { ...EDU_CORS },
  });
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
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
    "the", "a", "an", "and", "or", "but", "if", "then", "than", "so", "of", "for", "to", "in",
    "on", "at", "by", "with", "from", "about", "into", "over", "after", "before", "under",
    "again", "further", "once", "what", "which", "who", "whom", "this", "that", "these", "those",
    "am", "is", "are", "was", "were", "be", "been", "being", "have", "has", "had", "do", "does",
    "did", "can", "could", "should", "would", "will", "just", "ask", "tell", "me", "please",
    "explain", "simple", "simpler", "more", "lesson", "lessons", "video", "videos", "transcript",
    "transcripts", "education", "portal", "minerlytics",
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

async function fetchRelevantRows(env, question, history) {
  const keywords = buildKeywordList(question, history);

  if (!env.DB) {
    throw new Error("Missing D1 binding 'DB'.");
  }

  let rows = [];

  if (keywords.length > 0) {
    const clauses = [];
    const params = [];

    for (const kw of keywords) {
      clauses.push("lower(Transcript_Text) LIKE ?");
      clauses.push("lower(video_name) LIKE ?");
      params.push(`%${kw}%`, `%${kw}%`);
    }

    const sql = `
      SELECT video_id, video_name, Transcript_Text
      FROM Education_Portal
      WHERE ${clauses.join(" OR ")}
      LIMIT 8
    `;

    const result = await env.DB.prepare(sql).bind(...params).all();
    rows = result?.results || [];
  }

  if (!rows.length) {
    const fallback = await env.DB.prepare(`
      SELECT video_id, video_name, Transcript_Text
      FROM Education_Portal
      LIMIT 5
    `).all();

    rows = fallback?.results || [];
  }

  return rows;
}

function buildContext(rows) {
  if (!rows.length) {
    return "No transcript context found.";
  }

  return rows
    .map((row, i) => {
      const transcript = String(row?.Transcript_Text || "").slice(0, 5000);

      return [
        `SOURCE ${i + 1}`,
        `Video Name: ${row?.video_name || "Unknown"}`,
        `Video ID: ${row?.video_id || "Unknown"}`,
        "Transcript:",
        transcript,
      ].join("\n");
    })
    .join("\n\n==============================\n\n");
}

function buildHistory(history) {
  return (Array.isArray(history) ? history : [])
    .slice(-8)
    .map((m) => {
      const role = m?.role === "assistant" ? "Assistant" : "User";
      return `${role}: ${cleanText(m?.content || "")}`;
    })
    .join("\n");
}

export async function handleEducationPortalChat(request, env) {
  try {
    const body = await request.json();
    const question = cleanText(body?.question || "");
    const history = Array.isArray(body?.history) ? body.history : [];

    if (!question) {
      return eduJson({ error: "Question is required." }, 400);
    }

    if (!env.AI) {
      return eduJson({ error: "Missing AI binding 'AI'." }, 500);
    }

    const rows = await fetchRelevantRows(env, question, history);
    const context = buildContext(rows);
    const priorConversation = buildHistory(history);

    const messages = [
      {
        role: "system",
        content: `You are the Minerlytics Education Portal AI Assistant.

Rules:
- Never reference Rick Rule directly
- Answer based on transcript context
- Support follow-up questions
- Be clear and educational
- Do not invent answers
- Prefer structured responses
- Mention video names when useful
- If the transcripts do not support the answer, say so clearly`,
      },
      {
        role: "user",
        content: `PRIOR CONVERSATION
${priorConversation || "None"}

USER QUESTION
${question}

TRANSCRIPT CONTEXT
${context}

Answer using transcript context.`,
      },
    ];

    const aiResult = await env.AI.run(CHAT_MODEL, { messages });

    const answer =
      aiResult?.response ||
      aiResult?.result?.response ||
      aiResult?.text ||
      "No answer could be generated.";

    return eduJson({
      answer,
      sources: rows.map((r) => ({
        video_id: r?.video_id || null,
        video_name: r?.video_name || null,
      })),
    });
  } catch (err) {
    return eduJson(
      { error: err?.message || "Education portal chat failed." },
      500
    );
  }
}
