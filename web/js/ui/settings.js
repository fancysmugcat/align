import { BUZZ_INTERVALS, buzzLabel, buzzDetail } from '../models.js';
import { DeviceManager } from '../device.js';
import { SheetSync } from '../sync.js';
import { initials } from '../stores/profile.js';
import { Theme } from '../theme.js';
import { h, card, icon, Icons, segmentedPill } from './components.js';
import { openSheet } from './sheet.js';

/** The five battery marks shown in the design. */
const BATTERY_STEPS = [0, 25, 50, 75, 100];

export function openSettings({ device, posture, settings, sync, profile, actions }) {
  const body = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '14px' } });

  const sheet = openSheet({
    title: 'Settings',
    body,
    onClose: () => {
      unsubscribeDevice();
      unsubscribeSettings();
      unsubscribeData();
      unsubscribeSync();
    },
  });

  const unsubscribeDevice = device.subscribe(render);
  const unsubscribeSettings = settings.subscribe(render);
  const unsubscribeData = posture.onData(render);
  const unsubscribeSync = sync.subscribe(render);

  function render() {
    body.replaceChildren(
      profileCard({ profile, actions }),
      batteryCard(device),
      buzzCard(settings),
      deviceCard({ device, posture, actions, close: sheet.close }),
      issuesSection(settings),
      dataSection(posture, sync),
    );
  }

  render();
}

// MARK: - Profile

function profileCard({ profile, actions }) {
  return card({ title: 'Profile' }, [
    h('div', { class: 'profile-row', style: { background: 'transparent', padding: '0' } }, [
      h('span', { class: 'avatar', text: initials(profile), 'aria-hidden': 'true' }),
      h('span', { class: 'profile-row-copy' }, [
        h('span', { class: 'profile-row-name', text: profile.name }),
        h('span', { class: 'profile-row-detail', text: profile.email || 'No email on file' }),
      ]),
    ]),
    h('hr', { class: 'divider' }),
    row('Tracking since', new Date(profile.createdAt).toLocaleDateString(undefined, {
      month: 'short', day: 'numeric', year: 'numeric',
    }), true),

    h('button', {
      type: 'button',
      class: 'pill-button pill-button--ghost',
      text: 'Log out',
      onClick: actions.logOut,
      style: { marginTop: '6px' },
    }),

    h('p', {
      class: 'hint',
      text: 'Logging out keeps this profile on this device — pick the name again to carry on. A new name starts a fresh calibration, streak and history.',
    }),
  ]);
}

// MARK: - Battery

function batteryCard(device) {
  const level = device.battery;
  /** Null until the device reports a level, so nothing is highlighted. */
  const nearest = level === null
    ? null
    : BATTERY_STEPS.reduce((best, step) => (Math.abs(step - level) < Math.abs(best - level) ? step : best));

  const knobColor = level === null ? Theme.track : (level <= 20 ? Theme.zoneBad : Theme.greenSoft);

  return card({ title: 'Battery' }, [
    segmentedPill({
      options: BATTERY_STEPS,
      label: (step) => `${step}%`,
      selection: nearest,
      onSelect: null,
      trackColor: '#FFFFFF',
      knobColor,
      ariaLabel: 'Battery level',
    }),
    h('p', { class: 'hint' }, [
      icon(Icons.battery, 13),
      level === null ? 'Connect ALIGN to read its battery.' : `ALIGN is at ${level}%.`,
    ]),
  ]);
}

// MARK: - Buzz

function buzzCard(settings) {
  return card({ title: 'Buzz Adjustment' }, [
    segmentedPill({
      options: BUZZ_INTERVALS,
      label: buzzLabel,
      selection: settings.buzzInterval,
      onSelect: (value) => { settings.buzzInterval = value; },
      trackColor: Theme.track,
      knobColor: '#FFFFFF',
      selectedTextColor: Theme.ink,
      textColor: '#F2F2F2',
      ariaLabel: 'Buzz duration',
    }),
    h('p', { class: 'hint', text: buzzDetail(settings.buzzInterval) }),
  ]);
}

