import { readJSON, writeJSON } from './storage.js';
import { scoped } from './profile.js';

const BUZZ_KEY = 'align.buzzInterval';
const FEEDBACK_KEY = 'align.feedbackURL';
const SWAP_SIDES_KEY = 'align.swapSides';

/** Where the "Any Issues?" link points. Replace with your own form. */
export const DEFAULT_FEEDBACK_URL = 'https://forms.gle/Qm7nZAyVtLU3f4Kc7';

/** User preferences, persisted in localStorage. */
export class SettingsStore {
  constructor(profileId) {
    this.buzzKey = scoped(BUZZ_KEY, profileId);

    this.swapKey = scoped(SWAP_SIDES_KEY, profileId);

    const storedBuzz = readJSON(this.buzzKey);
    this._buzzInterval = [0, 1, 2, 5].includes(storedBuzz) ? storedBuzz : 2;
    this.feedbackURL = readJSON(FEEDBACK_KEY) ?? DEFAULT_FEEDBACK_URL;

    // Which way round left and right are depends on which way the sensor ended
    // up facing when the band was assembled, and that has changed more than
    // once on this hardware. Guessing it in firmware costs a reflash each time
    // and can only ever be right for one build, so it is a switch the wearer
    // can throw in one tap.
    this._swapSides = readJSON(this.swapKey) === true;

    /** Called whenever the buzz setting changes so it can be pushed to the device. */
    this.onBuzzChange = null;
    /** Called when left/right is flipped, so the store can re-read live data. */
    this.onSwapSidesChange = null;
    this.listeners = new Set();
  }

  get buzzInterval() {
    return this._buzzInterval;
  }

  set buzzInterval(value) {
    if (value === this._buzzInterval) return;
    this._buzzInterval = value;
    writeJSON(this.buzzKey, value);
    this.onBuzzChange?.(value);
    this.listeners.forEach((listener) => listener(this));
  }

  get swapSides() {
    return this._swapSides;
  }

  set swapSides(value) {
    const next = value === true;
    if (next === this._swapSides) return;
    this._swapSides = next;
    writeJSON(this.swapKey, next);
    this.onSwapSidesChange?.(next);
    this.listeners.forEach((listener) => listener(this));
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
