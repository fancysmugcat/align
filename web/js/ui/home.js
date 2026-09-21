import { ALL_RANGES, HistoryRange, PostureZone, LeanSide, leanFor } from '../models.js';
import { PostureStore } from '../stores/postureStore.js';
import { DeviceManager, isIOS, isIOSBluetoothBrowser, IOS_BLUETOOTH_BROWSER } from '../device.js';
import { Theme } from '../theme.js';
import {
  h, card, icon, Icons, createPostureArc, silhouette, leanArc, angleChart,
} from './components.js';

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** Degrees of roll at each end of the live lean track. */
const LEAN_FULL_SCALE = 30;

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
  return {
    el,
    refresh,
    // Both move at reading rate; everything else waits for refresh().
    updateLive: () => { angle.updateLive(); lean.updateLive(); },
  };
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

  // The failed state puts the whole explanation in `device.label`, which the
  // banner also shows as its title — printing both left the same sentence on
  // screen twice. The headline stays short and the reason goes underneath it.
  let title = device.label;
  let detail = supported
    ? 'Pair with your ALIGN board to see its angles live.'
    : 'Enter the six-character code shown on your board to see its angles live.';
  if (device.state === DeviceManager.State.failed && device.errorMessage) {
    title = 'Board not connected';
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
      h('span', { class: 'banner-title', text: title }),
      h('span', { class: 'banner-detail', text: detail }),
    ]),
  ];

  // Bluetooth leads, because it is the route that actually works here: it needs
  // no router, no password and no broker, and on this board the Wi-Fi paths
  // have never completed a handshake. The other two still exist, one tap away,
  // rather than crowding the thing the wearer reaches for every time.
  const primary = [];

  if (supported) {
    primary.push(h('button', {
      type: 'button', class: 'pill-button',
      // On iOS this button only exists because the wearer went and installed a
      // browser for it, so name the thing that made it possible.
      text: isIOSBluetoothBrowser() ? `Connect (${IOS_BLUETOOTH_BROWSER.name})` : 'Connect Bluetooth',
      onClick: () => actions.connect(),
    }));
    // The board may advertise a service the site doesn't recognise; this lets
    // the wearer pick it out of the full list instead.
    if (device.canShowAllDevices) {
      primary.push(h('button', {
        type: 'button', class: 'pill-button pill-button--ghost',
        text: 'Show all devices',
        onClick: () => actions.connect({ showAll: true }),
      }));
    }
  }

  primary.push(h('button', {
    type: 'button', class: 'pill-button pill-button--ghost', text: 'Demo mode', onClick: actions.startDemo,
  }));

  children.push(h('span', { class: 'banner-actions' }, primary));

  // Wi-Fi, folded away. Nothing here runs unless it is opened and used.
  const more = h('div', { class: 'banner-more' }, [
    h('p', {
      class: 'hint',
      text: 'Over Wi-Fi the board reaches this page from anywhere, not just from across the room. It needs the board joined to a network first.',
    }),
    h('div', { class: 'endpoint-row' }, [
      codeField,
      h('button', {
        type: 'button', class: 'pill-button',
        text: connecting ? 'Connecting…' : 'Connect board',
        disabled: connecting,
        onClick: () => actions.connectCloud(codeField.value),
      }),
    ]),
    h('button', {
      type: 'button', class: 'pill-button pill-button--ghost',
      text: 'Same network instead',
      title: "Poll the board's own web server. Only works when this page is served over http on the same network as the board.",
      disabled: connecting,
      onClick: () => actions.connectWiFi(),
    }),
  ]);
  more.hidden = !connecting;   // stays open while an attempt it started runs

  const toggle = h('button', {
    type: 'button', class: 'link-button',
    text: more.hidden ? 'Connect over Wi-Fi instead' : 'Hide Wi-Fi options',
    onClick: () => {
      more.hidden = !more.hidden;
      toggle.textContent = more.hidden ? 'Connect over Wi-Fi instead' : 'Hide Wi-Fi options';
    },
  });

  // On iOS with no Bluetooth at all, Wi-Fi is the only route left, so it is not
  // hidden behind a disclosure the wearer has no alternative to opening.
  if (!supported) more.hidden = false;
  else children.push(toggle);
  children.push(more);

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

  // "Current Angle" alone reads as a direction on a device whose other card is
  // called "Left or Right?" — and the needle sweeping leftward as the number
  // grows makes that reading almost irresistible. It is a distance: how far
  // off upright, combining slouch and lean, never which way.
  // Raw pitch and roll, straight off the board. Without this an uncalibrated
  // gauge sits at 0 degrees and never moves — PostureStore.ingest() drops every
  // reading until there is a baseline to measure against — and nothing on
  // screen says whether the board is streaming or dead. Now it always does.
  const stream = h('p', { class: 'hint gauge-stream' });

  const el = card({
    title: 'Current Angle',
    subtitle: 'How far you are leaning, and which way — forward slouch is not counted',
  }, [gauge, verdict, stream]);

  function isLive() {
    return posture.isCalibrated && device.isUsable && posture.current !== null;
  }

  function updateLive() {
    const live = isLive();
    const angle = live ? posture.currentAngle : 0;
    const zone = live ? posture.currentZone : PostureZone.good;

    // Signed roll drives which way the knob goes; it is already relative to
    // the calibrated upright.
    const lean = live && posture.current ? posture.current.roll : 0;

    gauge.classList.toggle('gauge--idle', !live);
    arc.update(angle, zone, lean);

    dot.style.background = live ? zone.color : Theme.track;
    title.textContent = live
      ? zone.verdict
      : (posture.isCalibrated ? 'Waiting for ALIGN' : 'Not calibrated');
    detail.textContent = live
      ? zone.advice
      : (posture.isCalibrated ? device.label : 'Calibrate to start tracking your angle.');

    const latest = device.latest;
    if (!latest) {
      stream.textContent = device.isUsable ? 'Waiting for the first reading…' : '';
    } else {
      const seen = latest.timestamp instanceof Date
        ? latest.timestamp.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' })
        : '';
      const raw = `board: pitch ${latest.pitch.toFixed(1)}° · roll ${latest.roll.toFixed(1)}°${seen ? ` · ${seen}` : ''}`;
      stream.textContent = posture.isCalibrated
        ? raw
        : `${raw} — calibrate to measure against your upright posture`;
    }
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
      const text = range.rolling
        ? `Nothing recorded in the last ${range.windowMinutes} minutes.`
        : range.intraday
          ? 'Nothing recorded today yet.'
          : 'No data for this period yet.';
      summarySlot.replaceChildren(h('p', { class: 'empty-note', text }));
      return;
    }

    const good = posture.goodShare(range) ?? 0;
    // "Days worn" says nothing about a single day — show time on the band instead.
    const wornMinutes = buckets.reduce((total, bucket) => total + bucket.wornMinutes, 0);
    const wear = range.intraday
      ? stat(durationLabel(wornMinutes), range.rolling ? 'worn this hour' : 'worn today')
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

  // The arc underneath answers "which way do you tend to lean", averaged over
  // the selected range. That needs ten-second samples and a sustained bias, so
  // it says nothing at all for the first few minutes and never reacts to you
  // moving. This row answers "which way am I leaning right now", straight off
  // the live reading — which is what someone wearing the band is actually
  // asking when they lean over to look at it.
  const liveLabel = h('span', { class: 'lean-live-label' });
  const liveAngle = h('span', { class: 'lean-live-angle' });
  const marker = h('span', { class: 'lean-live-marker' });
  const live = h('div', { class: 'lean-live' }, [
    h('div', { class: 'lean-live-copy' }, [liveLabel, liveAngle]),
    h('div', { class: 'lean-live-track' }, [
      h('span', { class: 'lean-live-centre' }),
      marker,
    ]),
    h('div', { class: 'lean-live-ends' }, [
      h('span', { text: 'Left' }),
      h('span', { text: 'Right' }),
    ]),
  ]);

  const body = h('div');
  const el = h('section', { class: 'card' }, [heading, live, body]);

  function updateLive() {
    if (!posture.isCalibrated) {
      liveLabel.textContent = 'Calibrate to see live lean';
      liveAngle.textContent = '';
      marker.style.left = '50%';
      marker.dataset.side = 'center';
      return;
    }

    const sample = posture.current;
    if (!sample) {
      liveLabel.textContent = 'Waiting for readings';
      liveAngle.textContent = '';
      marker.style.left = '50%';
      marker.dataset.side = 'center';
      return;
    }

    // Roll is already relative to the calibrated upright, so a board mounted
    // slightly off-square doesn't read as a permanent lean.
    const roll = sample.roll;
    const side = leanFor(roll);
    liveLabel.textContent = side === LeanSide.left
      ? 'Leaning left'
      : side === LeanSide.right ? 'Leaning right' : 'Centred';
    liveAngle.textContent = `${Math.abs(roll).toFixed(1)}°`;

    // Past 30 degrees the exact number stops mattering; peg the marker so it
    // can't slide out of its track.
    const clamped = Math.max(-LEAN_FULL_SCALE, Math.min(LEAN_FULL_SCALE, roll));
    marker.style.left = `${50 + (clamped / LEAN_FULL_SCALE) * 50}%`;
    marker.dataset.side = side;
  }

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
    updateLive();
  }

  return { el, refresh, updateLive };
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
