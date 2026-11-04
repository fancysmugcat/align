import { h, card } from './ui/components.js';
import { listProfiles } from './stores/profile.js';
import { collectRows, renderRecords, passwordMatches } from './ui/records.js';

/**
 * The developer page: every wearer's records, behind a password.
 *
 * It is a separate page so a wearer's Settings never holds anyone else's
 * readings. It sits on the same origin as the app, which is the only reason it
 * can see them at all: the records live in this browser's storage, so this
 * page shows everyone who has used ALIGN *in this browser on this device*, not
 * every ALIGN user everywhere. A site with no server has no wider view to give.
 */

const cards = document.getElementById('cards');

showPasswordPrompt();

function showPasswordPrompt() {
  const field = h('input', {
    type: 'password', class: 'field', placeholder: 'Password',
    'aria-label': 'Developer password', autocomplete: 'current-password',
  });
  const problem = h('p', { class: 'hint hint--warn', role: 'alert' });

  async function attempt() {
    problem.textContent = '';
    if (await passwordMatches(field.value)) {
      await showEverything();
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
    title: 'For the developer',
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
      text: 'Records are kept in each browser, not on a server. This page shows everyone who has used ALIGN in this browser on this device; a wearer on another phone appears only on that phone.',
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
