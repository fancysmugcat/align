import {
  ALIGNProtocol, DEVICE_PROFILES, DEVICE_FILTERS, ALL_SERVICES, TextCommands,
  decodeReading, parseTextReading, looksLikeText,
} from './protocol.js';
import { BAD_POSTURE_ANGLE } from './models.js';
import {
  CloudLink, normaliseCode, isValidCode, STALE_AFTER_MS,
} from './cloud.js';

/** Where the last board's pairing code is kept, so the site reconnects itself. */
const CLOUD_CODE_KEY = 'align.cloudCode';

/**
 * True on iPhone and iPad.
 *
 * Worth singling out because iOS is the one platform where "use a different
 * browser" is not advice that works: Apple requires every browser on it to run
 * WebKit, so Chrome and Firefox there are Safari underneath and none of them
 * has Web Bluetooth. The only way onto BLE is an app that ships its own
 * implementation, so the site says that rather than silently hiding the
 * button.
 *
 * iPadOS reports itself as a Mac, so touch points are what separate them.
 */
export function isIOS() {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent ?? '';
  if (/iPhone|iPod/.test(ua)) return true;
  return /iPad/.test(ua) || (/Macintosh/.test(ua) && (navigator.maxTouchPoints ?? 0) > 1);
}

/** A browser that added Web Bluetooth to iOS itself, e.g. Bluefy. */
export function isIOSBluetoothBrowser() {
  return isIOS() && typeof navigator !== 'undefined' && 'bluetooth' in navigator;
}

/** Where to get one. Free, and the one most reliably kept up to date. */
export const IOS_BLUETOOTH_BROWSER = {
  name: 'Bluefy',
  url: 'https://apps.apple.com/app/bluefy-web-ble-browser/id1492822055',
};

/**
 * Talks to the ALIGN ESP32.
 *
 * Three ways in, in the order the site offers them:
 * * **cloud** — the board publishes to a public MQTT broker and the site
 *   subscribes over a secure WebSocket. The only one that works from a
 *   published https site, and the only one where the two ends can be apart.
 * * **wifi** — polling the small web server the board runs, over the local
 *   network. Needs the site served over plain http from the same network.
 * * **bluetooth** — requestDevice/connect/notify against `ALIGNProtocol`.
 *
 * Plus **demo**, a timer generating plausible readings, so the whole site
 * works with no hardware nearby.
 *
 * Unlike the iOS app, a browser may only start a Bluetooth scan from a user
 * gesture, so `connect()` has to be called from a click.
 */
export class DeviceManager {
  static State = {
    idle: 'idle',
    unsupported: 'unsupported',
    insecure: 'insecure',
    connecting: 'connecting',
    connected: 'connected',
    demo: 'demo',
    failed: 'failed',
  };

  constructor() {
    this.state = DeviceManager.State.idle;
    /** Set when a filtered scan turned nothing up, so the UI can widen it. */
    this.canShowAllDevices = false;
    /** Battery percentage reported by the device, 0...100. */
    this.battery = null;
    this.latest = null;
    this.errorMessage = null;

    /** Callbacks, wired up in app.js. */
    this.onReading = null;
    this.onConnect = null;

    /** 'cloud', 'bluetooth', 'wifi' or null. */
    this.transport = null;
    /** Base address of the board's web server, in Wi-Fi mode. */
    this.baseURL = null;
    this.pollTimer = null;

    /** The live MQTT subscription, in cloud mode. */
    this.cloud = null;
    /** Six-character board code, remembered between visits. */
    this.cloudCode = readStoredCode();
    this.staleTimer = null;

    this.device = null;
    this.server = null;
    this.postureChar = null;
    this.buzzChar = null;
    this.commandChar = null;

    /** Which shape of firmware answered, once connected. */
    this.profile = null;
    this.deviceName = null;
    this.lastPacketAt = null;
    /** Serial-style boards send partial lines; they're stitched back together. */
    this.textBuffer = '';
    this.usesLines = false;

    this.demoTimer = null;
    this.demoTick = 0;
    this.pendingBuzz = null;
    this.listeners = new Set();

    this.handleNotification = this.handleNotification.bind(this);
    this.handleBatteryNotification = this.handleBatteryNotification.bind(this);
    this.handleDisconnect = this.handleDisconnect.bind(this);
  }

