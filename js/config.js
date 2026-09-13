/**
 * Deployment settings.
 *
 * ── The one line you have to fill in ──────────────────────────────────────
 *
 * `SHEET_WEB_APP_URL` is where measurements are posted. It is NOT the
 * spreadsheet's URL — a spreadsheet can't receive data. It is the address of
 * the Apps Script deployed onto that spreadsheet, and it always looks like:
 *
 *     https://script.google.com/macros/s/AKfycb…/exec
 *
 * To get it: open the spreadsheet → Extensions → Apps Script → paste in
 * `google-apps-script/Code.gs` → Deploy → New deployment → Web app
 * (Execute as **Me**, Who has access **Anyone**) → copy the /exec URL and put
 * it below. Only you can do this step; it runs under your Google account.
 *
 * Until it is filled in, nothing is uploaded anywhere. Once it is, every
 * wearer's daily figures go up on their own, with nothing to configure in the
 * app.
 */
export const SHEET_WEB_APP_URL = '';

/** The spreadsheet the Apps Script writes into — linked from Settings. */
export const SHEET_URL = 'https://docs.google.com/spreadsheets/d/1c_eGhhe6cjcHa3_eNffbmaz8KT7xVE_XTLFEbAm0bzs/edit';

/** How often a signed-in profile pushes new readings up, in minutes. */
export const SYNC_INTERVAL_MINUTES = 5;

/** How many days of rollups each sync carries. Re-sent days overwrite in place. */
export const SYNC_WINDOW_DAYS = 14;
