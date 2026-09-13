import { ALL_RANGES, HistoryRange, PostureZone, LeanSide } from '../models.js';
import { PostureStore } from '../stores/postureStore.js';
import { DeviceManager } from '../device.js';
import { Theme } from '../theme.js';
import {
  h, card, icon, Icons, createPostureArc, silhouette, leanArc, angleChart,
} from './components.js';

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/**
 * The home screen: banners, streak, live angle, progress and lean cards.
 * `refresh()` redraws everything that depends on history or connection state;
 * `updateLive()` only moves the gauge, which changes ~10x a second.
 */
export function createHome({ posture, device, actions }) {
  let range = HistoryRange.week;

  const banners = h('div', { class: 'banners', style: { display: 'flex', flexDirection: 'column', gap: '14px' } });
  const streak = createStreakCard(posture);
  const angle = createAngleCard(posture, device);
  const progress = createProgressCard(posture, () => range, (next) => {
    range = next;
    progress.refresh();
    lean.refresh();
  });
  const lean = createLeanCard(posture, () => range);

  const el = h('div', {
    style: { display: 'flex', flexDirection: 'column', gap: '14px' },
  }, [banners, streak.el, angle.el, progress.el, lean.el]);

  function refreshBanners() {
    banners.replaceChildren();
    if (!device.isUsable) banners.append(connectionBanner(device, actions));
    if (!posture.isCalibrated) banners.append(calibrationBanner(actions.openCalibration));
  }

  function refresh() {
    refreshBanners();
    streak.refresh();
    angle.refresh();
    progress.refresh();
    lean.refresh();
  }

  refresh();
  return { el, refresh, updateLive: angle.updateLive };
}

// MARK: - Banners

/** Shown until the user has recorded an upright baseline. */
function calibrationBanner(onClick) {
  return h('button', { type: 'button', class: 'banner banner--calibrate', onClick }, [
    icon(Icons.person, 20),
    h('span', { class: 'banner-copy' }, [
      h('span', { class: 'banner-title', text: 'Calibrate ALIGN' }),
      h('span', { class: 'banner-detail', text: 'Sit upright once so we know your baseline.' }),
    ]),
    icon(Icons.chevron, 13),
  ]);
}

/**
 * Shown when the device isn't currently sending readings.
 *
 * The board code leads, because it is the only route that works on this site
 * as published: an https page can't reach the board's own `http://192.168.4.1`
 * web server, and Web Bluetooth needs the board in the same room as a
 * Chromium browser. Both are still offered underneath for anyone running the
 * site locally.
 */
