function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "POST,OPTIONS",
      "access-control-allow-headers": "content-type,x-api-key"
    }
  });
}

export function educationOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "POST,OPTIONS",
      "access-control-allow-headers": "content-type,x-api-key"
    }
  });
}

function getLastUserQuestion(messages = []) {
  const reversed = [...messages].reverse();
  const found = reversed.find(
    (m) => m && m.role === "user" && typeof m.content === "string"
  );
  return found ? found.content.trim() : "";
}

function extractKeywords(text) {
  const stopWords = new Set([
    "what","which","when","where","why","how","this","that","with","from","have","does",
    "about","into","than","then","them","they","will","would","could","should","your",
    "their","there","these","those","were","been","being","more","most","very","much",
    "some","like","show","tell","give","explain","please","based","using","education",
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
