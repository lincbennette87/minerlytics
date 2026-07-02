# Website About Us Sync

## Change Summary

- Added `scripts/sync_website_about_us.py` to extract company About Us / overview text from miner websites using the ticker universe in `src/tickers.js`.
- Updated `scripts/sync_company_homepages.py` so the existing `--tickers-js src/tickers.js` argument now actually builds homepage rows from the GitHub ticker universe instead of only accepting the argument for compatibility.
- The script accepts homepage results from `scripts/sync_company_homepages.py`, tries direct About-page discovery first, then falls back to resilient structured-data, semantic HTML, and context-window extraction.
- Added `d1_website_about_us.sql` to create D1 tables for the selected About Us row per ticker and detailed extraction evidence rows.
- Added `.github/workflows/sync-website-about-us.yml` so GitHub Actions can refresh homepage URLs, run the About Us extractor, and load results to Cloudflare D1.

## Intended Behavior

The workflow keeps website-derived company overview text aligned with the Minerlytics ticker universe in `src/tickers.js`. It stores source URLs, page titles, extraction methods, evidence text, confidence scores, and status rows so the UI can show company summaries while retaining extraction traceability.

## Operational Notes

- Manual runs can pass comma-separated symbols, for example `IAUX,PZG,AEM`.
- Scheduled runs execute daily.
- Cloudflare writes require `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` GitHub secrets.
- The target D1 database is `minerlytics-dev`, matching the existing website sync workflows.
