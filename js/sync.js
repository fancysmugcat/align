import { SHEET_WEB_APP_URL, SHEET_URL, SYNC_INTERVAL_MINUTES, SYNC_WINDOW_DAYS } from './config.js';
import { readJSON, writeJSON, removeKey } from './stores/storage.js';

const ENDPOINT_KEY = 'align.sheetEndpoint';
const LAST_SYNC_KEY = 'align.lastSync';

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

    // Settings used to offer a field for this. Anything it left behind could be
    // any URL at all — including the spreadsheet's own, which can't accept
    // posts — so the stored value is dropped and config.js is the only source.
    removeKey(ENDPOINT_KEY);

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
  get endpoint() {
    return (SHEET_WEB_APP_URL ?? '').trim();
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

    return {
      version: 1,
      sentAt: new Date().toISOString(),
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
    if (payload.days.length === 0) {
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
      this.status = SheetSync.Status.ok;
      this.message = result.rows ? `${result.rows} day${result.rows === 1 ? '' : 's'} written.` : '';
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
    if (payload.days.length === 0) return;

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
