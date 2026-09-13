import { Theme } from './theme.js';

// MARK: - Posture zone

/** How far the user has deviated from their calibrated upright angle. */
export const PostureZone = {
  good: {
    id: 'good',
    color: Theme.zoneGood,
    verdict: 'Good posture',
    advice: "You're aligned — keep it up.",
    bandLabel: '0 - 10°',
    isGood: true,
  },
  fair: {
    id: 'fair',
    color: Theme.zoneFair,
    verdict: 'Slightly off',
    advice: "You're drifting a little. Ease back upright.",
    bandLabel: '11 - 20°',
    isGood: false,
  },
  poor: {
    id: 'poor',
    color: Theme.zonePoor,
    verdict: 'Bad posture',
    advice: "You're slouching. Straighten your back.",
    bandLabel: '21 - 30°',
    isGood: false,
  },
  bad: {
    id: 'bad',
    color: Theme.zoneBad,
    verdict: 'Bad posture',
    advice: "Sit up — you're well past your upright angle.",
    bandLabel: '30° Above',
    isGood: false,
  },
};

/**
 * Where "Slightly off" becomes "Bad posture". The board buzzes at exactly this
 * angle too — it's pushed over BLE with the buzz duration so the vibration and
 * the on-screen verdict can never disagree.
 */
export const BAD_POSTURE_ANGLE = 20.5;

export function zoneFor(angle) {
  if (angle < 10.5) return PostureZone.good;
  if (angle < BAD_POSTURE_ANGLE) return PostureZone.fair;
  if (angle < 30.5) return PostureZone.poor;
  return PostureZone.bad;
}

// MARK: - Lean

export const LeanSide = { left: 'left', right: 'right', center: 'center' };

/** Below this many degrees of roll we consider the user centered. */
export const LEAN_THRESHOLD = 4;

export function leanFor(roll) {
  if (roll <= -LEAN_THRESHOLD) return LeanSide.left;
  if (roll >= LEAN_THRESHOLD) return LeanSide.right;
  return LeanSide.center;
}

// MARK: - Ranges

export const HistoryRange = {
  today: { id: 'today', label: 'Today', days: 1, shortLabel: '1D', intraday: true },
  week: { id: 'week', label: 'Past 1 Week', days: 7, shortLabel: '1W' },
  twoWeeks: { id: 'twoWeeks', label: 'Past 2 Weeks', days: 14, shortLabel: '2W' },
  month: { id: 'month', label: 'Past 1 Month', days: 30, shortLabel: '1M' },
};

export const ALL_RANGES = [
  HistoryRange.today, HistoryRange.week, HistoryRange.twoWeeks, HistoryRange.month,
];

/**
 * How wide a bucket is on the "Today" chart. Fine enough to show posture
 * drifting across a morning, coarse enough that a full day still fits the plot.
 */
export const INTRADAY_BUCKET_MINUTES = 15;

// MARK: - Buzz

/** Haptic feedback the ALIGN device gives when posture goes bad. */
export const BUZZ_INTERVALS = [0, 1, 2, 5];

export function buzzLabel(seconds) {
  return seconds === 0 ? 'OFF' : `${seconds}s`;
}

export function buzzDetail(seconds) {
  if (seconds === 0) return 'ALIGN will not buzz when your posture slips.';
  return `ALIGN buzzes for ${seconds} second${seconds === 1 ? '' : 's'} when you slouch past your upright angle.`;
}

// MARK: - Dates
// The streak row runs Monday...Sunday, matching the design.

export function startOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

export function addDays(date, count) {
  const d = new Date(date);
  d.setDate(d.getDate() + count);
  return d;
}

export function startOfWeek(date) {
  const d = startOfDay(date);
  // getDay(): 0 = Sunday. Shift so Monday is the first weekday.
  const offset = (d.getDay() + 6) % 7;
  return addDays(d, -offset);
}

export function isSameDay(a, b) {
  return a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate();
}

export function isToday(date) {
  return isSameDay(date, new Date());
}