// MARK: - Device

function deviceCard({ device, posture, actions, close }) {
  const connected = device.state === DeviceManager.State.connected;

  // Reconnecting goes back through the board code rather than Bluetooth: it
  // is the route that works on the published site, and it needs no permission
  // prompt or second device in the room.
  const connectButton = h('button', {
    type: 'button',
    class: 'pill-button pill-button--ghost',
    text: connected ? 'Disconnect' : 'Reconnect',
    onClick: () => (connected ? device.disconnect() : actions.connectCloud(device.cloudCode)),
  });

  const detail = device.connectionDetail;

  return card({ title: 'Device' }, [
    row('Status', device.label, device.isUsable),
    detail ? h('p', { class: 'hint', text: detail }) : null,
    h('hr', { class: 'divider' }),
    row('Calibration', calibrationDetail(posture), posture.isCalibrated),

    h('div', { class: 'button-pair' }, [
      h('button', {
        type: 'button',
        class: 'pill-button',
        text: 'Recalibrate',
        onClick: () => {
          close();
          actions.openCalibration();
        },
      }),
      connectButton,
    ]),

    h('button', {
      type: 'button',
      class: 'link-button',
      text: device.isDemo ? 'Stop demo mode' : 'Start demo mode',
      onClick: () => device.toggleDemo(),
    }),

    h('p', {
      class: 'hint',
      text: device.cloudCode
        ? `Board ${device.cloudCode}. It publishes over your Wi-Fi, so it reaches this page from anywhere — the two don't have to be on the same network.`
        : 'Enter your board code on the home screen to connect. It is the six characters printed on the board\'s setup page and in the serial monitor.',
    }),

    h('p', {
      class: 'hint',
      text: DeviceManager.isSupported
        ? 'Bluetooth and same-network pairing are also offered on the home screen, for running this site locally.'
        : 'This browser has no Web Bluetooth, which only matters for local pairing — the board code works everywhere.',
    }),
  ]);
}

function calibrationDetail(posture) {
  if (!posture.calibration) return 'Not calibrated';
  return posture.calibration.date.toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

function row(label, value, positive) {
  return h('div', { class: 'row' }, [
    h('span', { class: 'row-label', text: label }),
    h('span', { class: `row-value${positive ? '' : ' row-value--bad'}`, text: value }),
  ]);
}

// MARK: - Issues

function issuesSection(settings) {
  return h('section', { class: 'section' }, [
    h('h3', { class: 'section-title', text: 'Any Issues?' }),
    h('p', { class: 'section-detail', text: 'Feel free to send the team any comments!' }),
    h('a', {
      href: settings.feedbackURL,
      target: '_blank',
      rel: 'noopener noreferrer',
      text: 'Google form link',
      style: { fontSize: '13px', fontWeight: 600 },
    }),
  ]);
}

// MARK: - Data

function dataSection(posture, sync) {
  return h('section', { class: 'section' }, [
    h('h3', { class: 'section-title', text: 'Data' }),
    h('button', {
      type: 'button', class: 'link-button', text: 'Load demo data',
      onClick: () => posture.loadSampleData(),
    }),
    h('button', {
      type: 'button', class: 'link-button link-button--danger', text: 'Erase history and calibration',
      onClick: () => {
        const message = 'Erase all ALIGN data?\n\nThis deletes your posture history and your upright baseline.';
        if (globalThis.confirm(message)) posture.resetAll();
      },
    }),
    h('p', {
      class: 'hint',
      text: 'History is stored in this browser only — clearing site data removes it.',
    }),

    // Syncing runs on its own; this is the only place it reports back.
    h('p', {
      class: `hint${sync.status === SheetSync.Status.error ? ' hint--warn' : ''}`,
      text: `Google Sheet: ${sync.statusLabel.toLowerCase()}.`,
    }),
  ]);
}
