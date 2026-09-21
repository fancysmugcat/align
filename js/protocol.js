/**
 * How the site talks to an ESP32.
 *
 * The ALIGN firmware in `firmware/align_esp32.ino` is the profile everything
 * is designed around, but a dev board on your desk is often running something
 * else — the stock Arduino BLE example, a Nordic UART sketch, a serial
 * bridge — so the site knows several shapes of device and picks whichever one
 * it finds after connecting.
 *
 * Web Bluetooth requires UUIDs in lowercase.
 */

export const ALIGNProtocol = {
  /** Advertised primary service. */
  service: 'a11c0001-7e9c-4d2b-9b3a-2f5c9d1e0001',

  /** Notify. 8-byte posture packet, see `decodeReading`. */
  postureCharacteristic: 'a11c0002-7e9c-4d2b-9b3a-2f5c9d1e0002',

  /** Write. Byte 0: buzz duration in tenths of a second (0 = off, 5, 10, 20). */
  buzzCharacteristic: 'a11c0003-7e9c-4d2b-9b3a-2f5c9d1e0003',

  /** Write. 1 byte command, see `Command`. */
  commandCharacteristic: 'a11c0004-7e9c-4d2b-9b3a-2f5c9d1e0004',

  /** Standard Battery Service, used as a fallback if the packet omits battery. */
  batteryService: 'battery_service',
  batteryLevelCharacteristic: 'battery_level',

  /** Name the ESP32 advertises. Used as a secondary filter. */
  advertisedName: 'ALIGN',

  Command: {
    /** Tell the device this is upright — it zeroes its own reference too. */
    calibrate: 0x01,
    /** One short buzz, used to confirm calibration in the UI. */
    testBuzz: 0x02,
    /** One side at a time, for checking the wiring and the left/right mapping. */
    testLeft: 0x03,
    testRight: 0x04,
  },
};

/**
 * Device shapes the site can drive, best first. `notify` and the write
 * characteristics are hints — if a board exposes the service but different
 * characteristic UUIDs, whatever notifies inside that service is used instead.
 *
 * `encoding: 'text'` means commands go out as lines of ASCII rather than raw
 * bytes, which is what a serial-style sketch expects.
 */
export const DEVICE_PROFILES = [
  {
    id: 'align',
    label: 'ALIGN firmware',
    service: ALIGNProtocol.service,
    notify: ALIGNProtocol.postureCharacteristic,
    buzz: ALIGNProtocol.buzzCharacteristic,
    command: ALIGNProtocol.commandCharacteristic,
    encoding: 'binary',
  },
  {
    id: 'nus',
    label: 'Nordic UART',
    service: '6e400001-b5a3-f393-e0a9-e50e24dcca9e',
    notify: '6e400003-b5a3-f393-e0a9-e50e24dcca9e',
    buzz: '6e400002-b5a3-f393-e0a9-e50e24dcca9e',
    command: '6e400002-b5a3-f393-e0a9-e50e24dcca9e',
    encoding: 'text',
  },
  {
    id: 'esp32-example',
    label: 'ESP32 BLE example',
    // UUIDs from the Arduino core's BLE_notify / BLE_server sketches.
    service: '4fafc201-1fb5-459e-8fcc-c5c9c331914b',
    notify: 'beb5483e-36e1-4688-b7f5-ea07361b26a8',
    encoding: 'text',
  },
  {
    id: 'serial',
    label: 'BLE serial (FFE0)',
    service: '0000ffe0-0000-1000-8000-00805f9b34fb',
    notify: '0000ffe1-0000-1000-8000-00805f9b34fb',
    buzz: '0000ffe1-0000-1000-8000-00805f9b34fb',
    command: '0000ffe1-0000-1000-8000-00805f9b34fb',
    encoding: 'text',
  },
];

/** Everything the browser must be told about up front to be allowed to use it. */
export const ALL_SERVICES = [
  ...DEVICE_PROFILES.map((profile) => profile.service),
  ALIGNProtocol.batteryService,
];

/** Filters for the chooser: any known service, or anything named ALIGN. */
export const DEVICE_FILTERS = [
  ...DEVICE_PROFILES.map((profile) => ({ services: [profile.service] })),
  { namePrefix: ALIGNProtocol.advertisedName },
];