  // MARK: - Subscriptions

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  setState(state, errorMessage = null) {
    this.state = state;
    this.errorMessage = errorMessage;
    this.listeners.forEach((listener) => listener(this));
  }

  // MARK: - Capabilities

  static get isSupported() {
    return typeof navigator !== 'undefined' && 'bluetooth' in navigator;
  }

  get isUsable() {
    return this.state === DeviceManager.State.connected || this.state === DeviceManager.State.demo;
  }

  get isDemo() {
    return this.state === DeviceManager.State.demo;
  }

  /** What the site is talking to, once it knows. */
  get connectionDetail() {
    if (this.state === DeviceManager.State.demo) return 'Generated readings — no hardware involved.';
    if (this.state !== DeviceManager.State.connected) return null;

    const seenAt = () => (this.lastPacketAt
      ? `last reading ${this.lastPacketAt.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' })}`
      : 'waiting for the first reading');

    if (this.transport === 'cloud') {
      return `Board ${this.cloudCode} · over the internet · ${seenAt()}`;
    }

    if (this.transport === 'wifi') {
      return `${this.baseURL} · Wi-Fi · ${seenAt()}`;
    }

    const name = this.deviceName ?? 'ESP32';
    const shape = this.profile ? this.profile.label : 'unknown firmware';
    return `${name} · ${shape} · ${seenAt()}`;
  }

  get label() {
    switch (this.state) {
      case DeviceManager.State.idle: return 'Not connected';
      case DeviceManager.State.unsupported: return 'This browser has no Bluetooth';
      case DeviceManager.State.insecure: return 'Bluetooth needs a secure (https) page';
      case DeviceManager.State.connecting: return 'Connecting…';
      case DeviceManager.State.connected: return 'Connected';
      case DeviceManager.State.demo: return 'Demo mode';
      case DeviceManager.State.failed: return this.errorMessage ?? 'Connection failed';
      default: return 'Not connected';
    }
  }

  /** Sets the resting state on load and picks up a previously paired device. */
  async start() {
    // A code in the address bar wins over the remembered one, so a link like
    // …/#board=A3F19C pairs a phone in one tap.
    const fromURL = codeFromLocation();
    if (fromURL) this.cloudCode = fromURL;

    // The cloud comes first: it needs no permission prompt and no user
    // gesture, so a board that is already publishing simply appears.
    if (isValidCode(this.cloudCode)) {
      const connected = await this.connectCloud(this.cloudCode, { quiet: true });
      if (connected) return;
    }

    if (!DeviceManager.isSupported) {
      this.setState(globalThis.isSecureContext === false
        ? DeviceManager.State.insecure
        : DeviceManager.State.unsupported);
      return;
    }
    this.setState(DeviceManager.State.idle);
    await this.reconnectKnownDevice();
  }

  /**
   * Chrome remembers devices the user already granted. If one is in range we
   * can reconnect without another permission prompt.
   */
  async reconnectKnownDevice() {
    if (typeof navigator.bluetooth?.getDevices !== 'function') return;
    try {
      const devices = await navigator.bluetooth.getDevices();
      const known = devices.find((device) => (device.name ?? '').includes(ALIGNProtocol.advertisedName))
        ?? devices[0];
      if (!known) return;
      this.device = known;
      known.addEventListener('gattserverdisconnected', this.handleDisconnect);
      await this.openGATT();
    } catch {
      // Not available or out of range — the user can connect manually.
    }
  }

  // MARK: - Connecting

