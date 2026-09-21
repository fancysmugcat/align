/**
 * Sample history persistence.
 *
 * A year of wear is a lot of rows for localStorage (5 MB), so history goes to
 * IndexedDB as three packed typed arrays — timestamps, angles and rolls —
 * which structured clone stores compactly. localStorage is the fallback when
 * IndexedDB is unavailable (private windows, old browsers).
 */

const DB_NAME = 'align';
const STORE = 'kv';
const LEGACY_HISTORY_KEY = 'history';
const LEGACY_LOCAL_KEY = 'align.history';

/** History is stored per profile: `history:<profile id>`. */
function historyKey(profileId) {
  return profileId ? `${LEGACY_HISTORY_KEY}:${profileId}` : LEGACY_HISTORY_KEY;
}

function localHistoryKey(profileId) {
  return profileId ? `${LEGACY_LOCAL_KEY}:${profileId}` : LEGACY_LOCAL_KEY;
}

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!('indexedDB' in globalThis)) {
      reject(new Error('IndexedDB unavailable'));
      return;
    }
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) {
        request.result.createObjectStore(STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  }).catch((error) => {
    dbPromise = null;
    throw error;
  });
  return dbPromise;
}

function idbRequest(mode, work) {
  return openDB().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const request = work(tx.objectStore(STORE));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  }));
}

/** Samples -> {t, a, r} typed arrays. */
function pack(samples) {
  const count = samples.length;
  const t = new Float64Array(count);
  const a = new Float32Array(count);
  const r = new Float32Array(count);
  for (let i = 0; i < count; i += 1) {
    t[i] = samples[i].date.getTime();
    a[i] = samples[i].angle;
    r[i] = samples[i].roll;
  }
  return { t, a, r };
}

function unpack(packed) {
  if (!packed || !packed.t) return [];
  const samples = [];
  for (let i = 0; i < packed.t.length; i += 1) {
    samples.push({ date: new Date(packed.t[i]), angle: packed.a[i], roll: packed.r[i] });
  }
  return samples;
}

export async function loadSamples(profileId) {
  try {
    return unpack(await idbRequest('readonly', (store) => store.get(historyKey(profileId))));
  } catch {
    try {
      const raw = localStorage.getItem(localHistoryKey(profileId));
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return unpack({
        t: parsed.t ?? [],
        a: parsed.a ?? [],
        r: parsed.r ?? [],
      });
    } catch {
      return [];
    }
  }
}

export async function saveSamples(samples, profileId) {
  const packed = pack(samples);
  try {
    await idbRequest('readwrite', (store) => store.put(packed, historyKey(profileId)));
  } catch {
    try {
      localStorage.setItem(localHistoryKey(profileId), JSON.stringify({
        t: Array.from(packed.t),
        a: Array.from(packed.a, (value) => Math.round(value * 100) / 100),
        r: Array.from(packed.r, (value) => Math.round(value * 100) / 100),
      }));
    } catch {
      // Out of quota — history stays in memory for this session only.
    }
  }
}

export async function clearSamples(profileId) {
  try {
    await idbRequest('readwrite', (store) => store.delete(historyKey(profileId)));
  } catch {
    // Ignore, the localStorage copy is removed below regardless.
  }
  try {
    localStorage.removeItem(localHistoryKey(profileId));
  } catch {
    // Ignore.
  }
}

/**
 * History written before profiles existed sits under the unscoped key. The
 * first profile to sign in adopts it, so nobody loses their streak.
 */
export async function adoptLegacyHistory(profileId) {
  const legacy = await loadSamples(null);
  if (legacy.length === 0) return false;
  await saveSamples(legacy, profileId);
  await clearSamples(null);
  return true;
}

/** Small values (calibration, preferences) live in localStorage. */
export function readJSON(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/**
 * @returns {boolean} whether it actually stuck.
 *
 * Failures used to be swallowed outright, so a browser refusing storage —
 * private browsing, a full quota, an app that clears site data between
 * launches — looked exactly like a successful save. Signing in appeared to
 * work and the profile was simply gone on the next visit, with nothing said.
 */
export function writeJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function removeKey(key) {
  try {
    localStorage.removeItem(key);
  } catch {
    // Ignore.
  }
}
