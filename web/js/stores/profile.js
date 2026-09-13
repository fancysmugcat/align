import { readJSON, writeJSON, removeKey, adoptLegacyHistory } from './storage.js';

/**
 * Who is wearing the device. Several people can share one browser — each gets
 * their own calibration, history and preferences, kept apart by scoping every
 * storage key with the profile id.
 */

const PROFILES_KEY = 'align.profiles';
const ACTIVE_KEY = 'align.activeProfile';

/** Storage key for a per-profile value. */
export function scoped(key, profileId) {
  return `${key}:${profileId}`;
}

export function listProfiles() {
  const stored = readJSON(PROFILES_KEY);
  return Array.isArray(stored) ? stored : [];
}

export function activeProfile() {
  const id = readJSON(ACTIVE_KEY);
  if (!id) return null;
  return listProfiles().find((profile) => profile.id === id) ?? null;
}

export function createProfile({ name, email = '' }) {
  const profile = {
    id: newId(),
    name: name.trim(),
    email: email.trim(),
    createdAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
  };
  const profiles = listProfiles();
  profiles.push(profile);
  writeJSON(PROFILES_KEY, profiles);
  return profile;
}

export function signIn(profileId) {
  writeJSON(ACTIVE_KEY, profileId);
  touchProfile(profileId);
}

export function signOut() {
  removeKey(ACTIVE_KEY);
}

export function touchProfile(profileId) {
  const profiles = listProfiles();
  const profile = profiles.find((entry) => entry.id === profileId);
  if (!profile) return;
  profile.lastSeenAt = new Date().toISOString();
  writeJSON(PROFILES_KEY, profiles);
}

/** Forgets a profile and everything stored under it. */
export function deleteProfile(profileId) {
  writeJSON(PROFILES_KEY, listProfiles().filter((profile) => profile.id !== profileId));
  if (readJSON(ACTIVE_KEY) === profileId) removeKey(ACTIVE_KEY);
}

/**
 * Data written before profiles existed sits under unscoped keys. The first
 * profile created adopts it, so an existing user keeps their streak.
 */
export async function adoptLegacyData(profileId) {
  if (listProfiles().length > 1) return false;

  let adopted = await adoptLegacyHistory(profileId);

  const calibration = readJSON('align.calibration');
  if (calibration) {
    writeJSON(scoped('align.calibration', profileId), calibration);
    removeKey('align.calibration');
    adopted = true;
  }

  const buzz = readJSON('align.buzzInterval');
  if (buzz !== null) {
    writeJSON(scoped('align.buzzInterval', profileId), buzz);
    removeKey('align.buzzInterval');
  }

  return adopted;
}

function newId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function initials(profile) {
  const parts = (profile?.name ?? '').split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