  /**
   * Must be called from a user gesture (a click). `showAll` widens the chooser
   * to every nearby device, for a board that advertises none of the services
   * the site knows.
   */
  async connect({ showAll = false } = {}) {
    if (!DeviceManager.isSupported) {
      this.setState(globalThis.isSecureContext === false
        ? DeviceManager.State.insecure
        : DeviceManager.State.unsupported);
      return;
    }

    this.stopDemo();
    this.canShowAllDevices = showAll ? false : this.canShowAllDevices;
    this.setState(DeviceManager.State.connecting);

    try {
      this.device = await navigator.bluetooth.requestDevice(
        showAll
          // Nothing matched the filters — let the user pick their board by name
          // from every device in range.
          ? { acceptAllDevices: true, optionalServices: ALL_SERVICES }
          : { filters: DEVICE_FILTERS, optionalServices: ALL_SERVICES },
      );
      this.device.addEventListener('gattserverdisconnected', this.handleDisconnect);
      await this.openGATT();
      this.canShowAllDevices = false;
    } catch (error) {
      if (error?.name === 'NotFoundError') {
        // The user dismissed the chooser, or nothing matching was advertising.
        // Offer the unfiltered list next time, in case the board advertises a
        // service the site doesn't know by name.
        this.canShowAllDevices = !showAll;
        this.setState(DeviceManager.State.idle);
      } else {
        this.setState(DeviceManager.State.failed, error?.message ?? 'Connection failed');
      }
    }
  }

  async openGATT() {
    this.setState(DeviceManager.State.connecting);
    this.server = await this.device.gatt.connect();
    this.deviceName = this.device.name ?? 'ESP32';
    this.textBuffer = '';
    this.usesLines = false;

    const found = await this.findProfile();
    if (!found) {
      this.device.gatt.disconnect();
      throw new Error(
        `${this.deviceName} connected, but none of its services stream posture data. `
        + 'Flash firmware/align_esp32.ino, or expose a notifying characteristic.',
      );
    }

    this.profile = found.profile;
    this.postureChar = found.notify;
    this.postureChar.addEventListener('characteristicvaluechanged', this.handleNotification);
    await this.postureChar.startNotifications();

    // Buzz and command are optional — a stripped-down sketch still works.
    this.buzzChar = found.buzz;
    this.commandChar = found.command;

    await this.readBatteryService();

    this.setState(DeviceManager.State.connected);

    if (this.pendingBuzz !== null) {
      const pending = this.pendingBuzz;
      this.pendingBuzz = null;
      this.sendBuzzSetting(pending);
    }
    this.onConnect?.();
  }

  /**
   * Walks the profiles in preference order and returns the first one the board
   * actually implements. Characteristic UUIDs are treated as a hint: if the
   * service is there but the UUIDs differ, whatever notifies inside it is used.
   */
  async findProfile() {
    for (const profile of DEVICE_PROFILES) {
      let service;
      try {
        service = await this.server.getPrimaryService(profile.service);
      } catch {
        continue; // this board doesn't speak that one
      }

      const characteristics = await service.getCharacteristics().catch(() => []);
      const byUUID = (uuid) => (uuid
        ? characteristics.find((characteristic) => characteristic.uuid === uuid)
        : undefined);

      const notify = byUUID(profile.notify)
        ?? characteristics.find((characteristic) => characteristic.properties.notify
          || characteristic.properties.indicate);
      if (!notify) continue;

      const writable = (uuid) => byUUID(uuid)
        ?? characteristics.find((characteristic) => characteristic.properties.write
          || characteristic.properties.writeWithoutResponse);

      return {
        profile,
        notify,
        buzz: profile.buzz ? writable(profile.buzz) ?? null : null,
        command: profile.command ? writable(profile.command) ?? null : null,
      };
    }
    return null;
  }

  /** Standard Battery Service, used if the posture packet omits battery. */
  async readBatteryService() {
    try {
      const service = await this.server.getPrimaryService(ALIGNProtocol.batteryService);
      const characteristic = await service.getCharacteristic(ALIGNProtocol.batteryLevelCharacteristic);
      characteristic.addEventListener('characteristicvaluechanged', this.handleBatteryNotification);
      const value = await characteristic.readValue();
      this.battery = value.getUint8(0);
      try {
        await characteristic.startNotifications();
      } catch {
        // Not all firmware notifies battery; the read above is enough.
      }
    } catch {
      // Device doesn't expose 180F — battery comes from the posture packet.
    }
  }

