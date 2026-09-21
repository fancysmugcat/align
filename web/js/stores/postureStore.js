import {
  zoneFor, leanFor, LeanSide, INTRADAY_BUCKET_MINUTES,
  startOfDay, startOfWeek, addDays, isSameDay, isToday,
} from '../models.js';
import { loadSamples, saveSamples, clearSamples, readJSON, writeJSON, removeKey } from './storage.js';
import { scoped } from './profile.js';

/**
 * Owns calibration, the rolling sample history, and every derived statistic the
 * home screen shows (current angle, streak, progress chart, lean bias).
 */
/**
 * Bumped whenever the firmware changes what pitch and roll mean — a different
 * axis, or a flipped sign. Baselines recorded under an older convention are
 * discarded on load, because subtracting one from a new reading produces a
 * confident, completely wrong answer.
 *
 * 2: roll moved from the X axis to the Y axis, so it measures sideways lean
 *    rather than forward slouch.
 */
const SENSOR_VERSION = 2;

export class PostureStore {
  // MARK: Tuning

  /** How often a reading is committed to history. Live UI still updates at the
   *  device's full rate; this only limits what we persist. */
  static sampleInterval = 10; // seconds
  /** A day counts toward the streak once the device has been worn this long. */
  static minimumWearMinutes = 10;
  /** History older than this is pruned on load. */
  static retentionDays = 60;

  constructor(profileId) {
    /** Every stored value is namespaced so profiles can't see each other's data. */
    this.profileId = profileId;
    this.calibrationKey = scoped('align.calibration', profileId);

    /** Latest reading, updated live from the device. */
    this.current = null;
    /** Persisted history, oldest first. */
    this.samples = [];
    /** Upright reference captured during calibration: {pitch, roll, date}. */
    this.calibration = null;

    this.lastCommitted = 0;
    this.unsavedCount = 0;
    this.liveListeners = new Set();
    this.dataListeners = new Set();
  }

  // MARK: - Subscriptions
  // Live readings arrive ~10x a second, so the gauge listens separately from the
  // cards that only change when history or calibration does.

  onLive(listener) {
    this.liveListeners.add(listener);
    return () => this.liveListeners.delete(listener);
  }

  onData(listener) {
    this.dataListeners.add(listener);
    return () => this.dataListeners.delete(listener);
  }

  emitLive() {
    this.liveListeners.forEach((listener) => listener(this));
  }

  emitData() {
    this.dataListeners.forEach((listener) => listener(this));
  }

  // MARK: - Loading

  async load() {
    this.calibration = this.loadCalibration();
    const stored = await loadSamples(this.profileId);
    const cutoff = addDays(new Date(), -PostureStore.retentionDays).getTime();
    this.samples = stored
      .filter((sample) => sample.date.getTime() >= cutoff)
      .sort((a, b) => a.date - b.date);
    this.emitData();
  }

  /** Set from SettingsStore; flips which side a lean is reported on. */
  swapSides = false;

  get isCalibrated() {
    return this.calibration !== null;
  }

  /** Angle to display on the gauge. Zero until the first reading arrives. */
  get currentAngle() {
    return this.current ? this.current.angle : 0;
  }

  get currentZone() {
    return zoneFor(this.currentAngle);
  }

  // MARK: - Ingest

  /** Feeds a raw device reading through calibration and into history. */
  ingest(reading) {
    if (!this.calibration) return;

    // Applied here and nowhere else, so the gauge, the lean row and the weekly
    // bias can never disagree about which side you are on.
    const rollDelta = (reading.roll - this.calibration.roll) * (this.swapSides ? -1 : 1);
    // Sideways lean only. This used to combine pitch and roll into one total
    // tilt, which meant the number could climb while the wearer hadn't leaned
    // at all — and the gauge, which shows direction on a left-right arc, had
    // no way to place a forward slouch. Measuring the one axis the display can
    // actually express keeps the number and the knob describing the same
    // thing.
    const angle = Math.abs(rollDelta);

    const sample = { date: reading.timestamp, angle, roll: rollDelta };
    this.current = sample;
    this.emitLive();

    if ((sample.date.getTime() - this.lastCommitted) / 1000 >= PostureStore.sampleInterval) {
      this.lastCommitted = sample.date.getTime();
      this.samples.push(sample);
      this.unsavedCount += 1;
      this.emitData();
      if (this.unsavedCount >= 30) this.save();
    }
  }

