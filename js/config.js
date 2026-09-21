/**
 * Deployment settings.
 *
 * ── A note on the endpoint below ──────────────────────────────────────────
 *
 * It is public, and unavoidably so: this site is served to anyone who visits,
 * so whatever it knows, they know. Keeping the repository private would not
 * change that — the JavaScript is published either way.
 *
 * What that costs: someone who reads this file can post rows into the sheet.
 * What it does not cost: they cannot read anything back. The script replies
 * with a status and nothing else, so the data only ever travels one way.
 *
 * If it is ever abused, delete the deployment in Apps Script and create a new
 * one. That takes a minute and issues a fresh URL to paste in here.
 *
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
export const SHEET_WEB_APP_URL =
  'https://script.google.com/macros/s/AKfycbx4-ZuTWJjbVK5oACD0DyvvCoKuYOfOPPuDMIdkjOyBBPE3W3z4MtqQWHUxZolDc1yt/exec';

/**
 * A word the Apps Script checks before writing anything.
 *
 * Not a secret — it is in the same public file as the URL, and anyone reading
 * one reads the other. It only stops the drive-by traffic that posts to any
 * endpoint it finds, which is most of it. A person who reads this file can
 * still add rows, and the only real answer to that is to delete the Apps
 * Script deployment and make a new one, which takes a minute and changes the
 * URL.
 */
export const SHEET_TOKEN = 'align-band';

/** The spreadsheet the Apps Script writes into — linked from Settings. */
export const SHEET_URL = 'https://docs.google.com/spreadsheets/d/1uoke7yfkuou37s75tvZF1xvu19eIY8lukysSukW_YSk/edit';

/** How often a signed-in profile pushes new readings up, in minutes. */
export const SYNC_INTERVAL_MINUTES = 5;

/** How many days of rollups each sync carries. Re-sent days overwrite in place. */
export const SYNC_WINDOW_DAYS = 14;
