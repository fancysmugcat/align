/**
 * ALIGN — receives posture data from the website and writes it into this
 * spreadsheet.
 *
 * A browser cannot write to Sheets directly, so the site posts JSON here and
 * this runs as you, with permission to edit the sheet it is bound to.
 *
 * ── Installing ───────────────────────────────────────────────────────────
 *  1. Open the spreadsheet → Extensions → Apps Script.
 *  2. Replace everything in Code.gs with this file, and Save.
 *  3. Deploy → New deployment → Web app.
 *       Execute as:      Me
 *       Who has access:  Anyone
 *  4. Copy the /exec URL and put it in web/js/config.js as SHEET_WEB_APP_URL.
 *
 * Step 3's "Anyone" is what lets a phone post without a Google login.
 *
 * The URL is in the site's own JavaScript, which every visitor is served, so
 * treat it as public — a private repository would not change that. Someone who
 * reads it can add rows; nobody can read anything back, because this only ever
 * replies with a status. If it is abused, delete the deployment and make a new
 * one: a minute's work and a fresh URL.
 *
 * Re-deploy (Manage deployments → edit → New version) after any change here,
 * or the old code keeps serving.
 */

/** One row per reading: who, when, how far off, and the traffic light. */
var READINGS_SHEET = 'Readings';
var READINGS_HEADER = ['User', 'Date', 'Time', 'Angle (°)', 'Quality'];

/** One row per wearer per day, for totals rather than moments. */
var DAILY_SHEET = 'Daily';
var DAILY_HEADER = [
  'User', 'Date', 'Samples', 'Minutes worn', 'Average angle (°)',
  'Good posture', 'Left share', 'Right share', 'Updated',
];

var QUALITY_COLOURS = {
  green: '#D9EAD3',
  yellow: '#FFF2CC',
  red: '#F4CCCC',
};

/**
 * Must match SHEET_TOKEN in web/js/config.js.
 *
 * Not a secret — it ships in the site's own JavaScript, so anyone reading the
 * URL reads this too. It turns away the traffic that posts to any endpoint it
 * finds, which is most of what an exposed URL attracts, and nothing more. The
 * real remedy for abuse is a new deployment.
 */
var TOKEN = 'align-band';

/** A sane ceiling, so one request cannot be used to fill the sheet. */
var MAX_ROWS_PER_REQUEST = 3000;

function doPost(e) {
  try {
    var payload = JSON.parse(e.postData.contents);
    if (payload.token !== TOKEN) return json({ ok: false, error: 'bad token' });

    var name = (payload.profile && payload.profile.name) || 'Unknown';
    if (String(name).length > 60) return json({ ok: false, error: 'bad name' });

    var written = writeReadings(name, payload.readings || []);
    written += writeDaily(name, payload.days || []);

    return json({ ok: true, rows: written });
  } catch (error) {
    return json({ ok: false, error: String(error) });
  }
}

/** Lets you check the deployment is alive by opening the URL in a browser. */
function doGet() {
  return json({ ok: true, message: 'ALIGN sheet endpoint is running.' });
}

/**
 * Appends readings, skipping any already present.
 *
 * The site only sends what is new, but a sync that writes and then fails to
 * report back would be retried — so the timestamp of each row is remembered in
 * a hidden column and used to drop repeats. Without it a dropped response
 * would duplicate every reading it was carrying.
 */
function writeReadings(name, readings) {
  if (!readings.length) return 0;
  if (readings.length > MAX_ROWS_PER_REQUEST) {
    readings = readings.slice(0, MAX_ROWS_PER_REQUEST);
  }

  var sheet = sheetWithHeader(READINGS_SHEET, READINGS_HEADER);
  var keyColumn = READINGS_HEADER.length + 1;   // just past the visible columns

  var seen = {};
  var lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    var keys = sheet.getRange(2, keyColumn, lastRow - 1, 1).getValues();
    for (var i = 0; i < keys.length; i++) {
      if (keys[i][0]) seen[keys[i][0]] = true;
    }
  }

  var rows = [];
  var keyRows = [];
  var colours = [];
  for (var j = 0; j < readings.length; j++) {
    var reading = readings[j];
    var key = name + '|' + reading.at;
    if (seen[key]) continue;
    seen[key] = true;

    // Only the three known verdicts are written, so the Quality column cannot
    // be turned into free text by a malformed post.
    var quality = QUALITY_COLOURS[reading.quality] ? reading.quality : '';
    rows.push([name, reading.date, reading.time, Number(reading.angle) || 0, quality]);
    keyRows.push([key]);
    colours.push([QUALITY_COLOURS[quality] || '#FFFFFF']);
  }
  if (!rows.length) return 0;

  var start = sheet.getLastRow() + 1;
  sheet.getRange(start, 1, rows.length, READINGS_HEADER.length).setValues(rows);
  sheet.getRange(start, keyColumn, keyRows.length, 1).setValues(keyRows);

  // Colour the quality cell itself, so the sheet reads at a glance rather than
  // needing the word to be parsed.
  sheet.getRange(start, 5, colours.length, 1).setBackgrounds(colours);

  sheet.hideColumns(keyColumn);
  return rows.length;
}

/** Upserts one row per wearer per day, keyed on (user, date). */
function writeDaily(name, days) {
  if (!days.length) return 0;

  var sheet = sheetWithHeader(DAILY_SHEET, DAILY_HEADER);
  var lastRow = sheet.getLastRow();
  var existing = lastRow > 1 ? sheet.getRange(2, 1, lastRow - 1, 2).getValues() : [];

  var rowFor = {};
  for (var i = 0; i < existing.length; i++) {
    rowFor[existing[i][0] + '|' + asDateString(existing[i][1])] = i + 2;
  }

  var written = 0;
  for (var j = 0; j < days.length; j++) {
    var day = days[j];
    var row = [
      name, day.date, day.samples, day.minutes, day.avgAngle,
      day.goodShare, day.leftShare, day.rightShare, new Date(),
    ];
    var at = rowFor[name + '|' + day.date];
    if (at) {
      sheet.getRange(at, 1, 1, DAILY_HEADER.length).setValues([row]);
    } else {
      sheet.appendRow(row);
    }
    written++;
  }
  return written;
}

function sheetWithHeader(title, header) {
  var book = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = book.getSheetByName(title);
  if (!sheet) sheet = book.insertSheet(title);

  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

/** Dates come back from Sheets as Date objects, but go in as strings. */
function asDateString(value) {
  if (value instanceof Date) {
    return Utilities.formatDate(value, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }
  return String(value);
}

function json(body) {
  return ContentService
    .createTextOutput(JSON.stringify(body))
    .setMimeType(ContentService.MimeType.JSON);
}
