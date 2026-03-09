export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const auth = request.headers.get("x-import-key");

    if (!auth) {
      return json({ error: "Missing x-import-key header" }, 403);
    }

    if (!env.IMPORT_KEY) {
      return json({ error: "IMPORT_KEY missing in Cloudflare env" }, 403);
    }

    if (auth !== env.IMPORT_KEY) {
      return json({ error: "Key mismatch" }, 403);
    }

    if (!env.DB) {
      return json({ error: "DB binding missing" }, 500);
    }

    const payload = await request.json();

    let {
      ticker,
      cik,
      accessionNumber,
      form,
      filingDate,
      reportDate,
      primaryDocument,
      url,
      extractedAt,
      textBlocks = [],
    } = payload || {};

    if (!ticker || !accessionNumber) {
      return json(
        {
          error: "Missing required fields",
          gotTicker: !!ticker,
          gotAccessionNumber: !!accessionNumber,
        },
        400
      );
    }

    if (!Array.isArray(textBlocks)) {
      textBlocks = [];
    }

    await env.DB.prepare(`
      INSERT INTO mining_reports (
        ticker,
        cik,
        accession_number,
        form,
        filing_date,
        report_date,
        primary_document,
        source_url,
        extracted_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(accession_number) DO UPDATE SET
        ticker = excluded.ticker,
        cik = excluded.cik,
        form = excluded.form,
        filing_date = excluded.filing_date,
        report_date = excluded.report_date,
        primary_document = excluded.primary_document,
        source_url = excluded.source_url,
        extracted_at = excluded.extracted_at
    `)
      .bind(
        ticker,
        cik || null,
        accessionNumber,
        form || null,
        filingDate || null,
        reportDate || null,
        primaryDocument || null,
        url || null,
        extractedAt || null
      )
      .run();

    const reportRow = await env.DB.prepare(`
      SELECT id
      FROM mining_reports
      WHERE accession_number = ?
    `)
      .bind(accessionNumber)
      .first();

    if (!reportRow?.id) {
      return json({ error: "Could not fetch inserted report id" }, 500);
    }

    const reportId = reportRow.id;

    await env.DB.prepare(`
      DELETE FROM mining_report_blocks
      WHERE report_id = ?
    `)
      .bind(reportId)
      .run();

    let insertedBlocks = 0;
    let skippedBlocks = 0;

    for (let i = 0; i < textBlocks.length; i++) {
      const block = textBlocks[i];

      if (!block || typeof block !== "object") {
        skippedBlocks++;
        continue;
      }

      const heading =
        typeof block.heading === "string" && block.heading.trim()
          ? block.heading.trim()
          : null;

      const text =
        typeof block.text === "string" ? block.text.trim() : "";

      if (!text) {
        skippedBlocks++;
        continue;
      }

      await env.DB.prepare(`
        INSERT INTO mining_report_blocks (
          report_id,
          block_index,
          heading,
          text_content
        )
        VALUES (?, ?, ?, ?)
      `)
        .bind(reportId, i, heading, text)
        .run();

      insertedBlocks++;
    }

    return json({
      ok: true,
      accessionNumber,
      reportId,
      blocksReceived: textBlocks.length,
      blocksInserted: insertedBlocks,
      blocksSkipped: skippedBlocks,
    });
  } catch (err) {
    return json(
      {
        error: "Unhandled import error",
        message: err instanceof Error ? err.message : String(err),
      },
      500
    );
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
    },
  });
}
