import { db, invalidateTimezoneMemo } from "../db";

// Generic key/value access over the global settings table, for simple scalar
// app-wide prefs.
export function getSetting(key: string): string | undefined {
  const row = db
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(key) as { value?: string } | undefined;
  return row?.value;
}

export function setSetting(key: string, value: string): void {
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, value);
  // The instance-default timezone is the fallback for every profile without its
  // own, so a change invalidates the resolved-zone memo for all of them.
  if (key === "timezone") invalidateTimezoneMemo();
}

export function deleteSetting(key: string): void {
  db.prepare("DELETE FROM settings WHERE key = ?").run(key);
}

// Generic per-profile key/value access (profile_settings table).
export function getProfileSetting(
  profileId: number,
  key: string
): string | undefined {
  const row = db
    .prepare(
      "SELECT value FROM profile_settings WHERE profile_id = ? AND key = ?"
    )
    .get(profileId, key) as { value?: string } | undefined;
  return row?.value;
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
  // Keep the resolved-zone memo (lib/db) in sync when this profile's timezone
  // changes, so today()/streaks/windows reflect it on the next call.
  if (key === "timezone") invalidateTimezoneMemo(profileId);
}

export function deleteProfileSetting(profileId: number, key: string): void {
  db.prepare(
    "DELETE FROM profile_settings WHERE profile_id = ? AND key = ?"
  ).run(profileId, key);
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
// every request. NOT cache()-wrapped — a request may write via setLoginSetting
// then re-read, so this must always hit the DB.
const LOGIN_SETTING_GET_STMT = db.prepare(
  "SELECT value FROM login_settings WHERE login_id = ? AND key = ?"
);
export function getLoginSetting(
  loginId: number,
  key: string
): string | undefined {
  const row = LOGIN_SETTING_GET_STMT.get(loginId, key) as
    { value?: string } | undefined;
  return row?.value;
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
}

export function deleteLoginSetting(loginId: number, key: string): void {
  db.prepare("DELETE FROM login_settings WHERE login_id = ? AND key = ?").run(
    loginId,
    key
  );
}
