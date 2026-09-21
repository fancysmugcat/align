import { SHEET_WEB_APP_URL, SHEET_URL, SYNC_INTERVAL_MINUTES, SYNC_WINDOW_DAYS } from './config.js';
import { readJSON, writeJSON, removeKey } from './stores/storage.js';
import { qualityLabel } from './models.js';

const ENDPOINT_KEY = 'align.sheetEndpoint';
const LAST_SYNC_KEY = 'align.lastSync';
/** Newest reading already written, so a sync only sends what is new. */
const HIGH_WATER_KEY = 'align.lastReadingSent';

/**
 * Pushes each profile's daily rollups into the ALIGN Google Sheet.
 *
 * A browser can't write to Sheets directly, so this posts JSON to an Apps
 * Script Web App bound to the spreadsheet, which upserts one row per profile
 * per day. Rows are keyed on (profile, date), so re-sending a day corrects it
 * rather than duplicating it — that's why a sync can safely resend a window of
 * recent days instead of tracking exactly what was uploaded.
 */
export class SheetSync {
  static Status = {
    unconfigured: 'unconfigured',
    idle: 'idle',
    syncing: 'syncing',
    ok: 'ok',
    error: 'error',
  };

  constructor({ posture, profile, device }) {
    this.posture = posture;
    this.profile = profile;
    this.device = device;

    // The endpoint is entered in Settings and kept in this browser, not
    // committed to config.js — the repository is public, and anyone holding
    // the URL can post rows into the sheet. A stored value is only honoured
    // if it actually looks like an Apps Script deployment, because the field
    // previously collected spreadsheet URLs, which cannot accept posts.
    const stored = readJSON(ENDPOINT_KEY);
    if (stored && !isAppsScriptEndpoint(stored)) removeKey(ENDPOINT_KEY);

    if (this.endpoint && !isAppsScriptEndpoint(this.endpoint)) {
      console.warn(
        '[ALIGN] SHEET_WEB_APP_URL in js/config.js should be the Apps Script '
        + 'deployment URL — https://script.google.com/macros/s/…/exec — not the '
        + 'spreadsheet URL. Nothing will sync until it is.',
      );
    }

    this.status = this.endpoint ? SheetSync.Status.idle : SheetSync.Status.unconfigured;
    this.message = '';
    this.dirty = false;
    this.listeners = new Set();
    this.timer = null;
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit() {
    this.listeners.forEach((listener) => listener(this));
  }

  // MARK: - Configuration

  /** Set once, in config.js — there is nothing to configure in the app. */
  /** Where the wearer's own endpoint is kept, if they have entered one. */
  static get storedEndpoint() {
    const stored = readJSON(ENDPOINT_KEY);
    return isAppsScriptEndpoint(stored) ? stored : '';
  }

  /**
   * @returns {{ok: boolean, message: string}} whether it was accepted.
   */
  static setEndpoint(url) {
    const trimmed = String(url ?? '').trim();
    if (!trimmed) {
      removeKey(ENDPOINT_KEY);
      return { ok: true, message: 'Sheet disconnected.' };
    }
    if (!isAppsScriptEndpoint(trimmed)) {
      return {
        ok: false,
        message: 'That needs to be the Apps Script deployment URL — it starts '
          + 'https://script.google.com/macros/s/ and ends /exec. The '
          + "spreadsheet's own address can't receive data.",
      };
    }
    return writeJSON(ENDPOINT_KEY, trimmed)
      ? { ok: true, message: 'Sheet connected.' }
      : { ok: false, message: "This browser won't store the address." };
  }

  get endpoint() {
    // What the wearer entered wins; config.js is only a fallback for a build
    // that ships its own endpoint.
    return SheetSync.storedEndpoint || (SHEET_WEB_APP_URL ?? '').trim();
  }

  get sheetURL() {
    return SHEET_URL;
  }

  get lastSyncedAt() {
    const stored = readJSON(LAST_SYNC_KEY);
    return stored ? new Date(stored) : null;
  }

  get statusLabel() {
    switch (this.status) {
      case SheetSync.Status.unconfigured: return 'Not syncing — no sheet connected';
      case SheetSync.Status.syncing: return 'Sending…';
      case SheetSync.Status.ok: return this.lastSyncedAt
        ? `Synced ${this.lastSyncedAt.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`
        : 'Synced';
      case SheetSync.Status.error: return this.message || 'Last sync failed';
      default: return this.lastSyncedAt
        ? `Last synced ${this.lastSyncedAt.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`
        : 'Waiting for the first sync';
    }
  }

  // MARK: - Scheduling

  /** Called whenever new readings land. */
  markDirty() {
    this.dirty = true;
  }

  start() {
    if (this.timer !== null) return;

    // Catch up on anything the last session couldn't send before it closed.
    if (this.endpoint && this.posture.samples.length > 0) {
      this.syncNow({ silent: true });
    }

    this.timer = setInterval(() => {
      if (this.dirty) this.syncNow({ silent: true });
    }, SYNC_INTERVAL_MINUTES * 60000);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  // MARK: - Payload

  buildPayload() {
    const days = this.posture.dailyBreakdown(SYNC_WINDOW_DAYS)
      .filter((day) => day.hasData)
      .map((day) => ({
        date: isoDate(day.day),
        samples: day.sampleCount,
        minutes: round(day.wornMinutes, 1),
        avgAngle: round(day.averageAngle, 2),
        goodShare: round(day.goodShare, 4),
        leftShare: round(day.leftShare, 4),
        rightShare: round(day.rightShare, 4),
      }));

    // One row per reading: who, when, how far, and the traffic light. Ten
    // seconds apart, so only what is new since the last successful sync goes
    // up — resending a fortnight every few minutes would be tens of thousands
    // of rows for no gain.
    const since = readJSON(scopedHighWater(this.profile.id));
    const readings = this.posture.samplesSince(since).map((sample) => ({
      at: sample.date.toISOString(),
      date: isoDate(sample.date),
      time: clockTime(sample.date),
      angle: round(sample.angle, 1),
      quality: qualityLabel(sample.angle),
    }));

    return {
      version: 2,
      sentAt: new Date().toISOString(),
      readings,
      profile: {
        id: this.profile.id,
        name: this.profile.name,
        email: this.profile.email,
        createdAt: this.profile.createdAt,
      },
      streak: this.posture.streak,
      longestStreak: this.posture.longestStreak,
      calibratedAt: this.posture.calibration?.date?.toISOString() ?? null,
      device: {
        mode: this.device?.isDemo ? 'demo' : 'live',
        battery: this.device?.battery ?? null,
      },
      days,
    };
  }

  // MARK: - Sending

  async syncNow({ silent = false } = {}) {
    const endpoint = this.endpoint;
    if (!endpoint) {
      this.status = SheetSync.Status.unconfigured;
      this.emit();
      return { ok: false, message: 'No sheet connected yet.' };
    }

    const payload = this.buildPayload();
    if (payload.days.length === 0 && payload.readings.length === 0) {
      this.message = 'Nothing recorded to send yet.';
      this.status = SheetSync.Status.idle;
      this.emit();
      return { ok: false, message: this.message };
    }

    this.status = SheetSync.Status.syncing;
    if (!silent) this.emit();

    try {
      const result = await post(endpoint, payload);
      this.dirty = false;
      writeJSON(LAST_SYNC_KEY, new Date().toISOString());
      // Only advance once the sheet has confirmed the write, or a failed sync
      // would silently drop the readings it was carrying.
      const newest = payload.readings[payload.readings.length - 1];
      if (newest) writeJSON(scopedHighWater(this.profile.id), newest.at);
      this.status = SheetSync.Status.ok;
      this.message = result.rows
        ? `${result.rows} row${result.rows === 1 ? '' : 's'} written.`
        : `${payload.readings.length} reading${payload.readings.length === 1 ? '' : 's'} sent.`;
      this.emit();
      return { ok: true, message: this.message };
    } catch (error) {
      this.status = SheetSync.Status.error;
      this.message = error?.message ?? 'Could not reach the sheet.';
      this.emit();
      return { ok: false, message: this.message };
    }
  }

  /** Last-gasp send when the page is closing; the response is never read. */
  flush() {
    const endpoint = this.endpoint;
    if (!endpoint || !this.dirty) return;
    const payload = this.buildPayload();
    if (payload.days.length === 0 && payload.readings.length === 0) return;

    try {
      // text/plain keeps this a simple request, which Apps Script accepts
      // without a CORS preflight.
      const blob = new Blob([JSON.stringify(payload)], { type: 'text/plain;charset=utf-8' });
      navigator.sendBeacon?.(endpoint, blob);
    } catch {
      // Nothing more we can do on the way out.
    }
  }
}

async function post(endpoint, payload) {
  const body = JSON.stringify(payload);
  const headers = { 'Content-Type': 'text/plain;charset=utf-8' };

  try {
    const response = await fetch(endpoint, { method: 'POST', headers, body, redirect: 'follow' });
    if (!response.ok) throw new Error(`Sheet replied ${response.status}`);
    const text = await response.text();
    try {
      const result = JSON.parse(text);
      if (result.ok === false) throw new Error(result.error ?? 'The sheet rejected the data.');
      return result;
    } catch {
      return {};
    }
  } catch (error) {
    // Some Apps Script deployments answer without CORS headers, which fails the
    // read even though the write succeeded. Resend opaquely so the row lands.
    if (error instanceof TypeError) {
      await fetch(endpoint, { method: 'POST', mode: 'no-cors', headers, body });
      return {};
    }
    throw error;
  }
}

/** A deployed Apps Script web app, as opposed to a spreadsheet or docs link. */
function isAppsScriptEndpoint(url) {
  return /^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec/.test(url);
}

function isoDate(date) {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

function round(value, places) {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

/** The high-water mark is per profile, like everything else stored. */
function scopedHighWater(profileId) {
  return `${HIGH_WATER_KEY}:${profileId}`;
}

/** Local wall-clock time, which is what a person reading the sheet wants. */
function clockTime(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