function connectionBanner(device, actions) {
  const supported = DeviceManager.isSupported;
  const connecting = device.state === DeviceManager.State.connecting;

  let detail = 'Enter the six-character code shown on your board to see its angles live.';
  if (device.state === DeviceManager.State.failed && device.errorMessage) {
    detail = device.errorMessage;
  } else if (supported && device.canShowAllDevices) {
    detail = 'No ALIGN board answered over Bluetooth. Check it is powered and advertising, or pick it from the full list.';
  }

  const codeField = h('input', {
    type: 'text',
    class: 'field field--code',
    value: device.cloudCode ?? '',
    placeholder: 'A3F19C',
    'aria-label': 'Board code',
    maxlength: '6',
    spellcheck: 'false',
    autocapitalize: 'characters',
    autocomplete: 'off',
    onInput: (event) => {
      // The code is hex; typing anything else is a slip, not an intention.
      const caretAtEnd = event.target.selectionStart === event.target.value.length;
      event.target.value = event.target.value.toUpperCase().replace(/[^0-9A-F]/g, '').slice(0, 6);
      if (caretAtEnd) event.target.setSelectionRange(6, 6);
    },
    onKeyDown: (event) => {
      if (event.key === 'Enter') actions.connectCloud(codeField.value);
    },
  });

  const children = [
    icon(Icons.signal, 16),
    h('span', { class: 'banner-copy' }, [
      h('span', { class: 'banner-title', text: device.label }),
      h('span', { class: 'banner-detail', text: detail }),
    ]),
    h('div', { class: 'endpoint-row' }, [
      codeField,
      h('button', {
        type: 'button', class: 'pill-button',
        text: connecting ? 'Connecting…' : 'Connect board',
        disabled: connecting,
        onClick: () => actions.connectCloud(codeField.value),
      }),
    ]),
  ];

  const alternatives = [
    h('button', {
      type: 'button', class: 'pill-button pill-button--ghost',
      text: 'Same network',
      title: "Poll the board's own web server. Only works when this page is served over http on the same network as the board.",
      disabled: connecting,
      onClick: () => actions.connectWiFi(),
    }),
  ];

  if (supported) {
    alternatives.push(h('button', {
      type: 'button', class: 'pill-button pill-button--ghost',
      text: 'Bluetooth',
      disabled: connecting,
      onClick: () => actions.connect(),
    }));
    // The board may advertise a service the site doesn't recognise; this lets
    // the wearer pick it out of the full list instead.
    if (device.canShowAllDevices) {
      alternatives.push(h('button', {
        type: 'button', class: 'pill-button pill-button--ghost',
        text: 'Show all devices',
        onClick: () => actions.connect({ showAll: true }),
      }));
    }
  }

  alternatives.push(h('button', {
    type: 'button', class: 'pill-button pill-button--ghost', text: 'Demo mode', onClick: actions.startDemo,
  }));

  children.push(h('span', { class: 'banner-actions' }, alternatives));

  return h('div', { class: 'banner banner--connect' }, children);
}

// MARK: - Streak

/** Mon...Sun wear circles plus the running streak count. */
function createStreakCard(posture) {
  const row = h('div', { class: 'streak-row' });
  const note = h('p', { class: 'streak-note' });
  const el = card({ title: 'Streak' }, [row, note]);

  function refresh() {
    const week = posture.currentWeek();
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    row.replaceChildren(...week.map((day, index) => {
      const future = day.day > today;
      return h('div', {
        class: `streak-day${future ? ' streak-day--future' : ''}`,
        role: 'listitem',
        'aria-label': `${WEEKDAYS[index]}: ${day.worn ? 'worn' : 'not worn'}`,
      }, [
        h('span', { class: 'streak-label', text: WEEKDAYS[index] }),
        h('span', {
          class: `streak-dot${day.worn ? ' streak-dot--worn' : ''}`,
          'aria-hidden': 'true',
        }, day.worn ? [icon(Icons.check, 14)] : []),
      ]);
    }));
    row.setAttribute('role', 'list');

    const streak = posture.streak;
    note.textContent = streak > 0
      ? `${streak} day${streak === 1 ? '' : 's'} in a row · best ${posture.longestStreak}`
      : `Wear ALIGN for ${PostureStore.minimumWearMinutes} minutes to start a streak.`;
  }

  return { el, refresh };
}

// MARK: - Current angle

/** Live angle gauge with a good/bad verdict. */
function createAngleCard(posture, device) {
  const arc = createPostureArc({ arcHeight: 92, lineWidth: 18 });
  const gauge = h('div', { class: 'gauge' }, [arc.el, silhouette(74)]);

  const dot = h('span', { class: 'verdict-dot' });
  const title = h('span', { class: 'verdict-title' });
  const detail = h('span', { class: 'verdict-detail' });
  const verdict = h('div', { class: 'verdict' }, [
    dot,
    h('div', { class: 'verdict-copy' }, [title, detail]),
  ]);

  const el = card({ title: 'Current Angle' }, [gauge, verdict]);

  function isLive() {
    return posture.isCalibrated && device.isUsable && posture.current !== null;
  }

  function updateLive() {
    const live = isLive();
    const angle = live ? posture.currentAngle : 0;
    const zone = live ? posture.currentZone : PostureZone.good;

    gauge.classList.toggle('gauge--idle', !live);
    arc.update(angle, zone);

    dot.style.background = live ? zone.color : Theme.track;
    title.textContent = live
      ? zone.verdict
      : (posture.isCalibrated ? 'Waiting for ALIGN' : 'Not calibrated');
    detail.textContent = live
      ? zone.advice
      : (posture.isCalibrated ? device.label : 'Calibrate to start tracking your angle.');
  }

  return { el, refresh: updateLive, updateLive };
}

