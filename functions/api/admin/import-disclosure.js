export async function onRequestPost(context) {
  const { request, env } = context;

  const auth = request.headers.get("x-import-key");
  if (auth !== env.IMPORT_KEY) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }

  const payload = await request.json();

  const {
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
  } = payload;

  if (!ticker || !accessionNumber) {
    return new Response(JSON.stringify({ error: "Missing required fields" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  // Upsert report
  await env.DB.prepare(`
    INSERT INTO mining_reports (
      ticker, cik, accession_number, form, filing_date, report_date,
      primary_document, source_url, extracted_at
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
  `).bind(
    ticker,
    cik || null,
    accessionNumber,
    form || null,
    filingDate || null,
    reportDate || null,
    primaryDocument || null,
    url || null,
    extractedAt || null
  ).run();

  const reportRow = await env.DB.prepare(`
    SELECT id FROM mining_reports WHERE accession_number = ?
  `).bind(accessionNumber).first();

  const reportId = reportRow.id;

  // Replace blocks for latest version
  await env.DB.prepare(`
    DELETE FROM mining_report_blocks WHERE report_id = ?
  `).bind(reportId).run();

  for (let i = 0; i < textBlocks.length; i++) {
    const block = textBlocks[i];
    await env.DB.prepare(`
      INSERT INTO mining_report_blocks (
        report_id, block_index, heading, text_content
      )
      VALUES (?, ?, ?, ?)
    `).bind(
      reportId,
      i,
      block?.heading || null,
      block?.text || ""
    ).run();
  }

  return new Response(JSON.stringify({
    ok: true,
    accessionNumber,
    blocksInserted: textBlocks.length
  }), {
    headers: { "content-type": "application/json" }
  });
}
