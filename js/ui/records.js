import { h } from './components.js';
import { openSheet } from './sheet.js';
import { listProfiles } from '../stores/profile.js';
import { loadSamples } from '../stores/storage.js';
import { qualityLabel } from '../models.js';

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

  body.replaceChildren(
    h('p', { class: 'section-detail', text: `${rows.length} readings from ${countUsers(rows)} wearer${countUsers(rows) === 1 ? '' : 's'}, newest first.` }),
    h('button', {
      type: 'button', class: 'pill-button', text: 'Download CSV',
      onClick: () => downloadCSV(rows),
    }),
    h('p', {
      class: 'hint',
      text: 'These are this device’s records. Another phone keeps its own — the site has no server to share them through, so the CSV is how they travel.',
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

function downloadCSV(rows) {
  const escape = (value) => {
    const text = String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const lines = [
    ['User', 'Date', 'Time', 'Angle', 'Quality'].join(','),
    ...rows.map((row) => [row.user, row.date, row.time, row.angle, row.quality].map(escape).join(',')),
  ];

  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = h('a', { href: url, download: `align-records-${isoDate(new Date())}.csv` });
  document.body.append(link);
  link.click();
  link.remove();
  // Revoked on a delay: revoking immediately cancels the download in some
  // browsers before it has started reading the blob.
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function isoDate(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function clockTime(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