// MARK: - Progress

/** Posture history over 1 week / 2 weeks / 1 month. */
function createProgressCard(posture, getRange, setRange) {
  const select = h('select', {
    class: 'range-select',
    'aria-label': 'History range',
    onChange: (event) => setRange(HistoryRange[event.target.value]),
  }, ALL_RANGES.map((option) => h('option', { value: option.id, text: option.label })));

  const chartSlot = h('div');
  const summarySlot = h('div');

  const el = h('section', { class: 'card card--bare' }, [
    h('h2', { class: 'card-title', text: 'Progress' }),
    select,
    chartSlot,
    summarySlot,
  ]);

  function refresh() {
    const range = getRange();
    select.value = range.id;

    const buckets = posture.summaries(range);
    chartSlot.replaceChildren(angleChart(buckets, { intraday: range.intraday === true }));

    const average = posture.averageAngle(range);
    if (average === null) {
      const text = range.intraday
        ? 'Nothing recorded today yet.'
        : 'No data for this period yet.';
      summarySlot.replaceChildren(h('p', { class: 'empty-note', text }));
      return;
    }

    const good = posture.goodShare(range) ?? 0;
    // "Days worn" says nothing about a single day — show time on the band instead.
    const wear = range.intraday
      ? stat(durationLabel(buckets.reduce((total, bucket) => total + bucket.wornMinutes, 0)), 'worn today')
      : stat(`${buckets.filter((day) => day.worn).length}`, 'days worn');

    summarySlot.replaceChildren(h('div', { class: 'stat-row' }, [
      stat(`${Math.round(average)}°`, 'avg angle'),
      stat(`${Math.round(good * 100)}%`, 'good posture'),
      wear,
    ]));
  }

  return { el, refresh };
}

function durationLabel(minutes) {
  const total = Math.round(minutes);
  if (total < 60) return `${total}m`;
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

function stat(value, label) {
  return h('div', { class: 'stat' }, [
    h('span', { class: 'stat-value', text: value }),
    h('span', { class: 'stat-label', text: label }),
  ]);
}

// MARK: - Lean

/** Which side the user drifts toward most often. */
function createLeanCard(posture, getRange) {
  const subtitle = h('p', { class: 'card-subtitle' });
  const heading = h('div', { class: 'card-heading' }, [
    h('h2', { class: 'card-title', text: 'Left or Right?' }),
    subtitle,
  ]);
  const body = h('div');
  const el = h('section', { class: 'card' }, [heading, body]);

  function refresh() {
    const bias = posture.leanBias(getRange());

    subtitle.textContent = describe(bias);
    body.replaceChildren(leanArc(bias));

    if (bias.sampleCount > 0) {
      body.append(h('div', { class: 'lean-legend' }, [
        h('span', { text: `Left ${percent(bias.leftShare)}` }),
        h('span', { text: `Right ${percent(bias.rightShare)}` }),
      ]));
    }
  }

  return { el, refresh };
}

function describe(bias) {
  if (bias.sampleCount === 0) return 'Not enough data yet.';
  switch (bias.dominant) {
    case LeanSide.left: return 'You are leaning more towards the left.';
    case LeanSide.right: return 'You are leaning more towards the right.';
    default: return 'You are leaning evenly on both sides.';
  }
}

function percent(value) {
  return `${Math.round(value * 100)}%`;
}
