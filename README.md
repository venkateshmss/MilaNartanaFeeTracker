# Mila Nartana Fee Tracker

Simple mobile-first React demo for tracking month-wise dance class fee payments, pending dues, and WhatsApp reminder links.

## Run

1. Install Node.js 18+.
2. Run `npm install`.
3. Copy `.env.example` to `.env`.
4. Set `VITE_SHEETS_WEB_APP_URL` and `VITE_SHEETS_WRITE_TOKEN` in `.env` for local dev.
5. Run `npm run dev`.
6. For phone testing on same Wi-Fi, run `npm run dev -- --host`.
7. Open `http://<your-laptop-local-ip>:5173` in your mobile browser.

## Demo scope

- Dashboard with month filter and paid/pending/partial summary
- Student status screen with search and location filter
- Payment entry form aligned to the Google Sheets row design
- Reminder queue with month-wise due breakdown and WhatsApp deep links

## Google Sheets path

- `src/data/mockData.js` mirrors the proposed `Students`, `MonthlyFees`, and `Settings` sheets.
- `src/utils/feeTracker.js` contains the reusable month filtering, summary, grouping, and reminder helpers.
- Replace the mock arrays in `src/App.jsx` with Sheet fetch/write logic when ready.
- Integration scaffold is in `src/services/googleSheetsService.js`.
- Import-ready sample files are in `sample-data/`.

## Real Sheets hookup (recommended)

1. Create a Google Sheet with tabs: `Students`, `MonthlyFees`, `Settings`.
2. Copy data from the CSVs in `sample-data/` into those tabs.
3. Create a Google Apps Script attached to that sheet and deploy it as a Web App.
4. Implement `doPost` actions: `fetchAll`, `updateStudentStatus`, `addMonthlyFeeRow`.
   A starter script is available at `sample-data/apps-script-example.gs`.
5. Deploy Apps Script as Web App:
   - Execute as: Me
   - Who has access: Anyone with the link (or your Google Workspace users)
6. Local dev uses a Vite proxy (`/apps-script`) and sends token from `.env`.
7. For Vercel production, use server-side env vars (not `VITE_*`):
   - `SHEETS_WEB_APP_URL`
   - `SHEETS_WRITE_TOKEN`
8. In production, frontend calls `/api/sheets` so token is never exposed in browser bundle.
9. Restart `npm run dev` after `.env` changes.

## Access Security (Vercel)

This app supports a lightweight passcode gate without OAuth.

1. Add Vercel server env vars:
   - `SHEETS_WEB_APP_URL`
   - `SHEETS_WRITE_TOKEN`
   - `PASSCODE_HASH`
   - `AUTH_COOKIE_SECRET`
   - `AUTH_SESSION_DAYS=7`
   - `AUTH_MAX_ATTEMPTS=5`
   - `AUTH_LOCKOUT_MINUTES=15`
2. Generate a passcode hash locally:
   - `npm run generate:passcode-hash`
   - Copy output into `PASSCODE_HASH`.
3. Redeploy Vercel.
4. App behavior:
   - Unauthenticated users are redirected to `/login`.
   - `/api/sheets` is blocked unless session cookie is valid.
   - 5 failed attempts trigger a temporary lockout.

## Troubleshooting `Failed to fetch`

1. Confirm `.env` is in project root (not inside `sample-data`).
2. Restart dev server after changing `.env`.
3. In Apps Script, deploy a **new version** after edits.
4. Verify Web App access is `Anyone with the link` (or org equivalent).
5. Open this URL in browser to validate deployment:
   `https://script.google.com/macros/s/<DEPLOYMENT_ID>/exec?action=fetchAll`
6. If browser URL works but app fails, hard refresh and retry.