  handleDisconnect() {
    this.postureChar = null;
    this.buzzChar = null;
    this.commandChar = null;
    this.server = null;
    this.profile = null;
    this.textBuffer = '';
    this.usesLines = false;
    if (this.state !== DeviceManager.State.demo) {
      this.setState(DeviceManager.State.idle);
    }
  }

  handleNotification(event) {
    const value = event.target.value;
    const reading = looksLikeText(value)
      ? this.readText(new TextDecoder().decode(value))
      : decodeReading(value);
    if (!reading) return;

    this.latest = reading;
    this.lastPacketAt = reading.timestamp;
    if (reading.battery !== null) this.battery = reading.battery;
    this.onReading?.(reading);
  }

  /**
   * A serial board may split one line across two notifications, or send
   * several lines at once. Once a newline has been seen from a board, only
   * complete lines are trusted; before that, each notification is treated as a
   * whole message — otherwise a fragment like `pitch 8.5, roll` would be read
   * as a reading in its own right.
   */
  readText(chunk) {
    if (/[\r\n]/.test(chunk)) this.usesLines = true;
    this.textBuffer = (this.textBuffer + chunk).slice(-256);

    if (this.usesLines) {
      const lines = this.textBuffer.split(/[\r\n]+/);
      this.textBuffer = lines.pop() ?? '';   // keep the partial tail

      for (let i = lines.length - 1; i >= 0; i -= 1) {
        const reading = parseTextReading(lines[i]);
        if (reading) return reading;
      }
      return null;
    }

    const reading = parseTextReading(this.textBuffer);
    if (reading) {
      this.textBuffer = '';
      return reading;
    }
    return null;   // probably half a message; wait for the rest
  }

  handleBatteryNotification(event) {
    this.battery = event.target.value.getUint8(0);
    this.listeners.forEach((listener) => listener(this));
  }

  disconnect() {
    this.stopDemo();
    this.stopPolling();
    this.closeCloud();
    this.transport = null;
    this.baseURL = null;
    try {
      this.device?.gatt?.disconnect();
    } catch {
      // Already gone.
    }
    this.device = null;
    this.profile = null;
    this.deviceName = null;
    this.setState(DeviceManager.State.idle);
  }

  // MARK: - Commands

  async sendBuzzSetting(seconds) {
    if (this.transport === 'cloud') {
      this.cloud?.publishCommand({ buzz: seconds, threshold: BAD_POSTURE_ANGLE });
      return;
    }
    if (this.transport === 'wifi') {
      await this.httpCommand(`/buzz?seconds=${seconds}&threshold=${BAD_POSTURE_ANGLE}`);
      return;
    }
    if (!this.buzzChar) {
      this.pendingBuzz = seconds;
      return;
    }
    // Byte 0 is the duration in seconds; bytes 1-2 carry the bad-posture angle
    // in tenths of a degree, little-endian. Older firmware reads byte 0 and
    // ignores the rest, so a one-byte write stays valid.
    const tenths = Math.round(BAD_POSTURE_ANGLE * 10);
    await this.write(
      this.buzzChar,
      Uint8Array.of(seconds, tenths & 0xFF, (tenths >> 8) & 0xFF),
      TextCommands.buzz(seconds, BAD_POSTURE_ANGLE),
    );
  }

  async send(command) {
    if (this.transport === 'cloud') {
      this.cloud?.publishCommand(command === ALIGNProtocol.Command.calibrate
        ? { calibrate: true }
        : { buzzTest: true });
      return;
    }
    if (this.transport === 'wifi') {
      await this.httpCommand(command === ALIGNProtocol.Command.calibrate ? '/calibrate' : '/buzz-test');
      return;
    }
    if (!this.commandChar) return;
    const text = command === ALIGNProtocol.Command.calibrate
      ? TextCommands.calibrate()
      : TextCommands.testBuzz();
    await this.write(this.commandChar, Uint8Array.of(command), text);
  }

  /** Raw byte for the ALIGN firmware, a line of ASCII for a serial board. */
  async write(characteristic, bytes, text) {
    const payload = this.profile?.encoding === 'text'
      ? new TextEncoder().encode(text)
      : bytes;
    try {
      if (characteristic.properties.write) await characteristic.writeValue(payload);
      else await characteristic.writeValueWithoutResponse(payload);
    } catch {
      // The device keeps its previous setting; nothing here is critical.
    }
  }

