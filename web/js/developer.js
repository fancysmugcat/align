import { h, card } from './ui/components.js';
import { listProfiles } from './stores/profile.js';
import { collectRows, renderRecords, passwordMatches } from './ui/records.js';
import { SHEET_URL } from './config.js';

/**
 * The developer page: every wearer's records, behind a password.
 *
 * It is a separate page so a wearer's Settings never holds anyone else's
 * readings. It sits on the same origin as the app, which is the only reason it
 * can see them at all: the records live in this browser's storage, so this
 * page shows everyone who has used ALIGN *in this browser on this device*, not
 * every ALIGN user everywhere.
 *
 * The view across every device is the Google Sheet each wearer's readings sync
 * into, so the right password goes straight there. The sheet keeps its own
 * Google sharing, so the link opens only for accounts it is shared with; the
 * password here is not what protects it.
 */

const cards = document.getElementById('cards');

/**
 * Once the password is entered, a reload keeps the page open for the rest of
 * this tab's session instead of asking again. Closing the tab locks it.
 */
const UNLOCKED_KEY = 'align.developerUnlocked';

if (isUnlocked()) showEverything();
else showPasswordPrompt();

function isUnlocked() {
  try { return sessionStorage.getItem(UNLOCKED_KEY) === '1'; } catch { return false; }
}

function rememberUnlocked() {
  try { sessionStorage.setItem(UNLOCKED_KEY, '1'); } catch { /* asks again next reload */ }
}

function showPasswordPrompt() {
  const field = h('input', {
    type: 'password', class: 'field', placeholder: 'Password',
    'aria-label': 'Developer password', autocomplete: 'current-password',
  });
  const problem = h('p', { class: 'hint hint--warn', role: 'alert' });

  async function attempt() {
    problem.textContent = '';
    if (await passwordMatches(field.value)) {
      rememberUnlocked();
      // replace(), not assign(): Back from the sheet returns to the app rather
      // than to this page, which would only send them on to the sheet again.
      window.location.replace(SHEET_URL);
      return;
    }
    problem.textContent = 'Wrong password.';
    field.value = '';
    field.focus();
  }

  field.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') attempt();
  });

  cards.replaceChildren(card({
    title: 'Developer database',
    subtitle: 'Every wearer’s records on this device. Enter the developer password to continue.',
  }, [
    h('div', { class: 'endpoint-row' }, [
      field,
      h('button', { type: 'button', class: 'pill-button', text: 'Open', onClick: attempt }),
    ]),
    problem,
  ]));
  field.focus();
}

async function showEverything() {
  cards.replaceChildren(card({ title: 'All records' }, [
    h('p', { class: 'hint', text: 'Reading records…' }),
  ]));

  const profiles = listProfiles();
  const rows = await collectRows(profiles);

  const recordsBody = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '14px' } });
  renderRecords(recordsBody, rows, { showUser: true });

  cards.replaceChildren(
    card({
      title: 'Google Sheet',
      subtitle: 'Every wearer’s readings, from every device.',
    }, [
      h('a', { class: 'pill-button', href: SHEET_URL, text: 'Open the Google Sheet' }),
    ]),
    card({
      title: 'Wearers',
      subtitle: `${profiles.length} profile${profiles.length === 1 ? '' : 's'} on this device.`,
    }, [
      profiles.length === 0
        ? h('p', { class: 'empty-note', text: 'Nobody has signed in on this device yet.' })
        : h('div', { class: 'wearer-list' }, profiles.map((profile) => wearerRow(profile, rows))),
    ]),
    card({ title: 'All records' }, [recordsBody]),
    h('p', {
      class: 'hint',
      text: 'The lists above are what this browser holds: everyone who has used ALIGN on this device. Wearers on other phones are in the Google Sheet.',
    }),
  );
}

function wearerRow(profile, rows) {
  const theirs = rows.filter((row) => row.profileId === profile.id);
  const lastSeen = profile.lastSeenAt
    ? new Date(profile.lastSeenAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
    : 'never';
  const since = new Date(profile.createdAt).toLocaleDateString(undefined, { dateStyle: 'medium' });

  return h('div', { class: 'wearer-row' }, [
    h('span', { class: 'wearer-row-name', text: profile.name }),
    h('span', { class: 'wearer-row-count', text: `${theirs.length} readings` }),
    h('span', {
      class: 'wearer-row-detail',
      text: `${profile.email || 'No email'} · since ${since} · last seen ${lastSeen}`,
    }),
  ]);
}
