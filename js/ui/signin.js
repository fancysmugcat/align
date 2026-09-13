import { h, createPostureArc, silhouette } from './components.js';
import { listProfiles, createProfile, signIn, adoptLegacyData, initials } from '../stores/profile.js';

/**
 * The sign-in screen. Several people share one ALIGN band in testing, so the
 * site asks who is wearing it before recording anything, and keeps each
 * person's history separate.
 */
export function renderSignIn(mount, { onSignedIn }) {
  const existing = listProfiles();

  const name = h('input', {
    type: 'text', id: 'signin-name', class: 'field', placeholder: 'e.g. Beatriz',
    autocomplete: 'name', required: true, maxlength: 60,
  });

  const email = h('input', {
    type: 'email', id: 'signin-email', class: 'field', placeholder: 'you@example.com (optional)',
    autocomplete: 'email', maxlength: 120,
  });

  const error = h('p', { class: 'field-error', role: 'alert' });

  const form = h('form', {
    class: 'signin-form',
    onSubmit: async (event) => {
      event.preventDefault();
      const trimmed = name.value.trim();
      if (!trimmed) {
        error.textContent = 'Enter a name so your readings are filed under it.';
        name.focus();
        return;
      }
      const profile = createProfile({ name: trimmed, email: email.value });
      await adoptLegacyData(profile.id);
      signIn(profile.id);
      onSignedIn(profile);
    },
  }, [
    h('label', { class: 'field-label', for: 'signin-name', text: 'Name' }),
    name,
    h('label', { class: 'field-label', for: 'signin-email', text: 'Email' }),
    email,
    error,
    h('button', { type: 'submit', class: 'pill-button pill-button--wide', text: 'Start tracking' }),
  ]);

  const art = h('div', { class: 'signin-art' }, [
    createPostureArc({ width: 130, arcHeight: 62, lineWidth: 14, showKnob: false }).el,
    silhouette(60),
  ]);
  art.querySelector('.gauge-arc').style.width = '130px';

  const blocks = [
    art,
    h('div', { class: 'signin-copy' }, [
      h('h1', { class: 'signin-title', text: "Who's wearing ALIGN?" }),
      h('p', { class: 'signin-detail', text: 'Your calibration, streak and history are saved under your name on this device.' }),
    ]),
    form,
  ];

  if (existing.length > 0) {
    blocks.push(h('div', { class: 'signin-existing' }, [
      h('p', { class: 'signin-divider', text: 'or continue as' }),
      h('div', { class: 'profile-list' }, existing.map((profile) => h('button', {
        type: 'button',
        class: 'profile-row',
        onClick: () => {
          signIn(profile.id);
          onSignedIn(profile);
        },
      }, [
        h('span', { class: 'avatar', text: initials(profile), 'aria-hidden': 'true' }),
        h('span', { class: 'profile-row-copy' }, [
          h('span', { class: 'profile-row-name', text: profile.name }),
          h('span', { class: 'profile-row-detail', text: lastSeen(profile) }),
        ]),
      ]))),
    ]));
  }

  mount.replaceChildren(h('div', { class: 'signin' }, blocks));
  name.focus();
}

function lastSeen(profile) {
  const date = new Date(profile.lastSeenAt ?? profile.createdAt);
  const days = Math.floor((Date.now() - date.getTime()) / 86400000);
  if (days <= 0) return 'Active today';
  if (days === 1) return 'Last worn yesterday';
  if (days < 30) return `Last worn ${days} days ago`;
  return `Last worn ${date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
}