  // MARK: - Cloud
  //
  // The board publishes to a public MQTT broker and the site subscribes over a
  // secure WebSocket. See `cloud.js` for why the other two transports can't
  // survive the site being published.

  /**
   * @param {string} code The board's six-character pairing code.
   * @param {{quiet?: boolean}} options `quiet` keeps a failed automatic
   *   attempt from putting an error on screen the wearer never asked for.
   * @returns {Promise<boolean>}
   */
  async connectCloud(code, { quiet = false } = {}) {
    const normalised = normaliseCode(code ?? this.cloudCode);
    if (!isValidCode(normalised)) {
      if (!quiet) {
        this.setState(
          DeviceManager.State.failed,
          "That isn't a board code. It is six characters of 0-9 and A-F, "
          + 'printed on the board\'s setup page and in the serial monitor.',
        );
      }
      return false;
    }

    this.stopDemo();
    this.stopPolling();
    this.closeCloud();
    // Held from here rather than on success, so a mistyped code stays in the
    // field to be corrected instead of vanishing when the banner redraws.
    this.cloudCode = normalised;
    this.setState(DeviceManager.State.connecting);

    const link = new CloudLink(normalised, {
      onReading: (reading) => this.handleReading(reading),
      onStatus: (online) => {
        // The board's will, published by the broker when it drops off.
        if (online === false && this.transport === 'cloud') {
          this.setState(DeviceManager.State.failed, `Board ${normalised} went offline.`);
        }
      },
    });

    try {
      await link.connect();
    } catch (error) {
      link.close();
      if (!quiet) this.setState(DeviceManager.State.failed, error?.message ?? 'Could not reach the board.');
      else this.setState(DeviceManager.State.idle);
      return false;
    }

    this.cloud = link;
    storeCode(normalised);
    this.transport = 'cloud';
    this.deviceName = `ALIGN ${normalised}`;
    this.profile = { id: 'cloud', label: 'Internet', encoding: 'json' };
    this.setState(DeviceManager.State.connected);
    this.watchForStaleReadings();
    this.onConnect?.();
    return true;
  }

  /**
   * MQTT gives no signal when a board simply stops publishing — the broker
   * stays connected and the gauge would sit frozen on the last angle looking
   * live. So the gap since the last reading is checked directly.
   */
  watchForStaleReadings() {
    clearInterval(this.staleTimer);
    this.staleTimer = setInterval(() => {
      if (this.transport !== 'cloud' || this.state !== DeviceManager.State.connected) return;
      if (this.cloud?.isLive) return;
      this.setState(
        DeviceManager.State.failed,
        `Board ${this.cloudCode} stopped sending. It may have lost Wi-Fi or power.`,
      );
    }, STALE_AFTER_MS);
  }

  closeCloud() {
    clearInterval(this.staleTimer);
    this.staleTimer = null;
    this.cloud?.close();
    this.cloud = null;
  }

  // MARK: - Wi-Fi
  //
  // The board runs a small web server (firmware/ALIGN_WiFi). This polls it
  // rather than waiting to be pushed to, which keeps the firmware simple and
  // works in every browser — including the ones with no Web Bluetooth at all.

  static get defaultHost() {
    return 'align.local';
  }

  /** How often the board is asked for a reading, in ms. */
  static get pollInterval() {
    return 200;
  }

  async connectWiFi(host = DeviceManager.defaultHost) {
    this.stopDemo();
    this.setState(DeviceManager.State.connecting);

    const base = normaliseHost(host);
    this.lastHostTried = host;
    try {
      const reading = await fetchReading(base, 5000);
      this.baseURL = base;
      this.transport = 'wifi';
      this.deviceName = host;
      this.profile = { id: 'wifi', label: 'Wi-Fi', encoding: 'json' };
      this.handleReading(reading);
      this.setState(DeviceManager.State.connected);
      this.startPolling();
      this.onConnect?.();
      return true;
    } catch (error) {
      this.setState(
        DeviceManager.State.failed,
        error?.name === 'AbortError'
          ? `${host} didn't answer. Check the board is powered and on the same network.`
          : `Couldn't reach ${host}. ${error?.message ?? ''}`.trim(),
      );
      return false;
    }
  }