/** Text a serial-style board is sent when a setting changes. */
export const TextCommands = {
  buzz: (seconds, degrees) => `buzz:${seconds},${degrees}\n`,   // seconds, for serial sketches
  calibrate: () => 'calibrate\n',
  testBuzz: () => 'buzz-test\n',
};

// MARK: - Decoding

/**
 * Turns one notification into a reading.
 *
 * Handles the 8-byte packet the ALIGN firmware sends:
 *
 *     [0..1] int16  pitch, degrees x 100
 *     [2..3] int16  roll,  degrees x 100
 *     [4]    uint8  battery percent (0...100)
 *     [5]    uint8  flags (bit 0: device-side buzz active)
 *     [6..7] uint16 sequence number (unused here)
 *     [8..9] uint16 sense-pin millivolts, before the divider (optional)
 *
 * …and any line of text carrying two or three numbers, so a sketch that just
 * prints `12.3,-4.5` — or `pitch: 12.3 roll: -4.5 batt: 80` — works without
 * packing bytes.
 *
 * @param {DataView} view
 * @returns {{pitch: number, roll: number, battery: number|null, timestamp: Date}|null}
 */
export function decodeReading(view) {
  if (looksLikeText(view)) {
    return parseTextReading(new TextDecoder().decode(view));
  }

  // Readable text carrying no numbers is a banner or a log line, not a packet.
  // Decoding it as one would invent a posture reading out of the letters.
  if (isPrintable(view)) return null;

  if (view.byteLength >= 6) {
    const battery = view.getUint8(4);
    const reading = {
      pitch: view.getInt16(0, true) / 100,
      roll: view.getInt16(2, true) / 100,
      battery: battery >= 0 && battery <= 100 ? battery : null,
      timestamp: new Date(),
    };
    // Bit 0 of the flags byte is the board saying its own motor is running.
    // Without it, "nothing happened" cannot be told apart from "the command
    // never arrived" — the two have completely different fixes.
    reading.buzzing = (view.getUint8(5) & 0x01) !== 0;

    // Optional tail: the raw voltage at the sense pin, before the divider
    // ratio is applied. A percentage on its own can't be checked — if the
    // ratio is wrong it is confidently wrong — but millivolts can be held
    // against a meter. Older firmware simply doesn't send these bytes.
    if (view.byteLength >= 10) {
      const millivolts = view.getUint16(8, true);
      if (millivolts > 0) reading.pinMillivolts = millivolts;
    }
    // The board's count of buzz-characteristic writes it has taken. Compared
    // with what the site thinks it sent, it says whether a press ever landed.
    if (view.byteLength >= 11) reading.boardWrites = view.getUint8(10);
    return reading;
  }

  return null;
}

/** Pulls the first two or three numbers out of a line. */
export function parseTextReading(text) {
  const numbers = String(text).match(/-?\d+(?:\.\d+)?/g);
  if (!numbers || numbers.length < 2) return null;

  const pitch = Number.parseFloat(numbers[0]);
  const roll = Number.parseFloat(numbers[1]);
  if (!Number.isFinite(pitch) || !Number.isFinite(roll)) return null;

  let battery = null;
  if (numbers.length >= 3) {
    const level = Math.round(Number.parseFloat(numbers[2]));
    if (level >= 0 && level <= 100) battery = level;
  }

  return { pitch, roll, battery, timestamp: new Date() };
}

/**
 * Binary packets and ASCII lines are both longer than six bytes, so length
 * can't separate them. A packet counts as text only if every byte is
 * printable — the zero bytes and high bytes in a packed int16 rule it out.
 */
export function looksLikeText(view) {
  if (!isPrintable(view)) return false;

  let digits = 0;
  for (let i = 0; i < view.byteLength; i += 1) {
    const byte = view.getUint8(i);
    if (byte >= 0x30 && byte <= 0x39) digits += 1;
  }
  return digits >= 2;
}

function isPrintable(view) {
  if (view.byteLength === 0) return false;
  for (let i = 0; i < view.byteLength; i += 1) {
    const byte = view.getUint8(i);
    const printable = byte >= 0x20 && byte <= 0x7e;
    const whitespace = byte === 0x09 || byte === 0x0a || byte === 0x0d;
    if (!printable && !whitespace) return false;
  }
  return true;
}
