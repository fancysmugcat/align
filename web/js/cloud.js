/**
 * The internet path between the board and the site.
 *
 * The other two transports both need the browser and the ESP32 to be in the
 * same room: Web Bluetooth needs them paired, and the board's own web server
 * needs them on the same network. Neither survives publishing the site.
 * A page served over https cannot fetch `http://192.168.4.1` — browsers block
 * mixed content — and while a laptop is joined to the board's own hotspot it
 * has no route to the internet to load the site in the first place.
 *
 * So the two ends stop talking directly and meet at a public MQTT broker
 * instead. The board publishes readings to it over plain TCP; the site
 * subscribes over a secure WebSocket, which is allowed from an https origin.
 * Wearer and website can then be on opposite sides of the world.
 *
 *     ESP32 --mqtt:1883--> broker.emqx.io <--wss:8084-- website
 *
 * The broker is public and unauthenticated, so every board gets its own
 * corner of the topic tree, keyed by a code derived from its MAC address. The
 * code is printed on the board's setup page and over serial; typing it into
 * the site is the whole of pairing. It is not a secret — readings are two
 * angles — but it does keep two ALIGN boards from landing in each other's
 * gauge.
 */

/** Public broker, secure WebSocket listener. Free, no account, no password. */
export const CLOUD_BROKER = 'wss://broker.emqx.io:8084/mqtt';

/** How long to wait for the board's first reading before saying it's absent. */
const FIRST_READING_TIMEOUT_MS = 12000;

/** Readings older than this mean the board stopped publishing. */
export const STALE_AFTER_MS = 5000;

/**
 * A board's code is the last three bytes of its MAC in hex — stable across
 * reflashes, unique in practice, and short enough to read off a screen.
 */
export function normaliseCode(code) {
  return String(code ?? '').toUpperCase().replace(/[^0-9A-F]/g, '').slice(0, 6);
}

export function isValidCode(code) {
  return normaliseCode(code).length === 6;
}

export function topicsFor(code) {
  const base = `align/${normaliseCode(code)}`;
  return {
    reading: `${base}/reading`,
    command: `${base}/cmd`,
    status: `${base}/status`,
  };
}

/**
 * One subscription to one board.
 *
 * Reconnection is left to mqtt.js, which backs off on its own; this only
 * translates its events into the four things the rest of the site cares
 * about — connecting, subscribed, a reading arrived, it went away.
 */
export class CloudLink {
  constructor(code, { onReading, onStatus, onError } = {}) {
    this.code = normaliseCode(code);
    this.topics = topicsFor(this.code);
    this.onReading = onReading ?? null;
    this.onStatus = onStatus ?? null;
    this.onError = onError ?? null;

    this.client = null;
    this.deviceOnline = null;   // null until the board's status is known
    this.lastReadingAt = null;
    this.closed = false;
  }

  /**
   * Resolves once the broker has accepted the subscription *and* the board has
   * sent something — a broker that answers while the board is unplugged is not
   * a connection the wearer would call working.
   */
  connect() {
    if (typeof globalThis.mqtt?.connect !== 'function') {
      return Promise.reject(new Error(
        'The MQTT client script did not load. Reload the page, or check that '
        + 'vendor/mqtt.min.js is being served.',
      ));
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (message) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.close();
        reject(new Error(message));
      };
      const succeed = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };

      const timer = setTimeout(() => {
        fail(
          `Board ${this.code} is not publishing. Check it is powered on and `
          + 'joined to a Wi-Fi network with internet — its setup page says which.',
        );
      }, FIRST_READING_TIMEOUT_MS);

      this.client = globalThis.mqtt.connect(CLOUD_BROKER, {
        // A duplicate client id gets the older session kicked off the broker,
        // so two tabs on the same board must not share one.
        clientId: `align-web-${this.code}-${Math.random().toString(16).slice(2, 10)}`,
        clean: true,
        reconnectPeriod: 3000,
        connectTimeout: 8000,
        keepalive: 30,
      });

      this.client.on('connect', () => {
        this.client.subscribe([this.topics.reading, this.topics.status], { qos: 0 }, (error) => {
          if (error) {
            fail(`The broker refused the subscription. ${error.message}`);
            return;
          }
          // Tell the board someone is watching, so it can buzz to confirm.
          // Nothing else would tell it: the broker sits in between, and a
          // subscriber is invisible to a publisher in MQTT. Sent on every
          // connect, so a reconnection after a dropped Wi-Fi confirms itself
          // the same way the first one did.
          this.client.publish(this.topics.command, JSON.stringify({ hello: true }), { qos: 0 });
        });
      });

      this.client.on('message', (topic, payload) => {
        if (topic === this.topics.status) {
          this.deviceOnline = payload.toString().trim() === 'online';
          this.onStatus?.(this.deviceOnline);
          // A retained "offline" is the board's will from a previous run; it
          // says nothing about now, so it must not end the wait.
          return;
        }
        if (topic !== this.topics.reading) return;

        const reading = parseReading(payload.toString());
        if (!reading) return;
        this.lastReadingAt = reading.timestamp;
        this.deviceOnline = true;
        succeed();
        this.onReading?.(reading);
      });

      this.client.on('error', (error) => {
        // Errors before the first reading are fatal to this attempt; after it,
        // mqtt.js reconnects and the site rides it out.
        if (!settled) fail(`Could not reach the broker. ${error?.message ?? error}`);
        else this.onError?.(error);
      });

      this.client.on('close', () => {
        if (this.closed || settled) return;
        fail('The connection to the broker closed before the board answered.');
      });
    });
  }

  /** True while readings are still arriving. */
  get isLive() {
    if (!this.lastReadingAt) return false;
    return Date.now() - this.lastReadingAt.getTime() < STALE_AFTER_MS;
  }

  publishCommand(command) {
    if (!this.client?.connected) return;
    this.client.publish(this.topics.command, JSON.stringify(command), { qos: 0 });
  }

  close() {
    this.closed = true;
    try {
      this.client?.end(true);
    } catch {
      // Already gone.
    }
    this.client = null;
  }
}

/**
 * One published reading. The firmware sends JSON; anything else on the topic
 * is somebody else's traffic and is ignored rather than guessed at.
 */
export function parseReading(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object') return null;
  if (typeof data.pitch !== 'number' || typeof data.roll !== 'number') return null;
  if (!Number.isFinite(data.pitch) || !Number.isFinite(data.roll)) return null;

  const battery = typeof data.battery === 'number' && data.battery >= 0 && data.battery <= 100
    ? data.battery
    : null;

  return { pitch: data.pitch, roll: data.roll, battery, timestamp: new Date() };
}
