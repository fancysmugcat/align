import { readJSON, writeJSON } from './storage.js';
import { BUZZ_INTERVALS, SENSITIVITY } from '../models.js';
import { scoped } from './profile.js';

const BUZZ_KEY = 'align.buzzInterval';
const FEEDBACK_KEY = 'align.feedbackURL';
const SWAP_SIDES_KEY = 'align.swapSides';
const BUZZ_BOTH_KEY = 'align.buzzBoth';
const SENSITIVITY_KEY = 'align.sensitivity';

/** Where the "Any Issues?" link points. Replace with your own form. */
export const DEFAULT_FEEDBACK_URL = 'https://forms.gle/Qm7nZAyVtLU3f4Kc7';

/** User preferences, persisted in localStorage. */
export class SettingsStore {
  constructor(profileId) {
    this.buzzKey = scoped(BUZZ_KEY, profileId);

    this.swapKey = scoped(SWAP_SIDES_KEY, profileId);

    // 5s is gone and 0.5s is new, so an old preference is carried across
    // rather than silently reset: the longest setting stays the longest.
    const storedBuzz = readJSON(this.buzzKey);
    const migrated = storedBuzz === 5 ? 2 : storedBuzz;
    this._buzzInterval = BUZZ_INTERVALS.includes(migrated) ? migrated : 1;
    this.feedbackURL = readJSON(FEEDBACK_KEY) ?? DEFAULT_FEEDBACK_URL;

    // Which way round left and right are depends on which way the sensor ended
    // up facing when the band was assembled, and that has changed more than
    // once on this hardware. Guessing it in firmware costs a reflash each time
    // and can only ever be right for one build, so it is a switch the wearer
    // can throw in one tap.
    this._swapSides = readJSON(this.swapKey) === true;

    // With one motor dead or unwired, half the corrections go unfelt. Firing
    // both loses the direction but not the warning, which is the better half
    // to keep.
    this.buzzBothKey = scoped(BUZZ_BOTH_KEY, profileId);
    this._buzzBoth = readJSON(this.buzzBothKey) === true;

    this.sensitivityKey = scoped(SENSITIVITY_KEY, profileId);
    const storedLevel = readJSON(this.sensitivityKey);
    this._sensitivity = SENSITIVITY[storedLevel] ? storedLevel : 'normal';

    /** Called whenever the buzz setting changes so it can be pushed to the device. */
    this.onBuzzChange = null;
    /** Called when left/right is flipped, so the store can re-read live data. */
    this.onSwapSidesChange = null;
    /** Called when both-motor buzzing is toggled, so the board can be told. */
    this.onBuzzBothChange = null;
    /** Called when sensitivity changes; the board's own filter follows it. */
    this.onSensitivityChange = null;
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

  /** The chosen preset object, never just its name. */
  get sensitivity() {
    return SENSITIVITY[this._sensitivity] ?? SENSITIVITY.normal;
  }

  set sensitivity(level) {
    const id = level?.id ?? level;
    if (!SENSITIVITY[id] || id === this._sensitivity) return;
    this._sensitivity = id;
    writeJSON(this.sensitivityKey, id);
    this.onSensitivityChange?.(this.sensitivity);
    this.listeners.forEach((listener) => listener(this));
  }

  get buzzBoth() {
    return this._buzzBoth;
  }

  set buzzBoth(value) {
    const next = value === true;
    if (next === this._buzzBoth) return;
    this._buzzBoth = next;
    writeJSON(this.buzzBothKey, next);
    this.onBuzzBothChange?.(next);
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
