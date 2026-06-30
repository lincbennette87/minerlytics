# Management Team Website Sync

## Change Summary

- Added `scripts/sync_website_management_team.py` to extract management team profiles from company websites using the miner universe in `src/tickers.js`.
- The script accepts homepage results from `scripts/sync_company_homepages.py`, discovers likely management or leadership pages, extracts profile-level rows, and emits Cloudflare D1 upsert SQL.
- Added `d1_website_management_team.sql` to create the D1 table used to store extracted management profiles, biographies, source URLs, evidence text, confidence scores, and extraction status rows.
- Added `.github/workflows/sync-website-management-team.yml` so GitHub Actions can run the homepage sync and management-team sync for all tickers or a manually selected subset, then load both outputs to Cloudflare D1.

## Intended Behavior

The workflow keeps website-derived management profile data aligned with the ticker universe in `src/tickers.js`. It first refreshes company homepage URLs, then uses those URLs plus curated leadership-page patterns to find management pages and store normalized profile records in D1.

## Operational Notes

- Manual runs can pass comma-separated symbols, for example `AEM,WPM,PZG`.
- Scheduled runs execute daily.
- Cloudflare writes require `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` GitHub secrets.
- The target D1 database is `minerlytics-dev`, matching the existing Wrangler configuration.
