import { h } from './components.js';
import { openSheet } from './sheet.js';
import { listProfiles } from '../stores/profile.js';
import { loadSamples } from '../stores/storage.js';
import { qualityLabel } from '../models.js';
import { tableToPDF, QUALITY_COLOURS } from '../pdf.js';
import { isIOS } from '../device.js';

/**
 * Every reading this device has recorded, for every wearer, behind a password.
 *
 * ── What this is and is not ──────────────────────────────────────────────
 *
 * It reads the same store the charts do, so it is the whole history rather
 * than a copy that can drift. It is *this device's* history: the site is a
 * static page with nowhere to put a shared database, so a second phone keeps
 * its own records and neither can see the other's. Export is how data moves
 * between them.
 *
 * The password keeps the table off the screen of whoever picks the phone up.
 * It cannot do more than that: the check runs in the browser, so anyone
 * willing to read this file can bypass it. Real protection would need a
 * server to hold the data and decide who sees it, which this project does not
 * have. It is a lock on a drawer, not on a vault — enough for the case it is
 * actually for, and worth being honest about for the case it is not.
 */

/**
 * SHA-256 of the passphrase.
 *
 * Hashed rather than written in plainly so the password is not simply
 * readable in the page source — which would make the gate pointless the
 * moment anyone looked.
 */
const PASSWORD_HASH = '30d58acecfaf5a4609e0ff302a91982ee3ba790e1449290f4d983763c0d86655';

/** Rows are heavy; this many at a time keeps the table usable on a phone. */
const PAGE_SIZE = 200;

export function openRecords() {
  const body = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '14px' } });
  const sheet = openSheet({ title: 'Records', closeLabel: 'Close', body });

  showPasswordPrompt(body);
  return sheet;
}

function showPasswordPrompt(body) {
  const field = h('input', {
    type: 'password', class: 'field', placeholder: 'Password',
    'aria-label': 'Records password', autocomplete: 'current-password',
  });
  const problem = h('p', { class: 'hint hint--warn' });

  async function attempt() {
    problem.textContent = '';
    if (await matches(field.value)) {
      body.replaceChildren();
      await showRecords(body);
      return;
    }
    problem.textContent = 'Wrong password.';
    field.value = '';
    field.focus();
  }

  field.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') attempt();
  });

  body.replaceChildren(
    h('p', { class: 'section-detail', text: 'Everything this device has recorded, for every wearer.' }),
    h('div', { class: 'endpoint-row' }, [
      field,
      h('button', { type: 'button', class: 'pill-button', text: 'Open', onClick: attempt }),
    ]),
    problem,
  );
  field.focus();
}

/**
 * Compared as a hash so the password is not sitting in the source in plain
 * sight. The check still happens in the browser, so this raises the effort
 * required rather than making it impossible.
 */
