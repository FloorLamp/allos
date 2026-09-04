import { AsyncLocalStorage } from "node:async_hooks";
import { db, hoistedStatement, invalidateTimezoneMemo } from "../db";

interface SettingReadCache {
  global: Map<string, string | undefined>;
  profile: Map<string, string | undefined>;
  login: Map<string, string | undefined>;
  globalLoaded: boolean;
  loadedProfiles: Set<number>;
  loadedLogins: Set<number>;
}

const settingReadCache = new AsyncLocalStorage<SettingReadCache>();

// PROBE-5012 (temporary): how many times has THIS module been instantiated in
// this process, and which instance is this one? Rules out the dev-bundler
// module-duplication explanation for a scope that reads as closed.
const PROBE_MODULE_INSTANCE: number = (() => {
  const g = globalThis as unknown as { __probe5012Kv?: number };
  g.__probe5012Kv = (g.__probe5012Kv ?? 0) + 1;
  return g.__probe5012Kv;
})();

/** Deduplicate scalar setting reads inside one server operation. */
export function withSettingReadCache<T>(fn: () => T): T {
  return settingReadCache.run(
    {
      global: new Map(),
      profile: new Map(),
      login: new Map(),
      globalLoaded: false,
      loadedProfiles: new Set(),
      loadedLogins: new Set(),
    },
    fn
  );
}

const ALL_SETTINGS_STMT = hoistedStatement("SELECT key, value FROM settings");
const ALL_PROFILE_SETTINGS_STMT = hoistedStatement(
  "SELECT key, value FROM profile_settings WHERE profile_id = ?"
);
const ALL_LOGIN_SETTINGS_STMT = hoistedStatement(
  "SELECT key, value FROM login_settings WHERE login_id = ?"
);

/** Prime every scalar setting used by a read-heavy server operation. */
export function preloadGlobalSettings(): void {
  const scope = settingReadCache.getStore();
  if (!scope || scope.globalLoaded) return;
  const rows = ALL_SETTINGS_STMT.all() as { key: string; value: string }[];
  for (const row of rows) scope.global.set(row.key, row.value);
  scope.globalLoaded = true;
}

/** Prime one query per authorized profile instead of one query per setting key. */
export function preloadProfileSettings(profileIds: readonly number[]): void {
  const scope = settingReadCache.getStore();
  if (!scope) return;
  for (const profileId of new Set(profileIds)) {
    if (scope.loadedProfiles.has(profileId)) continue;
    const rows = ALL_PROFILE_SETTINGS_STMT.all(profileId) as {
      key: string;
      value: string;
    }[];
    for (const row of rows)
      scope.profile.set(`${profileId}:${row.key}`, row.value);
    scope.loadedProfiles.add(profileId);
  }
}

/** Prime every scalar setting for one authenticated login. */
export function preloadLoginSettings(loginId: number): void {
  const scope = settingReadCache.getStore();
  if (!scope || scope.loadedLogins.has(loginId)) return;
  const rows = ALL_LOGIN_SETTINGS_STMT.all(loginId) as {
    key: string;
    value: string;
  }[];
  for (const row of rows) scope.login.set(`${loginId}:${row.key}`, row.value);
  scope.loadedLogins.add(loginId);
}

// Generic key/value access over the global settings table, for simple scalar
// app-wide prefs. Statement hoisted for the same reason as
// LOGIN_SETTING_GET_STMT below: an instance setting is read many times per
// render, and preparing it inline pays SQL COMPILATION on each one. NOT
// globally cached. Callers may opt into the operation-scoped read cache below;
// writes update that scope so write-then-read remains current.
const SETTING_GET_STMT = hoistedStatement(
  "SELECT value FROM settings WHERE key = ?"
);
export function getSetting(key: string): string | undefined {
  const scope = settingReadCache.getStore();
  const cache = scope?.global;
  if (cache?.has(key)) return cache.get(key);
  if (scope?.globalLoaded) return undefined;
  const row = SETTING_GET_STMT.get(key) as { value?: string } | undefined;
  const value = row?.value;
  cache?.set(key, value);
  return value;
}

export function setSetting(key: string, value: string): void {
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, value);
  settingReadCache.getStore()?.global.set(key, value);
  // The instance-default timezone is the fallback for every profile without its
  // own, so a change invalidates the resolved-zone memo for all of them.
  if (key === "timezone") invalidateTimezoneMemo();
}

export function deleteSetting(key: string): void {
  db.prepare("DELETE FROM settings WHERE key = ?").run(key);
  settingReadCache.getStore()?.global.set(key, undefined);
}

// Every GLOBAL settings key starting with `prefix`. The instance-tier twin of
// getProfileSettingKeysWithPrefix, used by the shared-supply-pool nudge (#1374) to
// enumerate its per-pool episode markers (notify_last_pool_refill_<poolId>) so a marker
// whose pool is gone can be swept (#325). A pool is household-shared and has no owning
// profile, so its marker lives here rather than in profile_settings.
export function getSettingKeysWithPrefix(prefix: string): string[] {
  const rows = db
    .prepare("SELECT key FROM settings WHERE key LIKE ? ESCAPE '\\'")
    .all(prefix.replace(/[\\%_]/g, "\\$&") + "%") as { key: string }[];
  return rows.map((r) => r.key);
}