  startPolling() {
    if (this.pollTimer !== null) return;
    let failures = 0;

    this.pollTimer = setInterval(async () => {
      try {
        const reading = await fetchReading(this.baseURL, 2000);
        failures = 0;
        this.handleReading(reading);
      } catch {
        failures += 1;
        // A couple of dropped polls is normal on wifi; a run of them is not.
        if (failures >= 10) {
          this.stopPolling();
          this.setState(DeviceManager.State.failed, 'Lost contact with the board.');
        }
      }
    }, DeviceManager.pollInterval);
  }

  stopPolling() {
    clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  handleReading(reading) {
    this.latest = reading;
    this.lastPacketAt = reading.timestamp;
    if (reading.battery !== null && reading.battery !== undefined) this.battery = reading.battery;
    this.onReading?.(reading);
  }

  async httpCommand(path) {
    if (!this.baseURL) return;
    try {
      await fetch(`${this.baseURL}${path}`, { cache: 'no-store' });
    } catch {
      // Nothing here is critical enough to interrupt the wearer.
    }
  }

  // MARK: - Demo mode

  /** Generates readings that drift in and out of good posture. */
  startDemo() {
    if (this.demoTimer !== null) return;
    this.battery = 78;
    this.demoTick = 0;
    this.setState(DeviceManager.State.demo);

    this.demoTimer = setInterval(() => {
      this.demoTick += 0.5;
      const t = this.demoTick;
      // Slow drift plus a faster wobble, so the gauge moves believably.
      const pitch = 12 + Math.sin(t / 14) * 13 + Math.sin(t / 2.3) * 2.5;
      const roll = Math.sin(t / 21) * 9 + Math.cos(t / 3.1) * 1.5;
      const reading = { pitch, roll, battery: this.battery, timestamp: new Date() };
      this.latest = reading;
      this.onReading?.(reading);
    }, 500);

    this.onConnect?.();
  }

  stopDemo() {
    if (this.demoTimer !== null) {
      clearInterval(this.demoTimer);
      this.demoTimer = null;
    }
    if (this.state === DeviceManager.State.demo) {
      this.latest = null;
      this.battery = null;
      this.setState(DeviceManager.State.idle);
    }
  }

  toggleDemo() {
    if (this.isDemo) this.stopDemo();
    else this.startDemo();
  }
}

// MARK: - Remembering the board

function readStoredCode() {
  try {
    return normaliseCode(localStorage.getItem(CLOUD_CODE_KEY) ?? '');
  } catch {
    return '';   // private browsing, or storage disabled
  }
}

function storeCode(code) {
  try {
    localStorage.setItem(CLOUD_CODE_KEY, code);
  } catch {
    // Not being able to remember it only costs one retype.
  }
}

/** Reads `?board=A3F19C` or `#board=A3F19C` out of the address. */
function codeFromLocation() {
  if (typeof location === 'undefined') return '';
  const fromQuery = new URLSearchParams(location.search).get('board');
  const fromHash = new URLSearchParams(location.hash.replace(/^#/, '')).get('board');
  return normaliseCode(fromQuery ?? fromHash ?? '');
}

/** Accepts "align.local", "192.168.1.42" or a full URL. */
function normaliseHost(host) {
  const trimmed = String(host ?? '').trim().replace(/\/+$/, '');
  if (!trimmed) return `http://${DeviceManager.defaultHost}`;
  return /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
}

async function fetchReading(base, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${base}/reading`, { cache: 'no-store', signal: controller.signal });
    if (!response.ok) throw new Error(`the board replied ${response.status}`);

    const data = await response.json();
    if (typeof data.pitch !== 'number' || typeof data.roll !== 'number') {
      throw new Error('that address answered, but not with a posture reading');
    }
    return {
      pitch: data.pitch,
      roll: data.roll,
      battery: typeof data.battery === 'number' ? data.battery : null,
      timestamp: new Date(),
    };
  } finally {
    clearTimeout(timer);
  }
}
