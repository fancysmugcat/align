import { BUZZ_INTERVALS, buzzLabel, buzzDetail } from '../models.js';
import { DeviceManager, isIOS, IOS_BLUETOOTH_BROWSER } from '../device.js';
import { ALIGNProtocol } from '../protocol.js';
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
      deviceCard({ device, posture, settings, actions, close: sheet.close }),
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

  // With no reading the pill still drew its whole 0-100 scale with nothing
  // highlighted, and the leftmost label sat there reading "0%" — which is how
  // an unwired board came to look like a flat one. A scale is only honest when
  // there is a value on it, so with nothing to show it isn't drawn at all.
  const meter = level === null
    ? h('p', { class: 'battery-unknown', text: 'No reading' })
    : segmentedPill({
      options: BATTERY_STEPS,
      label: (step) => `${step}%`,
      selection: nearest,
      onSelect: null,
      trackColor: '#FFFFFF',
      knobColor,
      ariaLabel: 'Battery level',
    });

  return card({ title: 'Battery' }, [
    meter,
    h('p', { class: 'hint' }, [
      icon(Icons.battery, 13),
      // "Connect ALIGN" was shown even while ALIGN was plainly connected,
      // because a missing level and a missing device looked the same here.
      // They are different problems with different fixes, so they now say so.
      level !== null
        ? `ALIGN is at ${level}%.${device.batteryPinMillivolts ? ` Sense pin reads ${(device.batteryPinMillivolts / 1000).toFixed(2)} V.` : ''}`
        : device.batteryPinMillivolts
          ? `The sense pin reads ${(device.batteryPinMillivolts / 1000).toFixed(2)} V, which doesn't match a single cell through the expected 2:1 divider. Tell me this number and the resistor values and I'll set the ratio.`
          : device.isUsable
          ? "This board isn't reporting a battery level. That needs a voltage divider from the cell into an ADC pin — without one there is nothing for the firmware to measure, and it says so rather than guessing."
          : 'Connect ALIGN to read its battery.',
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

function deviceCard({ device, posture, settings, actions, close }) {
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
    baselineDetail(posture) ? h('p', { class: 'hint', text: baselineDetail(posture) }) : null,

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

    h('hr', { class: 'divider' }),
    // Buzzing one side on demand separates "the motors don't work" from "the
    // bad-posture trigger never fired", which otherwise both present as
    // silence and take a three-second lean to tell apart.
    h('p', { class: 'row-label', text: 'Test the motors' }),
    h('div', { class: 'button-pair' }, [
      h('button', {
        type: 'button', class: 'pill-button pill-button--ghost', text: 'Buzz left',
        disabled: !connected,
        onClick: () => device.send(ALIGNProtocol.Command.testLeft),
      }),
      h('button', {
        type: 'button', class: 'pill-button pill-button--ghost', text: 'Buzz right',
        disabled: !connected,
        onClick: () => device.send(ALIGNProtocol.Command.testRight),
      }),
    ]),
    h('p', {
      class: 'hint',
      text: 'Each buzzes that side for half a second. "Buzz left" drives GPIO 4, "Buzz right" drives GPIO 0.',
    }),
    // What the board says about itself while you press them. A silent motor
    // with "board says: buzzing" is a wiring fault; a silent motor with
    // nothing here means the command never arrived.
    h('p', { class: 'hint' }, [
      device.boardBuzzing ? 'Board says: a motor is running now. ' : 'Board says: no motor running. ',
      device.channels
        ? `Channels — readings ${device.channels.notify ? 'yes' : 'NO'}, buzz ${device.channels.buzz ? 'yes' : 'NO'}, commands ${device.channels.command ? 'yes' : 'NO'}.`
        : '',
    ]),
    device.lastWriteError
      ? h('p', { class: 'hint hint--warn', text: `Last write failed: ${device.lastWriteError}` })
      : null,

    h('hr', { class: 'divider' }),
    row('Bad posture buzzes', settings.buzzBoth ? 'Both motors' : 'The leaning side', true),
    h('button', {
      type: 'button',
      class: 'pill-button pill-button--ghost',
      text: settings.buzzBoth ? 'Buzz only the leaning side' : 'Buzz both motors',
      onClick: () => { settings.buzzBoth = !settings.buzzBoth; },
    }),
    h('p', {
      class: 'hint',
      text: 'Buzzing only the side you lean toward tells you which way to correct. Buzzing both loses that, but still warns you when one motor is dead or unwired.',
    }),

    h('hr', { class: 'divider' }),
    row('Sides', settings.swapSides ? 'Swapped' : 'Normal', !settings.swapSides),
    h('button', {
      type: 'button',
      class: 'pill-button pill-button--ghost',
      text: settings.swapSides ? 'Swap left and right back' : 'Swap left and right',
      onClick: () => { settings.swapSides = !settings.swapSides; },
    }),
    h('p', {
      class: 'hint',
      text: 'Lean to your right and check the gauge agrees. Which way round the sensor ended up facing when the band was built decides this, so it is a switch rather than something the firmware can know.',
    }),

    h('hr', { class: 'divider' }),
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
        : isIOS()
          ? `Safari has no Bluetooth, and every iPhone browser is required to use Safari's engine. The board code works here; ${IOS_BLUETOOTH_BROWSER.name} from the App Store adds Bluetooth if you want it.`
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

/** The upright posture itself, so it can be checked without recalibrating. */
function baselineDetail(posture) {
  const baseline = posture.calibration;
  if (!baseline) return null;
  return `Upright posture: pitch ${baseline.pitch.toFixed(1)}°, roll ${baseline.roll.toFixed(1)}°`;
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
