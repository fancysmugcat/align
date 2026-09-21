import { PostureStore } from './stores/postureStore.js';
import { SettingsStore } from './stores/settingsStore.js';
import { activeProfile, signOut, initials } from './stores/profile.js';
import { DeviceManager } from './device.js';
import { SheetSync } from './sync.js';
import { h, icon, Icons } from './ui/components.js';
import { createHome } from './ui/home.js';
import { openSettings } from './ui/settings.js';
import { openCalibration } from './ui/calibration.js';
import { renderSignIn } from './ui/signin.js';

const page = document.querySelector('.page');
const topbarActions = document.getElementById('topbar-actions');
const settingsButton = document.getElementById('settings-button');

const profile = activeProfile();
if (profile) boot(profile);
else showSignIn();

/** Nobody is signed in yet — ask who's wearing the band. */
function showSignIn() {
  document.body.classList.add('signed-out');
  renderSignIn(page, { onSignedIn: () => window.location.reload() });
}

function boot(profile) {
  const posture = new PostureStore(profile.id);
  const settings = new SettingsStore(profile.id);
  const device = new DeviceManager();
  const sync = new SheetSync({ posture, profile, device });

  /**
   * Connects the stores together: readings flow device -> posture store,
   * buzz-setting changes flow settings -> device, and daily rollups flow
   * posture store -> Google Sheet.
   */
  device.onReading = (reading) => posture.ingest(reading);
  device.onConnect = () => device.sendBuzzSetting(settings.buzzInterval);
  settings.onBuzzChange = (interval) => device.sendBuzzSetting(interval);

  posture.swapSides = settings.swapSides;
  device.swapSides = settings.swapSides;
  settings.onSwapSidesChange = (swap) => {
    posture.swapSides = swap;
    device.swapSides = swap;
    // The board decides which motor to buzz, so it has to be told too —
    // otherwise the screen says one side and the band vibrates on the other.
    device.sendBuzzSetting(settings.buzzInterval);
    // History was recorded the old way round; flipping the switch without
    // saying so would silently reinterpret every past reading.
    home.refresh();
  };

  const actions = {
    connect: (options) => device.connect(options),
    connectCloud: (code) => device.connectCloud(code),
    connectWiFi: (host) => device.connectWiFi(host || undefined),
    startDemo: () => device.startDemo(),
    openCalibration: () => openCalibration({ device, posture }),
    logOut: async () => {
      device.disconnect();
      posture.save();
      await sync.syncNow({ silent: true });
      signOut();
      window.location.reload();
    },
  };

  const home = createHome({ posture, device, settings, actions });
  document.getElementById('cards').append(home.el);

  mountBatteryChip(device);
  mountProfileChip(profile, openSettingsSheet);
  settingsButton.addEventListener('click', openSettingsSheet);

  function openSettingsSheet() {
    openSettings({ device, posture, settings, sync, profile, actions });
  }

  // Readings arrive far faster than the screen refreshes, so coalesce redraws.
  let livePending = false;
  let liveEmits = 0;
  let gaugeRedraws = 0;
  let lastGaugeError = null;
  posture.onLive(() => {
    liveEmits += 1;
    if (livePending) return;
    livePending = true;
    requestAnimationFrame(() => {
      livePending = false;
      try {
        home.updateLive();
        gaugeRedraws += 1;
      } catch (error) {
        // A throw here used to be invisible: the gauge silently stopped moving
        // while packets kept arriving. Record it so __align.stats() can say so.
        lastGaugeError = error;
        console.error('ALIGN: gauge redraw failed', error);
      }
    });
  });

  // Console handle for diagnosing a stalled gauge: run __align.stats().
  window.__align = {
    device,
    posture,
    settings,
    stats: () => ({
      deviceState: device.state,
      isUsable: device.isUsable,
      packetsDecoded: device.latest !== null,
      lastPacketAt: device.lastPacketAt,
      isCalibrated: posture.isCalibrated,
      currentAngle: posture.currentAngle,
      liveEmits,
      gaugeRedraws,
      lastGaugeError,
    }),
  };

  let dataPending = false;
  posture.onData(() => {
    sync.markDirty();
    if (dataPending) return;
    dataPending = true;
    requestAnimationFrame(() => {
      dataPending = false;
      home.refresh();
    });
  });

  let calibrationPrompted = false;

  device.subscribe(() => {
    home.refresh();
    // First usable connection with no baseline: go straight to calibration.
    if (device.isUsable && !posture.isCalibrated && !calibrationPrompted) {
      calibrationPrompted = true;
      actions.openCalibration();
    }
  });

  // Flush history and readings when the page goes away — there is no
  // scenePhase on the web.
  const flush = () => {
    posture.save();
    sync.flush();
  };
  addEventListener('pagehide', flush);
  addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush();
  });

  posture.load().then(() => {
    device.start();
    sync.start();
  });
}

/**
 * The board's battery, in the top bar.
 *
 * It was only ever in Settings, two taps away, which is no use for the one
 * question it answers — whether the band will last the afternoon. Hidden
 * entirely when the board reports nothing, since no divider is fitted on every
 * build and an empty outline reads as "flat" rather than "unknown".
 */
function mountBatteryChip(device) {
  const text = h('span', { class: 'battery-chip-level' });
  const chip = h('span', { class: 'battery-chip' }, [icon(Icons.battery, 15), text]);
  chip.hidden = true;
  topbarActions.prepend(chip);

  device.subscribe(() => {
    const level = device.battery;
    const known = typeof level === 'number' && level >= 0 && level <= 100;
    chip.hidden = !known;
    if (!known) return;
    text.textContent = `${level}%`;
    chip.classList.toggle('battery-chip--low', level <= 20);
    chip.setAttribute('title', `ALIGN battery: ${level}%`);
  });
}

/** Shows who is signed in, and doubles as a second way into Settings. */
function mountProfileChip(profile, onClick) {
  const chip = h('button', {
    type: 'button',
    class: 'profile-chip',
    title: `Signed in as ${profile.name}`,
    'aria-label': `Signed in as ${profile.name}. Open settings`,
    onClick,
  }, [
    h('span', { class: 'avatar', text: initials(profile), 'aria-hidden': 'true' }),
    h('span', { class: 'profile-chip-name', text: profile.name }),
  ]);
  topbarActions.prepend(chip);
}