  /** Captures the user's upright posture as the baseline for every future reading. */
  calibrate(reading) {
    this.calibration = { pitch: reading.pitch, roll: reading.roll, date: new Date() };
    this.current = { date: new Date(), angle: 0, roll: 0 };
    writeJSON(this.calibrationKey, {
      pitch: this.calibration.pitch,
      roll: this.calibration.roll,
      date: this.calibration.date.toISOString(),
      sensorVersion: SENSOR_VERSION,
    });
    this.emitData();
    this.emitLive();
  }

  clearCalibration() {
    this.calibration = null;
    this.current = null;
    removeKey(this.calibrationKey);
    this.emitData();
    this.emitLive();
  }

  loadCalibration() {
    const stored = readJSON(this.calibrationKey);
    if (!stored || typeof stored.pitch !== 'number' || typeof stored.roll !== 'number') return null;
    // A baseline is only meaningful against the sensor convention it was taken
    // under. When the firmware's axes changed, every stored baseline silently
    // became a constant offset instead — the wearer sat upright and the site
    // insisted they were leaning. Old ones are dropped so the calibration
    // banner comes back rather than the numbers quietly lying.
    if (stored.sensorVersion !== SENSOR_VERSION) return null;
    return { pitch: stored.pitch, roll: stored.roll, date: new Date(stored.date) };
  }

  // MARK: - Derived: daily summaries

  /**
   * One entry per day for the last `days` days, oldest first. Days with no data
   * are included with zero samples so the chart keeps a real time axis.
   */
  dailySummaries(days) {
    const today = startOfDay(new Date());
    const start = addDays(today, -(days - 1));
    const startTime = start.getTime();

    const buckets = new Map();
    for (const sample of this.samples) {
      if (sample.date.getTime() < startTime) continue;
      const key = startOfDay(sample.date).getTime();
      const bucket = buckets.get(key) ?? { sum: 0, count: 0 };
      bucket.sum += sample.angle;
      bucket.count += 1;
      buckets.set(key, bucket);
    }

    const summaries = [];
    for (let offset = 0; offset < days; offset += 1) {
      const day = addDays(start, offset);
      const bucket = buckets.get(day.getTime()) ?? { sum: 0, count: 0 };
      const averageAngle = bucket.count > 0 ? bucket.sum / bucket.count : 0;
      const wornMinutes = (bucket.count * PostureStore.sampleInterval) / 60;
      summaries.push({
        day,
        averageAngle,
        sampleCount: bucket.count,
        wornMinutes,
        worn: wornMinutes >= PostureStore.minimumWearMinutes,
        hasData: bucket.count > 0,
      });
    }
    return summaries;
  }