async function matches(entered) {
  try {
    const bytes = new TextEncoder().encode(String(entered ?? ''));
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const hex = [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
    return hex === PASSWORD_HASH;
  } catch {
    return false;
  }
}

async function showRecords(body) {
  const loading = h('p', { class: 'hint', text: 'Reading records…' });
  body.replaceChildren(loading);

  const rows = await collectRows();
  if (rows.length === 0) {
    body.replaceChildren(h('p', {
      class: 'empty-note',
      text: 'Nothing recorded on this device yet. Readings are stored once a wearer has calibrated and worn the band.',
    }));
    return;
  }

  let shown = PAGE_SIZE;
  const table = h('div', { class: 'records-table' });
  const more = h('button', { type: 'button', class: 'pill-button pill-button--ghost' });

  function draw() {
    // Newest first: the recent end is the one anyone opening this is after.
    const page = rows.slice(0, shown);
    table.replaceChildren(
      h('div', { class: 'records-row records-row--head' }, [
        h('span', { text: 'User' }), h('span', { text: 'Date' }),
        h('span', { text: 'Time' }), h('span', { text: 'Angle' }),
        h('span', { text: 'Quality' }),
      ]),
      ...page.map((row) => h('div', { class: 'records-row' }, [
        h('span', { text: row.user }),
        h('span', { text: row.date }),
        h('span', { text: row.time }),
        h('span', { text: `${row.angle}°` }),
        h('span', { class: `records-quality records-quality--${row.quality}`, text: row.quality }),
      ])),
    );
    more.textContent = shown >= rows.length
      ? `All ${rows.length} rows shown`
      : `Show ${Math.min(PAGE_SIZE, rows.length - shown)} more of ${rows.length}`;
    more.disabled = shown >= rows.length;
  }

  more.addEventListener('click', () => { shown += PAGE_SIZE; draw(); });
  draw();

  // Where an export reports what became of it. Blank until one is tried.
  const outcome = h('div', { class: 'export-note' });
  const say = (message, link = null) => {
    outcome.replaceChildren(
      h('p', { class: 'hint', text: message }),
      ...(link ? [link] : []),
    );
  };

  body.replaceChildren(
    h('p', { class: 'section-detail', text: `${rows.length} readings from ${countUsers(rows)} wearer${countUsers(rows) === 1 ? '' : 's'}, newest first.` }),
    h('div', { class: 'button-pair' }, [
      h('button', {
        type: 'button', class: 'pill-button', text: 'Download CSV',
        onClick: () => downloadCSV(rows, say),
      }),
      h('button', {
        type: 'button', class: 'pill-button pill-button--ghost', text: 'Download PDF',
        onClick: () => downloadPDF(rows, say),
      }),
    ]),
    outcome,
    h('p', {
      class: 'hint',
      text: isIOS()
        ? 'These are this device’s records. CSV opens in a spreadsheet; the PDF is the one to hand to somebody. On iPhone an export goes through the share sheet — choose “Save to Files”.'
        : 'These are this device’s records. Another phone keeps its own — the site has no server to share them through, so an export is how they travel. CSV opens in a spreadsheet; the PDF is the one to hand to somebody.',
    }),
    table,
    more,
  );
}

/** Every wearer's samples, flattened and sorted newest first. */
async function collectRows() {
  const profiles = listProfiles();
  const rows = [];

  for (const profile of profiles) {
    const samples = await loadSamples(profile.id);
    for (const sample of samples) {
      rows.push({
        user: profile.name,
        at: sample.date.getTime(),
        date: isoDate(sample.date),
        time: clockTime(sample.date),
        angle: Math.round(sample.angle * 10) / 10,
        quality: qualityLabel(sample.angle),
      });
    }
  }

  rows.sort((a, b) => b.at - a.at);
  return rows;
}

function countUsers(rows) {
  return new Set(rows.map((row) => row.user)).size;
}

function downloadCSV(rows, say) {
  const escape = (value) => {
    const text = String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const lines = [
    ['User', 'Date', 'Time', 'Angle', 'Quality'].join(','),
    ...rows.map((row) => [row.user, row.date, row.time, row.angle, row.quality].map(escape).join(',')),
  ];

  return deliver(
    new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' }),
    `align-records-${isoDate(new Date())}.csv`,
    say,
  );
}

/**
 * The same table, laid out for paper.
 *
 * CSV is the export for a spreadsheet; this is the one for a person. The angle
 * column is right-aligned because a column of numbers is unreadable otherwise,
 * and the quality column keeps its colour so the printout can be skimmed the
 * way the screen is.
 */
function downloadPDF(rows, say) {
  const wearers = countUsers(rows);
  const span = rows.length > 0
    ? `${rows[rows.length - 1].date} to ${rows[0].date}`
    : 'no readings';

  const blob = tableToPDF({
    title: 'ALIGN posture records',
    subtitle: `${rows.length} reading${rows.length === 1 ? '' : 's'} from `
      + `${wearers} wearer${wearers === 1 ? '' : 's'}, ${span}. `
      + `Exported ${isoDate(new Date())} at ${clockTime(new Date())}, newest first.`,
    footnote: 'Recorded on one device. Angles are degrees off that wearer\u2019s calibrated upright.',
    columns: [
      { label: 'Wearer', width: 150 },
      { label: 'Date', width: 90 },
      { label: 'Time', width: 80 },
      { label: 'Angle', width: 65, align: 'right' },
      { label: 'Quality', width: 90 },
    ],
    rows: rows.map((row) => [
      row.user, row.date, row.time, `${row.angle.toFixed(1)}\u00B0`, row.quality,
    ]),
    // Column 4 is Quality; every other cell stays the default ink.
    colourFor: (row, column) => (column === 4 ? QUALITY_COLOURS[row[4]] ?? null : null),
  });

  return deliver(blob, `align-records-${isoDate(new Date())}.pdf`, say);
}

/**
 * Hands a file to the browser, by whichever route this browser actually has.
 *
 * ── Why this is not just `<a download>` ──────────────────────────────────
 *
 * It was, and on iOS that does nothing at all. Every browser on iPhone is
 * WebKit underneath, and in an app-hosted web view — Bluefy, which is how this
 * site gets Bluetooth on iOS in the first place — a download only happens if
 * the host app implements WebKit's download delegate. Most browser shells do
 * not. The anchor is clicked, no file appears, no error is raised anywhere:
 * the button is simply dead. That is exactly what it looked like from the
 * outside, and the silence is the worst part of it.
 *
 * So the routes are tried in the order that suits the platform, and whichever
 * one is taken, it says so. A button that cannot explain itself is how this
 * broke quietly for a week.
 *
 * @param {Blob} blob
 * @param {string} filename
 * @param {(message: string, link?: HTMLElement|null) => void} say Reports the
 *   outcome into the sheet, so nothing fails silently again.
 */
async function deliver(blob, filename, say) {
  if (isIOS()) {
    // The share sheet is the only reliable way onto an iPhone's filesystem
    // from a web page; "Save to Files" lives inside it.
    if (await shareFile(blob, filename, say)) return;
    // Failing that, WebKit renders a PDF itself, and its viewer has a share
    // button of its own.
    if (openInTab(blob, filename, say)) return;
    // And failing even that, hand over a link for the wearer to tap. A tap is
    // a gesture the web view will honour where a scripted click was ignored.
    say(
      `This browser would not save ${filename} on its own. Tap the link to open it, then use the share button to keep a copy.`,
      tapLink(blob, filename),
    );
    return;
  }

  if (anchorDownload(blob, filename)) {
    say(`Saved ${filename}.`);
    return;
  }
  if (await shareFile(blob, filename, say)) return;
  if (openInTab(blob, filename, say)) return;
  say(`This browser would not save ${filename}.`, tapLink(blob, filename));
}

/**
 * The share sheet, which on iOS is the route to Files.
 *
 * `navigator.share` must be reached inside the tap that started this, so
 * nothing above it may await — the blob is built synchronously for that
 * reason. A share the wearer backs out of counts as handled: they chose that,
 * and falling through to another route would fight them for it.
 */
async function shareFile(blob, filename, say) {
  if (typeof navigator === 'undefined' || typeof navigator.share !== 'function') return false;
  if (typeof File !== 'function') return false;

  let file;
  try {
    file = new File([blob], filename, { type: blob.type });
  } catch {
    return false;
  }
  if (typeof navigator.canShare === 'function' && !navigator.canShare({ files: [file] })) {
    return false;
  }

  try {
    await navigator.share({ files: [file], title: filename });
    say(`Shared ${filename}. Choose "Save to Files" to keep a copy on this phone.`);
    return true;
  } catch (error) {
    if (error && error.name === 'AbortError') {
      say('Export cancelled.');
      return true;
    }
    return false;
  }
}

/** Opens the file in a new tab and lets the browser's own viewer take it. */
function openInTab(blob, filename, say) {
  const url = URL.createObjectURL(blob);
  let opened = null;
  try {
    opened = window.open(url, '_blank');
  } catch {
    opened = null;
  }
  if (!opened) {
    URL.revokeObjectURL(url);
    return false;
  }
  // A minute, not ten seconds: the new tab is still reading from this URL,
  // and revoking it early leaves a blank page with nothing to explain it.
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  say(`Opened ${filename} in a new tab. Use the share button there to save it.`);
  return true;
}

/** A real link to tap, for when a scripted click is being ignored. */
function tapLink(blob, filename) {
  const url = URL.createObjectURL(blob);
  setTimeout(() => URL.revokeObjectURL(url), 300000);
  return h('a', {
    href: url,
    target: '_blank',
    rel: 'noopener',
    download: filename,
    class: 'export-link',
    text: `Open ${filename}`,
  });
}

/**
 * The ordinary desktop route.
 *
 * Whether the file truly arrived cannot be observed from here, so this is only
 * trusted on platforms where it is known to work — which is why iOS never
 * reaches it.
 */
function anchorDownload(blob, filename) {
  if (typeof document === 'undefined') return false;
  const url = URL.createObjectURL(blob);
  const link = h('a', { href: url, download: filename });
  document.body.append(link);
  link.click();
  link.remove();
  // Revoked on a delay: revoking immediately cancels the download in some
  // browsers before it has started reading the blob.
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return true;
}

function isoDate(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function clockTime(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