// Generic per-profile key/value access (profile_settings table). Hoisted for the
// same reason as the two statements above, and more urgently: this is the single
// most-executed read in the app (~1100 times per `/` render, ~10,600 on
// /household, where the per-member checks fan out across every accessible
// profile). Inline, each of those compiled its own copy of the SQL. Value
// semantics are unchanged outside an explicit operation-scoped read cache.
/** PROBE-5012 (temporary): is a setting read cache open on this call stack? */
export function __probeSettingScopeOpen(): string {
  return `${settingReadCache.getStore() != null}/kvModule=${PROBE_MODULE_INSTANCE}`;
}

const PROFILE_SETTING_GET_STMT = hoistedStatement(
  "SELECT value FROM profile_settings WHERE profile_id = ? AND key = ?"
);
export function getProfileSetting(
  profileId: number,
  key: string
): string | undefined {
  const scope = settingReadCache.getStore();
  const cache = scope?.profile;
  const cacheKey = `${profileId}:${key}`;
  if (process.env.PROBE_5012)
    console.log(
      `[PROBE-read] store=${scope ? 1 : 0} kvModule=${PROBE_MODULE_INSTANCE} key=${cacheKey}`
    );
  if (cache?.has(cacheKey)) return cache.get(cacheKey);
  if (scope?.loadedProfiles.has(profileId)) return undefined;
  const row = PROFILE_SETTING_GET_STMT.get(profileId, key) as
    { value?: string } | undefined;
  const value = row?.value;
  cache?.set(cacheKey, value);
  return value;
}

export function setProfileSetting(
  profileId: number,
  key: string,
  value: string
): void {
  db.prepare(
    `INSERT INTO profile_settings (profile_id, key, value) VALUES (?, ?, ?)
     ON CONFLICT(profile_id, key) DO UPDATE SET value = excluded.value`
  ).run(profileId, key, value);
  settingReadCache.getStore()?.profile.set(`${profileId}:${key}`, value);
  // Keep the resolved-zone memo (lib/db) in sync when this profile's timezone
  // changes, so today()/streaks/windows reflect it on the next call.
  if (key === "timezone") invalidateTimezoneMemo(profileId);
}

export function deleteProfileSetting(profileId: number, key: string): void {
  db.prepare(
    "DELETE FROM profile_settings WHERE profile_id = ? AND key = ?"
  ).run(profileId, key);
  settingReadCache.getStore()?.profile.set(`${profileId}:${key}`, undefined);
}

// Every profile_settings key for `profileId` starting with `prefix`. Used by the
// preventive-care nudge (issue #87) to enumerate its per-rule dedup markers
// (notify_last_preventive_<ruleKey>) so stale ones can be cleared once the item is
// no longer due. Profile-scoped (filters profile_id); profile_settings is a
// settings tier, not profile-owned data, so it isn't covered by the owned-table
// scoping test regardless.
export function getProfileSettingKeysWithPrefix(
  profileId: number,
  prefix: string
): string[] {
  const rows = db
    .prepare(
      "SELECT key FROM profile_settings WHERE profile_id = ? AND key LIKE ? ESCAPE '\\'"
    )
    .all(profileId, prefix.replace(/[\\%_]/g, "\\$&") + "%") as {
    key: string;
  }[];
  return rows.map((r) => r.key);
}

// Generic per-login key/value access (login_settings table). Statement hoisted to
// module scope: getUnitPrefs (and others) read login settings on effectively
// every request. The operation-scoped cache updates on writes and deletes, so a
// caller that opts in still sees write-then-read changes.
const LOGIN_SETTING_GET_STMT = hoistedStatement(
  "SELECT value FROM login_settings WHERE login_id = ? AND key = ?"
);
export function getLoginSetting(
  loginId: number,
  key: string
): string | undefined {
  const scope = settingReadCache.getStore();
  const cache = scope?.login;
  const cacheKey = `${loginId}:${key}`;
  if (cache?.has(cacheKey)) return cache.get(cacheKey);
  if (scope?.loadedLogins.has(loginId)) return undefined;
  const row = LOGIN_SETTING_GET_STMT.get(loginId, key) as
    { value?: string } | undefined;
  const value = row?.value;
  cache?.set(cacheKey, value);
  return value;
}

export function setLoginSetting(
  loginId: number,
  key: string,
  value: string
): void {
  db.prepare(
    `INSERT INTO login_settings (login_id, key, value) VALUES (?, ?, ?)
     ON CONFLICT(login_id, key) DO UPDATE SET value = excluded.value`
  ).run(loginId, key, value);
  settingReadCache.getStore()?.login.set(`${loginId}:${key}`, value);
}

export function deleteLoginSetting(loginId: number, key: string): void {
  db.prepare("DELETE FROM login_settings WHERE login_id = ? AND key = ?").run(
    loginId,
    key
  );
  settingReadCache.getStore()?.login.set(`${loginId}:${key}`, undefined);
}
