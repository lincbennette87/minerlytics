const CHAT_MODEL = "@cf/meta/llama-3.1-8b-instruct";

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

function cleanText(v) {
  return String(v || "").replace(/\s+/g, " ").trim();
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
    "the", "a", "an", "and", "or", "but", "if", "then", "than", "so", "of", "for", "to", "in", "on", "at", "by",
    "with", "from", "about", "into", "over", "after", "before", "under", "again", "further", "once",
    "what", "which", "who", "whom", "this", "that", "these", "those", "am", "is", "are", "was", "were", "be",
    "been", "being", "have", "has", "had", "do", "does", "did", "can", "could", "should", "would", "will",
    "just", "ask", "tell", "me", "please", "explain", "simple", "simpler", "more", "lesson", "lessons",
    "video", "videos", "transcript", "transcripts", "education", "portal", "minerlytics",
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

  if (keywords.length) {
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
  if (!rows.length) return "No transcript context found.";

  return rows
    .map((row, i) => {
      const transcript = String(row?.Transcript_Text || "").slice(0, 5000);
      return [
        `SOURCE ${i + 1}`,
        `Video Name: ${row?.video_name || "Unknown"}`,
        `Video ID: ${row?.video_id || "Unknown"}`,
        `Transcript:`,
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
      return eduJson({ error: "Missing AI binding 'AI' in Cloudflare." }, 500);
    }

    const rows = await fetchRelevantRows(env, question, history);
    const context = buildContext(rows);
    const priorConversation = buildHistory(history);

    const messages = [
      {
        role: "system",
        content: `You are the Minerlytics Education Portal AI Assistant.

Rules:
- NEVER reference Rick Rule or call out specific source of the information
- Answer based primarily on the transcript context provided.
- Support follow-up questions using prior conversation context.
- Be educational, practical, and clear.
- If the answer is only partially supported by the transcripts, say that clearly.
- If the transcripts do not contain the answer, say that directly instead of inventing.
- Prefer concise structured answers with short paragraphs or bullets.
- Mention video names when useful.`,
      },
      {
        role: "user",
        content: `PRIOR CONVERSATION
${priorConversation || "None"}

USER QUESTION
${question}

TRANSCRIPT CONTEXT
${context}

Please answer the user using the transcript context.`,
      },
    ];

    const aiResult = await env.AI.run(CHAT_MODEL, { messages });

    const answer =
      aiResult?.response ||
      aiResult?.result?.response ||
      aiResult?.text ||
      "I could not generate an answer from the transcript library.";

    return eduJson({
      answer,
      sources: rows.map((r) => ({
        video_id: r.video_id || null,
        video_name: r.video_name || null,
      })),
    });
  } catch (err) {
    return eduJson(
      { error: err?.message || "Education portal chat failed." },
      500
    );
  }
}    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);

  const stop = new Set([
    "the", "a", "an", "and", "or", "but", "if", "then", "than", "so", "of", "for", "to", "in", "on", "at", "by",
    "with", "from", "about", "into", "over", "after", "before", "under", "again", "further", "once",
    "what", "which", "who", "whom", "this", "that", "these", "those", "am", "is", "are", "was", "were", "be",
    "been", "being", "have", "has", "had", "do", "does", "did", "can", "could", "should", "would", "will",
    "just", "ask", "tell", "me", "please", "explain", "simple", "simpler", "more", "lesson", "lessons",
    "video", "videos", "transcript", "transcripts", "education", "portal", "minerlytics",
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

  if (keywords.length) {
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
  if (!rows.length) return "No transcript context found.";

  return rows
    .map((row, i) => {
      const transcript = String(row?.Transcript_Text || "").slice(0, 5000);
      return [
        `SOURCE ${i + 1}`,
        `Video Name: ${row?.video_name || "Unknown"}`,
        `Video ID: ${row?.video_id || "Unknown"}`,
        `Transcript:`,
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
      return eduJson({ error: "Missing AI binding 'AI' in Cloudflare." }, 500);
    }

    const rows = await fetchRelevantRows(env, question, history);
    const context = buildContext(rows);
    const priorConversation = buildHistory(history);

    const messages = [
      {
        role: "system",
        content: `You are the Minerlytics Education Portal AI Assistant.

Rules:
- NEVER reference Rick Rule or call out specific source of the information
- Answer based primarily on the transcript context provided.
- Support follow-up questions using prior conversation context.
- Be educational, practical, and clear.
- If the answer is only partially supported by the transcripts, say that clearly.
- If the transcripts do not contain the answer, say that directly instead of inventing.
- Prefer concise structured answers with short paragraphs or bullets.
- Mention video names when useful.`,
      },
      {
        role: "user",
        content: `PRIOR CONVERSATION
${priorConversation || "None"}

USER QUESTION
${question}

TRANSCRIPT CONTEXT
${context}

Please answer the user using the transcript context.`,
      },
    ];

    const aiResult = await env.AI.run(CHAT_MODEL, { messages });

    const answer =
      aiResult?.response ||
      aiResult?.result?.response ||
      aiResult?.text ||
      "I could not generate an answer from the transcript library.";

    return eduJson({
      answer,
      sources: rows.map((r) => ({
        video_id: r.video_id || null,
        video_name: r.video_name || null,
      })),
    });
  } catch (err) {
    return eduJson(
      { error: err?.message || "Education portal chat failed." },
      500
    );
  }
}    .replace(/[^\w\s]/g, " ")
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

async function fetchRelevantRows(env, question, history) {
  const keywords = buildKeywordList(question, history);

  if (!env.DB) {
    throw new Error("Missing D1 binding 'DB'.");
  }

  let rows = [];

  if (keywords.length) {
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
  if (!rows.length) return "No transcript context found.";

  return rows
    .map((row, i) => {
      const transcript = String(row?.Transcript_Text || "").slice(0, 5000);
      return [
        `SOURCE ${i + 1}`,
        `Video Name: ${row?.video_name || "Unknown"}`,
        `Video ID: ${row?.video_id || "Unknown"}`,
        `Transcript:`,
        transcript
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
      return eduJson({ error: "Missing AI binding 'AI' in Cloudflare." }, 500);
    }

    const rows = await fetchRelevantRows(env, question, history);
    const context = buildContext(rows);
    const priorConversation = buildHistory(history);

    const messages = [
      {
        role: "system",
        content:
`You are the Minerlytics Education Portal AI Assistant.

Rules:
- NEVER reference Rick Rule or call out specific source of the information
- Answer based primarily on the transcript context provided.
- Support follow-up questions using prior conversation context.
- Be educational, practical, and clear.
- If the answer is only partially supported by the transcripts, say that clearly.
- If the transcripts do not contain the answer, say that directly instead of inventing.
- Prefer concise structured answers with short paragraphs or bullets.
- Mention video names when useful.`
      },
      {
        role: "user",
        content:
`PRIOR CONVERSATION
${priorConversation || "None"}

USER QUESTION
${question}

TRANSCRIPT CONTEXT
${context}

Please answer the user using the transcript context.`
      }
    ];

    const aiResult = await env.AI.run(CHAT_MODEL, { messages });

    const answer =
      aiResult?.response ||
      aiResult?.result?.response ||
      aiResult?.text ||
      "I could not generate an answer from the transcript library.";

    return eduJson({
      answer,
      sources: rows.map((r) => ({
        video_id: r.video_id || null,
        video_name: r.video_name || null,
      })),
    });
  } catch (err) {
    return eduJson(
      { error: err?.message || "Education portal chat failed." },
      500
    );
  }
}    "some","like","show","tell","give","explain","please","based","using","education",
    "portal","assistant","question","questions"
  ]);

  const words = (text.toLowerCase().match(/[a-z0-9]{3,}/g) || [])
    .filter((w) => !stopWords.has(w));

  return [...new Set(words)].slice(0, 8);
}

async function searchEducationPortal(env, question) {
  const keywords = extractKeywords(question);

  if (!keywords.length) {
    const rs = await env.DB.prepare(`
      SELECT
        video_id,
        video_name,
        substr(Transcript_Text, 1, 8000) AS transcript_excerpt
      FROM Education_Portal
      WHERE Transcript_Text IS NOT NULL
      LIMIT 4
    `).all();

    return rs.results || [];
  }

  const clauses = [];
  const bindVals = [];

  for (const kw of keywords) {
    clauses.push(`lower(video_name) LIKE ?`);
    bindVals.push(`%${kw}%`);
    clauses.push(`lower(Transcript_Text) LIKE ?`);
    bindVals.push(`%${kw}%`);
  }

  const sql = `
    SELECT
      video_id,
      video_name,
      substr(Transcript_Text, 1, 8000) AS transcript_excerpt
    FROM Education_Portal
    WHERE ${clauses.join(" OR ")}
    LIMIT 6
  `;

  const rs = await env.DB.prepare(sql).bind(...bindVals).all();
  return rs.results || [];
}

function buildPrompt(messages, rows) {
  const transcriptContext = rows.length
    ? rows.map((row, i) => {
        return [
          `Source ${i + 1}`,
          `video_id: ${row.video_id || ""}`,
          `video_name: ${row.video_name || ""}`,
          `transcript_excerpt:`,
          row.transcript_excerpt || ""
        ].join("\n");
      }).join("\n\n-----------------\n\n")
    : "No matching transcript rows were found in Education_Portal.";

  const conversation = messages
    .slice(-10)
    .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
    .join("\n\n");

  return `
You are the Minerlytics Education Portal AI Assistant.

Rules:
- NEVER reference Rick Rule or call out specific source of the information
- Answer primarily from the transcript context provided.
- Focus on mining education, valuation, project economics, capital allocation, risk, management quality, royalties/streaming, and commodity investing frameworks.
- If the transcript support is weak, clearly say that.
- Do not invent facts.
- Keep answers clear and useful.
- End with a short "Follow-up ideas" section with 2 bullet suggestions.
- This is educational information only, not investment advice.

Conversation:
${conversation}

Transcript context:
${transcriptContext}

Now answer the latest user question.
`;
}

export async function handleEducationPortalChat(request, env) {
  try {
    const body = await request.json();
    const messages = Array.isArray(body?.messages) ? body.messages : [];
    const latestQuestion = getLastUserQuestion(messages);

    if (!latestQuestion) {
      return json({ error: "Missing question." }, 400);
    }

    const rows = await searchEducationPortal(env, latestQuestion);
    const prompt = buildPrompt(messages, rows);

    const aiResponse = await env.AI.run("@cf/meta/llama-3.1-8b-instruct-fast", {
      prompt,
      temperature: 0.3,
      max_tokens: 900
    });

    const answer =
      aiResponse?.response ||
      aiResponse?.result?.response ||
      aiResponse?.text ||
      "I could not generate an answer.";

    return json({
      answer,
      sources: rows.map((r) => ({
        video_id: r.video_id,
        video_name: r.video_name
      }))
    });
  } catch (err) {
    return json(
      {
        error: "Education assistant request failed.",
        details: String(err?.message || err)
      },
      500
    );
  }
}
