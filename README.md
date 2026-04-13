# Mila Nartana Fee Tracker

Mobile-first React app for tracking monthly student fees with Google Sheets as the backend source of truth.

## What the app includes

- Dashboard with:
  - month selector
  - unified fee summary tile (expected, collected, pending, cash, online)
  - payment mode donut share for a selected month range
- Students tab with filters:
  - month
  - search
  - location
  - payment status (`Paid`, `Partial`, `Pending`)
  - payment mode (`Cash`, `Online`, `Mixed`, `Pending`, `None`)
- Bulk Add Payment flow
- Student profile edit flow
- Reminder queue and WhatsApp deep links
- Lightweight passcode auth gate for deployment

## Local run

1. Install Node.js 18+.
2. Install dependencies:
   - `npm install`
3. Copy env template:
   - `cp .env.example .env` (or create `.env` manually on Windows)
4. Set local env values:
   - `VITE_SHEETS_WEB_APP_URL`
   - `VITE_SHEETS_WRITE_TOKEN`
5. Start app:
   - `npm run dev`
6. For mobile testing on same Wi-Fi:
   - `npm run dev -- --host`

## Environment variables

### Local development (`.env`)

- `VITE_SHEETS_WEB_APP_URL`: Apps Script Web App URL
- `VITE_SHEETS_WRITE_TOKEN`: write token passed through Vite proxy in dev mode

### Vercel server env vars

- `SHEETS_WEB_APP_URL`
- `SHEETS_WRITE_TOKEN`
- `PASSCODE_HASH`
- `AUTH_COOKIE_SECRET`
- `AUTH_SESSION_DAYS` (recommended: `7`)
- `AUTH_MAX_ATTEMPTS` (recommended: `5`)
- `AUTH_LOCKOUT_MINUTES` (recommended: `15`)

## Data + backend architecture

- Frontend starts with local sample data from:
  - `src/data/mockData.js`
- It then hydrates from Google Sheets via:
  - local dev: Vite proxy -> Apps Script
  - production: `/api/sheets` Vercel function -> Apps Script
- Latest fetched dataset is cached in browser localStorage (`mnft.sheets_cache_v1`) for faster reload/fallback.

Main backend script used in Google Apps Script:
- `google-apps-script/fee-tracker-api.gs`

Expected Google Sheet tabs:
- `Students`
- `MonthlyFees`
- `Settings`

## Debug mode

Debug panel is hidden by default.

- Open app with URL query parameter:
  - `?debug=true`
- Example:
  - `http://localhost:5173/?debug=true`

Debug panel shows:
- endpoint configured state
- token configured state (or server-managed)
- endpoint mode (`vite-proxy` or `vercel-server-proxy`)
- last request action/status/error
- current UI load error (if any)

## Real Sheets setup

1. Create Google Sheet with tabs:
   - `Students`, `MonthlyFees`, `Settings`
2. Paste sample CSV data from:
   - `data/samples/Students.sample.csv`
   - `data/samples/MonthlyFees.sample.csv`
   - `data/samples/Settings.sample.csv`
3. Add Apps Script from:
   - `google-apps-script/fee-tracker-api.gs`
4. Set Script Property:
   - `APP_ADMIN_TOKEN` (must match app token)
5. Deploy as Web App:
   - Execute as: `Me`
   - Access: as required for your usage model

## Auth model (lightweight)

- App uses passcode-based session auth in Vercel API routes:
  - `/api/auth/login`
  - `/api/auth/session`
  - `/api/auth/logout`
- `/api/sheets` is blocked without valid session cookie.
- Session cookie is signed with `AUTH_COOKIE_SECRET`.
- Failed passcode attempts are lockout-protected.

## Sample data scripts

- Rebuild local samples + mock data from local CSV pipeline:
  - `npm run rebuild:samples`
- Sync samples from live Google Sheets response:
  - `npm run sync:samples:weekly`

## Weekly sample sync automation

Workflow file:
- `.github/workflows/weekly-sample-sync.yml`

Behavior:
- Runs weekly (Sunday 2:00 AM PT target, DST-safe guard)
- Supports manual trigger (`workflow_dispatch`)
- Pulls live data using repo secrets:
  - `SHEETS_WEB_APP_URL`
  - `SHEETS_WRITE_TOKEN`
- Regenerates:
  - `data/samples/Students.sample.csv`
  - `data/samples/MonthlyFees.sample.csv`
  - `data/samples/Settings.sample.csv`
  - `src/data/mockData.js`
- Creates/updates PR branch:
  - `chore/weekly-sample-sync`
- PR body includes sync summary (counts + month range + status mix)

## Troubleshooting

If app shows stale/local data:
- restart dev server after `.env` changes
- confirm Apps Script deployment URL is correct
- test Apps Script endpoint directly
- hard refresh browser or clear site data

If Vercel says missing auth envs:
- confirm `PASSCODE_HASH` and `AUTH_COOKIE_SECRET` are set
- redeploy after env update

If local build shows `spawn EPERM`:
- this is environment/process permission related on Windows shell context, not app logic.
