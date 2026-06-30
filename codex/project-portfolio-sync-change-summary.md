# Website Project Portfolio Sync

## Change Summary

- Added `scripts/sync_website_project_portfolio.py` to extract project, property, mine, operation, and portfolio details from company websites using the miner universe in `src/tickers.js`.
- The script accepts homepage results from `scripts/sync_company_homepages.py`, discovers known and likely project pages, extracts normalized project rows, and emits Cloudflare D1 SQL.
- Added `d1_website_project_portfolio.sql` to create the D1 table for project names, descriptions, ownership, location, status, mining style, mineral resource text, geology text, technical report references, evidence, confidence, and extraction status.
- Added `.github/workflows/sync-website-project-portfolio.yml` so GitHub Actions can run the homepage sync and project-portfolio sync for all tickers or a manually selected subset, then load both outputs to Cloudflare D1.

## Intended Behavior

The workflow keeps website-derived project and property portfolio data aligned with the ticker universe in `src/tickers.js`. It first refreshes company homepage URLs, then uses those URLs plus curated project paths and portfolio-page discovery to load project records into D1.

## Operational Notes

- Manual runs can pass comma-separated symbols, for example `IAUX,PZG,WPM`.
- Scheduled runs execute daily.
- Cloudflare writes require `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` GitHub secrets.
- The target D1 database is `minerlytics-dev`, matching the existing Wrangler configuration.
