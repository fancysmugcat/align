import { readJSON, writeJSON } from './storage.js';
import { scoped } from './profile.js';

const BUZZ_KEY = 'align.buzzInterval';
const FEEDBACK_KEY = 'align.feedbackURL';

/** Where the "Any Issues?" link points. Replace with your own form. */
export const DEFAULT_FEEDBACK_URL = 'https://forms.gle/Qm7nZAyVtLU3f4Kc7';

/** User preferences, persisted in localStorage. */
export class SettingsStore {
  constructor(profileId) {
    this.buzzKey = scoped(BUZZ_KEY, profileId);

    const storedBuzz = readJSON(this.buzzKey);
    this._buzzInterval = [0, 1, 2, 5].includes(storedBuzz) ? storedBuzz : 2;
    this.feedbackURL = readJSON(FEEDBACK_KEY) ?? DEFAULT_FEEDBACK_URL;

    /** Called whenever the buzz setting changes so it can be pushed to the device. */
    this.onBuzzChange = null;
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

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
