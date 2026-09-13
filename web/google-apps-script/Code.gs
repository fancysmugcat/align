/**
 * ALIGN → Google Sheets
 *
 * Receives daily posture rollups from the ALIGN website and writes them into
 * this spreadsheet. One row per profile per day: re-sending a day corrects the
 * existing row instead of appending a duplicate.
 *
 * Setup (about two minutes):
 *   1. Open the spreadsheet, then Extensions → Apps Script.
 *   2. Replace the contents of Code.gs with this file and Save.
 *   3. Deploy → New deployment → type "Web app".
 *        Execute as:      Me
 *        Who has access:  Anyone
 *      Deploy, approve the permission prompt, and copy the /exec URL.
 *   4. Paste that URL into the website: Settings → Google Sheet → Save.
 *      To set it for every visitor instead, put it in web/js/config.js as
 *      SHEET_WEB_APP_URL and redeploy the site.
 *
 * "Anyone" means anyone holding the URL can post rows. It cannot read the
 * sheet, but treat the URL as a secret; set SHARED_SECRET below and the site
 * will be refused unless it sends the same value.
 */

var SPREADSHEET_ID = '1c_eGhhe6cjcHa3_eNffbmaz8KT7xVE_XTLFEbAm0bzs';

/** Leave empty for no check, or set a string the site must send. */
var SHARED_SECRET = '';

var DAILY_SHEET = 'Daily';
var PROFILE_SHEET = 'Profiles';

var DAILY_HEADERS = [
  'Date', 'Profile', 'Email', 'Profile ID', 'Samples', 'Minutes worn',
  'Avg angle (deg)', 'Good posture %', 'Left %', 'Right %', 'Streak', 'Source', 'Updated',
];

var PROFILE_HEADERS = [
  'Profile ID', 'Name', 'Email', 'First seen', 'Last sync',
  'Days recorded', 'Current streak', 'Best streak', 'Calibrated',
];

function doPost(e) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var payload = JSON.parse(e.postData.contents);

    if (SHARED_SECRET && payload.secret !== SHARED_SECRET) {
      return json({ ok: false, error: 'Bad secret' });
    }
    if (!payload.profile || !payload.profile.id) {
      return json({ ok: false, error: 'Missing profile' });
    }

    var book = SpreadsheetApp.openById(SPREADSHEET_ID);
    var written = writeDaily(book, payload);
    writeProfile(book, payload, written);

    return json({ ok: true, rows: written });
  } catch (error) {
    return json({ ok: false, error: String(error) });
  } finally {
    lock.releaseLock();
  }
}

/** A browser hitting the URL directly gets a readable health check. */
function doGet() {
  return json({ ok: true, service: 'ALIGN sync', sheet: SPREADSHEET_ID });
}

function writeDaily(book, payload) {
  var sheet = sheetWithHeaders(book, DAILY_SHEET, DAILY_HEADERS);
  var days = payload.days || [];
  if (days.length === 0) return 0;

  var profile = payload.profile;
  var now = new Date();

  // Existing rows for this profile, keyed by date, so a resend overwrites.
  var rowByDate = {};
  var lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    var existing = sheet.getRange(2, 1, lastRow - 1, 4).getValues();
    for (var i = 0; i < existing.length; i++) {
      if (existing[i][3] !== profile.id) continue;
      rowByDate[dateKey(existing[i][0])] = i + 2;
    }
  }

  var appended = [];
  for (var d = 0; d < days.length; d++) {
    var day = days[d];
    var row = [
      day.date,
      profile.name || '',
      profile.email || '',
      profile.id,
      day.samples || 0,
      day.minutes || 0,
      day.avgAngle || 0,
      day.goodShare || 0,
      day.leftShare || 0,
      day.rightShare || 0,
      payload.streak || 0,
      (payload.device && payload.device.mode) || '',
      now,
    ];
    var target = rowByDate[day.date];
    if (target) sheet.getRange(target, 1, 1, row.length).setValues([row]);
    else appended.push(row);
  }

  if (appended.length > 0) {
    sheet.getRange(sheet.getLastRow() + 1, 1, appended.length, DAILY_HEADERS.length)
      .setValues(appended);
  }

  formatDaily(sheet);
  return days.length;
}

function writeProfile(book, payload, daysWritten) {
  var sheet = sheetWithHeaders(book, PROFILE_SHEET, PROFILE_HEADERS);
  var profile = payload.profile;

  var row = [
    profile.id,
    profile.name || '',
    profile.email || '',
    profile.createdAt ? new Date(profile.createdAt) : '',
    new Date(),
    daysWritten,
    payload.streak || 0,
    payload.longestStreak || 0,
    payload.calibratedAt ? new Date(payload.calibratedAt) : '',
  ];

  var lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    var ids = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
    for (var i = 0; i < ids.length; i++) {
      if (ids[i][0] === profile.id) {
        // Keep the original first-seen date rather than trusting the client.
        row[3] = sheet.getRange(i + 2, 4).getValue() || row[3];
        sheet.getRange(i + 2, 1, 1, row.length).setValues([row]);
        return;
      }
    }
  }
  sheet.appendRow(row);
}

function sheetWithHeaders(book, name, headers) {
  var sheet = book.getSheetByName(name);
  if (!sheet) sheet = book.insertSheet(name);

  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers])
      .setFontWeight('bold')
      .setBackground('#CDE6D5')
      .setFontColor('#1B6B37');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function formatDaily(sheet) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return;
  var rows = lastRow - 1;
  sheet.getRange(2, 7, rows, 1).setNumberFormat('0.0');       // avg angle
  sheet.getRange(2, 8, rows, 3).setNumberFormat('0.0%');       // good / left / right
  sheet.getRange(2, 13, rows, 1).setNumberFormat('yyyy-mm-dd hh:mm');
  sheet.sort(1, false);
}

function dateKey(value) {
  if (value instanceof Date) return Utilities.formatDate(value, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  return String(value);
}

function json(payload) {
  return ContentService.createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}