  /**
   * Today split into fifteen-minute buckets, midnight to midnight, oldest
   * first. Same shape as `dailySummaries` so the chart can draw either — `day`
   * is the start of the bucket rather than the start of a day. Empty buckets
   * are kept so the axis stays a real clock, and `worn` simply means the band
   * was recording during that slot.
   */
  intradaySummaries(range = { bucketMinutes: INTRADAY_BUCKET_MINUTES }) {
    const bucketMs = (range.bucketMinutes ?? INTRADAY_BUCKET_MINUTES) * 60000;

    // A rolling window ends now, so its buckets are anchored to the current
    // minute rather than to midnight — otherwise the last bucket would be a
    // part-finished one whose average kept changing shape as it filled.
    let startTime;
    let bucketCount;
    if (range.rolling) {
      const windowMs = (range.windowMinutes ?? 60) * 60000;
      bucketCount = Math.round(windowMs / bucketMs);
      const end = Math.ceil(Date.now() / bucketMs) * bucketMs;
      startTime = end - bucketCount * bucketMs;
    } else {
      startTime = startOfDay(new Date()).getTime();
      bucketCount = Math.round(86400000 / bucketMs);
    }

    const buckets = new Map();
    for (const sample of this.samples) {
      const index = Math.floor((sample.date.getTime() - startTime) / bucketMs);
      if (index < 0 || index >= bucketCount) continue;
      const bucket = buckets.get(index) ?? { sum: 0, count: 0 };
      bucket.sum += sample.angle;
      bucket.count += 1;
      buckets.set(index, bucket);
    }

    const summaries = [];
    for (let index = 0; index < bucketCount; index += 1) {
      const bucket = buckets.get(index) ?? { sum: 0, count: 0 };
      summaries.push({
        day: new Date(startTime + index * bucketMs),
        averageAngle: bucket.count > 0 ? bucket.sum / bucket.count : 0,
        sampleCount: bucket.count,
        wornMinutes: (bucket.count * PostureStore.sampleInterval) / 60,
        worn: bucket.count > 0,
        hasData: bucket.count > 0,
      });
    }
    return summaries;
  }

  summaries(range) {
    return range.intraday ? this.intradaySummaries(range) : this.dailySummaries(range.days);
  }

  /**
   * Daily rollups with the extra columns the spreadsheet wants: what share of
   * the day was good posture, and how it split left versus right.
   */
  dailyBreakdown(days) {
    const summaries = this.dailySummaries(days);
    const buckets = new Map();

    const first = summaries[0]?.day.getTime() ?? Infinity;
    for (const sample of this.samples) {
      if (sample.date.getTime() < first) continue;
      const key = startOfDay(sample.date).getTime();
      const bucket = buckets.get(key) ?? { good: 0, left: 0, right: 0 };
      if (zoneFor(sample.angle).isGood) bucket.good += 1;
      const side = leanFor(sample.roll);
      if (side === LeanSide.left) bucket.left += 1;
      else if (side === LeanSide.right) bucket.right += 1;
      buckets.set(key, bucket);
    }

    return summaries.map((summary) => {
      const bucket = buckets.get(summary.day.getTime()) ?? { good: 0, left: 0, right: 0 };
      const offCentre = bucket.left + bucket.right;
      return {
        ...summary,
        goodShare: summary.sampleCount > 0 ? bucket.good / summary.sampleCount : 0,
        leftShare: offCentre > 0 ? bucket.left / offCentre : 0,
        rightShare: offCentre > 0 ? bucket.right / offCentre : 0,
      };
    });
  }

  /** Average deviation across the range, ignoring days with no wear. */
  averageAngle(range) {
    const worn = this.summaries(range).filter((day) => day.hasData);
    if (worn.length === 0) return null;
    return worn.reduce((total, day) => total + day.averageAngle, 0) / worn.length;
  }

  /** Share of samples in the range that were good posture, 0...1. */
  goodShare(range) {
    const window = this.samplesWithin(range);
    if (window.length === 0) return null;
    return window.filter((sample) => zoneFor(sample.angle).isGood).length / window.length;
  }

  samplesWithin(range) {
    // "Today" means since midnight, not a rolling 24 hours — otherwise the
    // card would still be counting last night's samples this morning. A
    // rolling range is the opposite: exactly the last N minutes, ending now.
    let cutoff;
    if (range.rolling) cutoff = Date.now() - (range.windowMinutes ?? 60) * 60000;
    else if (range.intraday) cutoff = startOfDay(new Date()).getTime();
    else cutoff = addDays(new Date(), -range.days).getTime();
    return this.samples.filter((sample) => sample.date.getTime() >= cutoff);
  }

  // MARK: - Derived: streak

  /** The seven days of the current week (Mon...Sun) with wear flags. */
  currentWeek() {
    const today = startOfDay(new Date());
    const weekStart = startOfWeek(today);
    const elapsed = Math.round((today - weekStart) / 86400000);
    const all = this.dailySummaries(Math.max(elapsed + 1, 1) + 6);

    const week = [];
    for (let offset = 0; offset < 7; offset += 1) {
      const day = addDays(weekStart, offset);
      const match = all.find((summary) => isSameDay(summary.day, day));
      week.push(match ?? {
        day, averageAngle: 0, sampleCount: 0, wornMinutes: 0, worn: false, hasData: false,
      });
    }
    return week;
  }

  /**
   * Consecutive days worn, counting back from today. Today not yet worn does
   * not break a streak that ran through yesterday.
   */
  get streak() {
    const summaries = this.dailySummaries(PostureStore.retentionDays).slice().reverse();
    let count = 0;
    let skippedToday = false;
    for (const day of summaries) {
      if (day.worn) {
        count += 1;
      } else if (!skippedToday && isToday(day.day)) {
        skippedToday = true; // grace for the day still in progress
      } else {
        break;
      }
    }
    return count;
  }

  get longestStreak() {
    let best = 0;
    let running = 0;
    for (const day of this.dailySummaries(PostureStore.retentionDays)) {
      running = day.worn ? running + 1 : 0;
      best = Math.max(best, running);
    }
    return best;
  }

  // MARK: - Derived: lean bias

  leanBias(range) {
    const window = this.samplesWithin(range);
    let left = 0;
    let right = 0;
    for (const sample of window) {
      const side = leanFor(sample.roll);
      if (side === LeanSide.left) left += 1;
      else if (side === LeanSide.right) right += 1;
    }
    const total = left + right;

    if (total === 0) {
      return { leftShare: 0.5, rightShare: 0.5, dominant: LeanSide.center, sampleCount: 0, imbalance: 0 };
    }

    const leftShare = left / total;
    const rightShare = 1 - leftShare;
    const imbalance = Math.abs(leftShare - rightShare);
    const dominant = imbalance < 0.06
      ? LeanSide.center
      : (leftShare > rightShare ? LeanSide.left : LeanSide.right);

    return { leftShare, rightShare, dominant, sampleCount: total, imbalance };
  }

  // MARK: - Persistence

  save() {
    this.unsavedCount = 0;
    saveSamples(this.samples.slice(), this.profileId);
  }

  /** Wipes history and calibration. Used by Settings. */
  async resetAll() {
    this.samples = [];
    this.current = null;
    this.lastCommitted = 0;
    this.unsavedCount = 0;
    await clearSamples(this.profileId);
    this.clearCalibration();
    this.emitData();
  }

  // MARK: - Demo data

  /**
   * Fills the history with plausible data so the charts can be reviewed without
   * a device. Only reachable from Settings.
   */
  loadSampleData() {
    const generated = [];
    const today = startOfDay(new Date());
    const now = Date.now();

    for (let dayOffset = 34; dayOffset >= 0; dayOffset -= 1) {
      // A couple of skipped days so the streak logic is visible.
      if (dayOffset === 12 || dayOffset === 19) continue;
      const day = addDays(today, -dayOffset);

      const drift = (dayOffset % 7) * 1.4;
      const base = 9 + drift + Math.sin(dayOffset / 3) * 4;
      const sideBias = dayOffset % 5 === 0 ? -1 : 1;

      for (let minute = 0; minute < 8 * 60; minute += 2) {
        const stamp = new Date(day.getTime() + (9 * 60 + minute) * 60000);
        if (stamp.getTime() > now) continue;
        const wobble = Math.sin(minute / 17) * 6 + Math.cos(minute / 5) * 3;
        const angle = Math.max(0.5, base + wobble);
        const roll = sideBias * (Math.abs(wobble) * 0.6 + 2);
        generated.push({ date: stamp, angle, roll });
      }
    }

    this.samples = generated.sort((a, b) => a.date - b.date);
    if (!this.calibration) {
      this.calibration = { pitch: 0, roll: 0, date: today };
      writeJSON(this.calibrationKey, { pitch: 0, roll: 0, date: today.toISOString() });
    }
    this.current = this.samples[this.samples.length - 1] ?? null;
    this.save();
    this.emitData();
    this.emitLive();
  }
}
