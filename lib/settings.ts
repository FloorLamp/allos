import crypto from "node:crypto";
import { db, today, invalidateTimezoneMemo } from "./db";
import { ageFromBirthdate } from "./date";
import { hashShareToken } from "./share-token";
import { DEFAULT_TIMEZONE, isValidTimezone, resolveTimezone } from "./timezone";
import type { Sex, ReproductiveStatus } from "./types";
// Type-only import so lib/settings ↔ lib/dashboard-widgets stays a compile-time
// edge (no runtime cycle: dashboard-widgets imports nothing back from settings).
import type { DashboardLayout } from "./dashboard-widgets";
import { parsePins, serializePins } from "./trend-pins";
import { parseViews, serializeViews, type TrendView } from "./trend-views";
import {
  diffSituations,
  parseSituationEvents,
  serializeSituationEvents,
  type SituationEvent,
} from "./trend-annotations";

// Re-exported for API compatibility: these historically lived in lib/settings and
// callers across app/ import them from here. The implementation now lives in the
// db-free lib/timezone module, shared with lib/db's day-boundary reader.
export { DEFAULT_TIMEZONE, isValidTimezone };

export type WeightUnit = "kg" | "lb";
export type DistanceUnit = "km" | "mi";

export interface UnitPrefs {
  weightUnit: WeightUnit;
  distanceUnit: DistanceUnit;
}

const DEFAULTS: UnitPrefs = { weightUnit: "kg", distanceUnit: "km" };

// ---- Settings tiers (issue #67, Phase 2) ----
// Three key/value stores. `settings` is app-global (bot token, migration flags,
// instance defaults). `profile_settings` is per tracked person (sex, timezone,
// notification schedule, active situations). `login_settings` is per login
// identity (unit display preferences). Convert at the boundary: a query/action
// resolves the right tier from the session's profile/login id.

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

// Generic per-login key/value access (login_settings table).
export function getLoginSetting(
  loginId: number,
  key: string
): string | undefined {
  const row = db
    .prepare("SELECT value FROM login_settings WHERE login_id = ? AND key = ?")
    .get(loginId, key) as { value?: string } | undefined;
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

// ---- Unit display preferences (per login) ----
export function getUnitPrefs(loginId: number): UnitPrefs {
  const weight = getLoginSetting(loginId, "weight_unit");
  const distance = getLoginSetting(loginId, "distance_unit");
  return {
    weightUnit: weight === "lb" ? "lb" : DEFAULTS.weightUnit,
    distanceUnit: distance === "mi" ? "mi" : DEFAULTS.distanceUnit,
  };
}

export function setUnitPrefs(loginId: number, prefs: UnitPrefs) {
  const tx = db.transaction(() => {
    setLoginSetting(loginId, "weight_unit", prefs.weightUnit);
    setLoginSetting(loginId, "distance_unit", prefs.distanceUnit);
  });
  tx();
}

// App timezone (IANA name, e.g. "America/New_York"), stored per profile in
// profile_settings and falling back to the instance default (global settings
// 'timezone', seeded once from the TZ env), then UTC. This is the source of truth
// for a profile's day boundaries — today()/yesterday(), rolling day-windows,
// streaks, and notification scheduling all resolve to it. NOTE: lib/db.ts inlines
// this same read (it can't import settings.ts without a cycle); keep them in sync
// via the shared lib/timezone.resolveTimezone.

export function getTimezone(profileId: number): string {
  // Per-profile setting wins; read the instance default only when it's unset (the
  // `??` short-circuit), then resolveTimezone validates-or-falls-back to UTC.
  const prof = getProfileSetting(profileId, "timezone");
  return resolveTimezone(
    prof,
    prof == null ? getSetting("timezone") : undefined
  );
}

export function setTimezone(profileId: number, tz: string): void {
  if (!isValidTimezone(tz)) throw new Error(`Invalid timezone: ${tz}`);
  setProfileSetting(profileId, "timezone", tz);
}

// The instance-default timezone (global settings 'timezone'): seeded once from
// the TZ env on first boot and used as the fallback for any profile without its
// own timezone, and the seed for newly created profiles. Admin-managed.
export function getInstanceTimezone(): string {
  const v = getSetting("timezone");
  return v && isValidTimezone(v) ? v : DEFAULT_TIMEZONE;
}

export function setInstanceTimezone(tz: string): void {
  if (!isValidTimezone(tz)) throw new Error(`Invalid timezone: ${tz}`);
  setSetting("timezone", tz);
}

// ---- Week start (per profile) ----
// The first day of the week (0=Sun … 6=Sat), stored per profile. Decides where
// calendar grids/weekly charts break and when the weekly-routine counters reset.
// Defaults to Sunday.
export type WeekStart = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export const DEFAULT_WEEK_START: WeekStart = 0;

export function isValidWeekStart(n: number): n is WeekStart {
  return Number.isInteger(n) && n >= 0 && n <= 6;
}

export function getWeekStart(profileId: number): WeekStart {
  const n = Number(getProfileSetting(profileId, "week_start"));
  return isValidWeekStart(n) ? n : DEFAULT_WEEK_START;
}

export function setWeekStart(profileId: number, weekStart: WeekStart): void {
  if (!isValidWeekStart(weekStart))
    throw new Error(`Invalid week start: ${weekStart}`);
  setProfileSetting(profileId, "week_start", String(weekStart));
}

// ---- Weekly counting mode (per profile) ----
// Whether the weekly-routine counters and the journal week summary count over the
// current calendar week (resetting on the week-start day) or a rolling 7-day
// window. Defaults to the calendar week, so the week-start preference drives them
// out of the box.
export type WeekMode = "calendar" | "rolling";

export const DEFAULT_WEEK_MODE: WeekMode = "calendar";

export function isValidWeekMode(v: string): v is WeekMode {
  return v === "calendar" || v === "rolling";
}

export function getWeekMode(profileId: number): WeekMode {
  const v = getProfileSetting(profileId, "week_mode");
  return v && isValidWeekMode(v) ? v : DEFAULT_WEEK_MODE;
}

export function setWeekMode(profileId: number, mode: WeekMode): void {
  if (!isValidWeekMode(mode)) throw new Error(`Invalid week mode: ${mode}`);
  setProfileSetting(profileId, "week_mode", mode);
}

// Public base URL of the app (e.g. behind a tunnel or reverse proxy). Global —
// shared by anything that hands an externally reachable URL to a third party:
// the Telegram webhook, Strava OAuth callbacks, the Health Connect ingest
// endpoint. Empty when the app isn't publicly exposed.
export function getPublicUrl(): string {
  return (getSetting("public_url") ?? "").trim().replace(/\/+$/, "");
}

export function setPublicUrl(url: string): void {
  setSetting("public_url", url.trim().replace(/\/+$/, ""));
}

// How inbound Telegram button taps reach the app: "poll" long-polls getUpdates
// (works without a public URL), "webhook" has Telegram POST to /api/telegram/webhook.
// Mutually exclusive on Telegram's side — getUpdates 409s while a webhook is set.
export type TelegramMode = "poll" | "webhook";

// Global Telegram bot credentials (the bot token, inbound-webhook secret, and
// transport mode are app-wide — a single bot serves every profile).
export interface TelegramBotConfig {
  telegramBotToken: string;
  telegramMode: TelegramMode;
  // Authenticates inbound webhook calls from Telegram (sent as the
  // x-telegram-bot-api-secret-token header). Auto-generated on first save.
  telegramWebhookSecret: string;
}

export function getTelegramBotConfig(): TelegramBotConfig {
  return {
    telegramBotToken: getSetting("telegram_bot_token") ?? "",
    telegramMode:
      getSetting("telegram_mode") === "webhook" ? "webhook" : "poll",
    telegramWebhookSecret: getSetting("telegram_webhook_secret") ?? "",
  };
}

// Per-profile Telegram delivery target (whether reminders are on for this profile
// and the chat they're sent to).
export interface ProfileTelegram {
  telegramEnabled: boolean;
  telegramChatId: string;
}

export function getProfileTelegram(profileId: number): ProfileTelegram {
  return {
    telegramEnabled: getProfileSetting(profileId, "telegram_enabled") === "1",
    telegramChatId: getProfileSetting(profileId, "telegram_chat_id") ?? "",
  };
}

// Resolve every profile a Telegram chat id belongs to. A single chat (e.g. a
// family group) can be the delivery target for several profiles, so this returns
// all of them — inbound button taps carry only a chat id, and the callback
// handler picks the one the button token names (rejecting taps from an unknown
// chat). The chat id is stored as a string in profile_settings; callers stringify.
export function getProfilesByTelegramChatId(chatId: string): number[] {
  if (!chatId) return [];
  const rows = db
    .prepare(
      "SELECT profile_id FROM profile_settings WHERE key = 'telegram_chat_id' AND value = ?"
    )
    .all(chatId) as { profile_id: number }[];
  return rows.map((r) => r.profile_id);
}

// Merged view (global bot config + this profile's delivery target), for the
// settings page and outbound notifications.
export interface NotificationConfig
  extends TelegramBotConfig, ProfileTelegram {}

export function getNotificationConfig(profileId: number): NotificationConfig {
  return { ...getTelegramBotConfig(), ...getProfileTelegram(profileId) };
}

// Persist this profile's Telegram delivery target (enable toggle + chat id).
// Per-profile, so any login acting as the profile may set it (member-safe).
export function setProfileTelegram(
  profileId: number,
  cfg: { telegramEnabled: boolean; telegramChatId: string }
): ProfileTelegram {
  setProfileSetting(
    profileId,
    "telegram_enabled",
    cfg.telegramEnabled ? "1" : "0"
  );
  setProfileSetting(profileId, "telegram_chat_id", cfg.telegramChatId.trim());
  return getProfileTelegram(profileId);
}

// Persist the global bot credentials (token + inbound transport mode). App-wide,
// so this is an admin-only operation — a single bot serves every profile.
export function setTelegramBotConfig(cfg: {
  telegramBotToken: string;
  telegramMode: TelegramMode;
}): TelegramBotConfig {
  // Write the token, mode, and one-time webhook secret as one transaction (mirrors
  // setUnitPrefs) so a partial failure can't leave the config half-updated.
  const write = db.transaction(() => {
    setSetting("telegram_bot_token", cfg.telegramBotToken.trim());
    setSetting("telegram_mode", cfg.telegramMode);
    // Generate a stable webhook secret once, so inbound calls can be authenticated.
    if (!getSetting("telegram_webhook_secret")) {
      setSetting("telegram_webhook_secret", crypto.randomUUID());
    }
  });
  write();
  return getTelegramBotConfig();
}

// When each notification slot is sent. Supplement windows have a fixed hour
// (0-23, interpreted in the profile's own timezone — see getTimezone, which the
// scheduler resolves against, not the container's local time) or null = off; the
// workout reminder's timing is derived from the user's history (see
// inferWorkoutSchedule), so it's just on/off here.
export interface NotifySchedule {
  supplementHours: {
    Morning: number | null;
    Midday: number | null;
    Evening: number | null;
    Bedtime: number | null;
  };
  workoutEnabled: boolean;
  // Morning digest (issue #135): the hour (0-23, this profile's timezone) to send
  // the once-a-day summary, or null = off. Off by default.
  digestHour: number | null;
}

const SUPP_HOUR_KEYS = {
  Morning: "notify_supp_morning_hour",
  Midday: "notify_supp_midday_hour",
  Evening: "notify_supp_evening_hour",
  Bedtime: "notify_supp_bedtime_hour",
} as const;
const SUPP_HOUR_DEFAULTS = {
  Morning: 8,
  Midday: 13,
  Evening: 20,
  Bedtime: 22,
} as const;

function parseHour(
  raw: string | undefined,
  fallback: number | null
): number | null {
  if (raw === undefined) return fallback; // unset → default
  if (raw === "") return null; // explicitly off
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= 23 ? n : fallback;
}

export function getNotifySchedule(profileId: number): NotifySchedule {
  return {
    supplementHours: {
      Morning: parseHour(
        getProfileSetting(profileId, SUPP_HOUR_KEYS.Morning),
        SUPP_HOUR_DEFAULTS.Morning
      ),
      Midday: parseHour(
        getProfileSetting(profileId, SUPP_HOUR_KEYS.Midday),
        SUPP_HOUR_DEFAULTS.Midday
      ),
      Evening: parseHour(
        getProfileSetting(profileId, SUPP_HOUR_KEYS.Evening),
        SUPP_HOUR_DEFAULTS.Evening
      ),
      Bedtime: parseHour(
        getProfileSetting(profileId, SUPP_HOUR_KEYS.Bedtime),
        SUPP_HOUR_DEFAULTS.Bedtime
      ),
    },
    workoutEnabled:
      (getProfileSetting(profileId, "notify_workout_enabled") ?? "1") === "1",
    // Off by default (fallback null) — the digest is opt-in.
    digestHour: parseHour(
      getProfileSetting(profileId, "notify_digest_hour"),
      null
    ),
  };
}

export function setNotifySchedule(
  profileId: number,
  sched: NotifySchedule
): void {
  for (const k of ["Morning", "Midday", "Evening", "Bedtime"] as const) {
    const h = sched.supplementHours[k];
    setProfileSetting(profileId, SUPP_HOUR_KEYS[k], h == null ? "" : String(h));
  }
  setProfileSetting(
    profileId,
    "notify_workout_enabled",
    sched.workoutEnabled ? "1" : "0"
  );
  setProfileSetting(
    profileId,
    "notify_digest_hour",
    sched.digestHour == null ? "" : String(sched.digestHour)
  );
}

// Automated SQLite backup config (issue #131), stored app-globally. The hour is
// interpreted in the instance-default timezone (backups are global, not
// per-profile). Retention is keep-N-dailies + M-weeklies. Admin-managed.
export interface BackupSettings {
  enabled: boolean;
  hour: number; // 0–23, instance timezone
  keepDaily: number; // most-recent snapshots kept
  keepWeekly: number; // additional older weeks kept (newest per week)
}

export const DEFAULT_BACKUP_SETTINGS: BackupSettings = {
  enabled: true,
  hour: 3,
  keepDaily: 7,
  keepWeekly: 8,
};

function parseIntInRange(
  raw: string | undefined,
  lo: number,
  hi: number,
  fallback: number
): number {
  const n = Number(raw);
  return Number.isInteger(n) && n >= lo && n <= hi ? n : fallback;
}

export function getBackupSettings(): BackupSettings {
  const enabledRaw = getSetting("backup_enabled");
  return {
    enabled:
      enabledRaw === undefined
        ? DEFAULT_BACKUP_SETTINGS.enabled
        : enabledRaw === "1",
    hour: parseIntInRange(
      getSetting("backup_hour"),
      0,
      23,
      DEFAULT_BACKUP_SETTINGS.hour
    ),
    keepDaily: parseIntInRange(
      getSetting("backup_keep_daily"),
      0,
      365,
      DEFAULT_BACKUP_SETTINGS.keepDaily
    ),
    keepWeekly: parseIntInRange(
      getSetting("backup_keep_weekly"),
      0,
      520,
      DEFAULT_BACKUP_SETTINGS.keepWeekly
    ),
  };
}

export function setBackupSettings(cfg: BackupSettings): void {
  const write = db.transaction(() => {
    setSetting("backup_enabled", cfg.enabled ? "1" : "0");
    setSetting("backup_hour", String(cfg.hour));
    setSetting("backup_keep_daily", String(cfg.keepDaily));
    setSetting("backup_keep_weekly", String(cfg.keepWeekly));
  });
  write();
}

// AI automation toggles, stored app-globally in the settings table.
export interface AiPrefs {
  // Auto-generate supplement suggestions when new/changed biomarkers are
  // imported (see autoSuggestFromBiomarkers). On by default.
  autoSupplementSuggestions: boolean;
  // Auto-generate insights. Not consumed anywhere yet — stored so the UI and
  // a future trigger agree on the key. Off by default.
  autoInsights: boolean;
}

export function getAiPrefs(): AiPrefs {
  return {
    autoSupplementSuggestions:
      (getSetting("ai_auto_supplement_suggestions") ?? "1") === "1",
    autoInsights: getSetting("ai_auto_insights") === "1",
  };
}

export function setAiPrefs(prefs: AiPrefs): void {
  setSetting(
    "ai_auto_supplement_suggestions",
    prefs.autoSupplementSuggestions ? "1" : "0"
  );
  setSetting("ai_auto_insights", prefs.autoInsights ? "1" : "0");
}

// The profile's biological sex, used to pick sex-specific optimal biomarker
// bands. Null when unset — callers then fall back to the generic optimal range.
export function getUserSex(profileId: number): Sex | null {
  const v = getProfileSetting(profileId, "sex");
  return v === "male" ? "male" : v === "female" ? "female" : null;
}

export function setUserSex(profileId: number, sex: Sex | null) {
  if (sex === null) {
    deleteProfileSetting(profileId, "sex");
    return;
  }
  setProfileSetting(profileId, "sex", sex);
}

// The profile's reproductive (menopausal) status — a CURRENT attribute of the
// tracked person, mirroring getUserSex/setUserSex. Used to pick life-stage-aware
// reference ranges for the female reproductive hormones (Estradiol/FSH/LH): when
// set (and the sex is female) it overrides the age proxy so a genuinely
// post-menopausal high hormone flags. Null when unset (not specified) — then the
// age-proxy fallback (e.g. the FSH 51+ band) applies, unchanged. Applies to female
// physiology only; a male profile's ranges are unaffected regardless of this value.
export function getUserReproductiveStatus(
  profileId: number
): ReproductiveStatus | null {
  const v = getProfileSetting(profileId, "reproductive_status");
  return v === "premenopausal"
    ? "premenopausal"
    : v === "postmenopausal"
      ? "postmenopausal"
      : null;
}

export function setUserReproductiveStatus(
  profileId: number,
  status: ReproductiveStatus | null
) {
  if (status === null) {
    deleteProfileSetting(profileId, "reproductive_status");
    return;
  }
  setProfileSetting(profileId, "reproductive_status", status);
}

// The tracked person's full/legal name — distinct from profiles.name, which is
// the short display label ("Me", "Mom") shown in the switcher. Lives in
// profile_settings like the other per-person facts (sex, birthdate); used where a
// real name matters (e.g. a medical-summary handout) and backfilled from imported
// records. Null when unset.
export function getUserFullName(profileId: number): string | null {
  const v = getProfileSetting(profileId, "full_name");
  return v && v.trim() ? v : null;
}

export function setUserFullName(profileId: number, name: string | null) {
  const v = name?.trim();
  if (!v) {
    deleteProfileSetting(profileId, "full_name");
    return;
  }
  setProfileSetting(profileId, "full_name", v.slice(0, 200));
}

// The profile's birthdate (ISO YYYY-MM-DD), when known. A property of the tracked
// person, so it lives in profile_settings. Preferred over a bare age because the
// current age can be derived from it at any time (see getUserAge).
export function getUserBirthdate(profileId: number): string | null {
  return getProfileSetting(profileId, "birthdate") ?? null;
}

// Set (or clear, with null) the profile's birthdate. Setting a real date also
// drops any stored age fallback: once the birthdate is known, a bare age is
// redundant (and would otherwise linger as stale data). Keeps the invariant
// that the 'age' key exists only while no birthdate is set.
export function setUserBirthdate(profileId: number, date: string | null) {
  if (!date) {
    deleteProfileSetting(profileId, "birthdate");
    return;
  }
  const write = db.transaction(() => {
    setProfileSetting(profileId, "birthdate", date);
    deleteProfileSetting(profileId, "age");
  });
  write();
}

// A stored age fallback (whole years) for the profile, used only when no birthdate
// is known — e.g. a document states an age but no date of birth. A birthdate always
// wins.
export function getStoredAge(profileId: number): number | null {
  const v = getProfileSetting(profileId, "age");
  const n = v != null ? Number(v) : NaN;
  return Number.isInteger(n) && n > 0 && n < 150 ? n : null;
}

export function setStoredAge(profileId: number, age: number | null) {
  if (age === null) {
    deleteProfileSetting(profileId, "age");
    return;
  }
  setProfileSetting(profileId, "age", String(Math.round(age)));
}

// The profile's current age in whole years: derived from the birthdate when set,
// otherwise the stored age fallback. Null when neither is known. The profile id
// also resolves "today" in that profile's timezone.
export function getUserAge(profileId: number): number | null {
  const bd = getUserBirthdate(profileId);
  if (bd) return ageFromBirthdate(bd, today(profileId));
  return getStoredAge(profileId);
}

// The profile's age (whole years) as of a specific date, for age-banded biomarker
// ranges: derived from the birthdate on that date (the "age on the collection
// date, not today" rule), else the stored age fallback, else null. Used by the
// biomarker UI to pick the band that applied to a given reading.
export function getUserAgeOn(
  profileId: number,
  on: string | null | undefined
): number | null {
  const bd = getUserBirthdate(profileId);
  if (bd && on) {
    const a = ageFromBirthdate(bd, on);
    if (a != null) return a;
  }
  return getStoredAge(profileId);
}

export interface ProfileAdoption {
  sexAdopted: boolean; // sex-specific bands may now apply to ALL existing records
  birthdate: string | null; // a birthdate that was adopted (for caller logging)
  age: number | null; // an age fallback that was adopted (for caller logging)
  fullName: string | null; // a full name that was adopted (for caller logging)
  changed: boolean; // any profile field was written
}

// Backfill the user's profile (sex, birthdate/age, full name) from an extracted
// document's metadata, without ever overwriting a value the user already set —
// prefer a birthdate over a bare age. Shared by every document-import path so
// adoption is consistent regardless of which one the user takes. Returns what
// changed so the caller can re-derive flags (on a new sex) and revalidate.
export function adoptProfileFromExtraction(
  profileId: number,
  meta: {
    patient_sex: Sex | null;
    patient_birthdate: string | null;
    patient_age: number | null;
    patient_name?: string | null;
  } | null
): ProfileAdoption {
  const out: ProfileAdoption = {
    sexAdopted: false,
    birthdate: null,
    age: null,
    fullName: null,
    changed: false,
  };
  if (!meta) return out;

  if (meta.patient_sex !== null && getUserSex(profileId) === null) {
    setUserSex(profileId, meta.patient_sex);
    out.sexAdopted = true;
    out.changed = true;
  }
  if (meta.patient_name && getUserFullName(profileId) === null) {
    setUserFullName(profileId, meta.patient_name);
    out.fullName = meta.patient_name.trim() || null;
    out.changed = true;
  }
  if (getUserBirthdate(profileId) === null) {
    if (meta.patient_birthdate) {
      setUserBirthdate(profileId, meta.patient_birthdate);
      out.birthdate = meta.patient_birthdate;
      out.changed = true;
    } else if (meta.patient_age !== null && getStoredAge(profileId) === null) {
      setStoredAge(profileId, meta.patient_age);
      out.age = meta.patient_age;
      out.changed = true;
    }
  }
  return out;
}

// Currently-active situations (e.g. "Illness", "Travel") for a profile, persisted
// as a JSON array so situational supplements surface only while the situation
// applies and the state is shared with the notifier.
export function getActiveSituations(profileId: number): string[] {
  const v = getProfileSetting(profileId, "active_situations");
  if (!v) return [];
  try {
    const arr = JSON.parse(v);
    return Array.isArray(arr)
      ? arr.filter((x): x is string => typeof x === "string")
      : [];
  } catch {
    return [];
  }
}

export function setActiveSituations(profileId: number, situations: string[]) {
  const before = getActiveSituations(profileId);
  const distinct = [
    ...new Set(situations.map((s) => s.trim()).filter(Boolean)),
  ];
  // Log the start/stop transitions (Trends event annotations, #212 Phase 3) before
  // overwriting the current set — profile_settings keeps only the CURRENT set, so
  // the dated change log is what makes situations chartable. Same JSON-in-settings
  // precedent as active_situations itself; no owned table.
  const events = diffSituations(before, distinct, today(profileId));
  const write = db.transaction(() => {
    setProfileSetting(profileId, "active_situations", JSON.stringify(distinct));
    if (events.length > 0) {
      setProfileSetting(
        profileId,
        "situation_events",
        serializeSituationEvents(
          parseSituationEvents(
            getProfileSetting(profileId, "situation_events")
          ),
          events
        )
      );
    }
  });
  write();
}

// The profile's active-situation change log (Trends event annotations, #212
// Phase 3): the dated start/stop transitions appended by setActiveSituations.
// Read defensively — a malformed blob yields an empty list.
export function getSituationEvents(profileId: number): SituationEvent[] {
  return parseSituationEvents(getProfileSetting(profileId, "situation_events"));
}

// Pin-to-Trends (issue #212, Phase 2) — the profile's pinned Trends-Overview
// tiles (metric + biomarker keys), stored as a JSON array in profile_settings
// (same key/value precedent as active_situations / dashboard_layout). The list
// math (parse/toggle/order) lives in the pure lib/trend-pins; this tier only
// (de)serializes it. Reads defensively — a malformed blob yields an empty list.
export function getTrendPins(profileId: number): string[] {
  return parsePins(getProfileSetting(profileId, "trend_pins"));
}

export function setTrendPins(profileId: number, pins: readonly string[]): void {
  setProfileSetting(profileId, "trend_pins", serializePins(pins));
}

// Saved views (issue #212, Phase 3) — named snapshots of the Trends hub state
// (range + tab + compare pair + pins), stored as a JSON array in profile_settings
// (key "trend_views", same precedent as trend_pins). The list math (add/rename/
// delete/normalize) lives in the pure lib/trend-views; this tier only
// (de)serializes it. Reads defensively — a malformed blob yields an empty list.
export function getTrendViews(profileId: number): TrendView[] {
  return parseViews(getProfileSetting(profileId, "trend_views"));
}

export function setTrendViews(
  profileId: number,
  views: readonly TrendView[]
): void {
  setProfileSetting(profileId, "trend_views", serializeViews(views));
}

// Per-profile dashboard customization (issue #156) — the widget order + hidden
// set, stored as a JSON blob (same key/value precedent as active situations).
// Read defensively: any malformed/legacy shape returns null so the page falls
// back to the registry defaults rather than throwing. The layout is merged
// against the live registry by resolveWidgets, so ids are not validated here.
export function getDashboardLayout(profileId: number): DashboardLayout | null {
  const v = getProfileSetting(profileId, "dashboard_layout");
  if (!v) return null;
  try {
    const parsed = JSON.parse(v);
    if (!parsed || typeof parsed !== "object") return null;
    const order = Array.isArray(parsed.order)
      ? parsed.order.filter((x: unknown): x is string => typeof x === "string")
      : [];
    const hidden = Array.isArray(parsed.hidden)
      ? parsed.hidden.filter((x: unknown): x is string => typeof x === "string")
      : [];
    return { order, hidden };
  } catch {
    return null;
  }
}

// Persist the layout, trimming/deduping both lists so a corrupt post can't bloat
// the blob. Ids aren't validated against the registry (resolveWidgets merges
// defensively), so a client on an older/newer catalog never wipes the rest.
export function setDashboardLayout(
  profileId: number,
  layout: DashboardLayout
): void {
  const clean = (ids: string[]): string[] => [
    ...new Set(ids.map((s) => s.trim()).filter(Boolean)),
  ];
  const normalized: DashboardLayout = {
    order: clean(layout.order),
    hidden: clean(layout.hidden),
  };
  setProfileSetting(profileId, "dashboard_layout", JSON.stringify(normalized));
}

// ---- Calendar subscribe feed (ICS) ----------------------------------------
// A per-profile secret `.ics` URL the user subscribes to in Google/Apple/Outlook
// so upcoming medical appointments show up (with reminders) in their calendar.
// Security mirrors the passport share links (lib/share-links-db): the URL carries
// a high-entropy token, but only its SHA-256 HASH is stored — a DB leak yields no
// usable URL, and the token can be regenerated (old URL dies) or the feed
// disabled. State lives in profile_settings (a settings tier, NOT profile-owned
// data — so no schema change and no owned-table query), as discrete keys:
//   calendar_feed_enabled     "1" | "0"
//   calendar_feed_token_hash  hex SHA-256 of the raw token
//   calendar_feed_detail      "minimal" | "full"   (default "minimal")
// Minimal is the default: the feed then reveals nothing but "Medical appointment"
// (+ location). Full is an explicit opt-in that sends provider/reason too.

export type CalendarFeedDetail = "minimal" | "full";

export interface CalendarFeed {
  enabled: boolean;
  detail: CalendarFeedDetail;
  hasToken: boolean; // whether a token is minted (never exposes the token itself)
}

export function getCalendarFeed(profileId: number): CalendarFeed {
  const detail = getProfileSetting(profileId, "calendar_feed_detail");
  return {
    enabled: getProfileSetting(profileId, "calendar_feed_enabled") === "1",
    detail: detail === "full" ? "full" : "minimal",
    hasToken: !!getProfileSetting(profileId, "calendar_feed_token_hash"),
  };
}

// Mint a fresh 256-bit token, store its hash, mark the feed enabled, and return
// the RAW token exactly once (for building the subscribe URL — it's never stored,
// so it can't be shown again). Regenerating = calling this again: a new token,
// and the previous URL immediately stops resolving.
export function mintCalendarFeedToken(profileId: number): string {
  const token = crypto.randomBytes(32).toString("hex");
  const write = db.transaction(() => {
    setProfileSetting(
      profileId,
      "calendar_feed_token_hash",
      hashShareToken(token)
    );
    setProfileSetting(profileId, "calendar_feed_enabled", "1");
  });
  write();
  return token;
}

// Disable the feed (the route then 404s) and drop the token hash so the URL is
// dead even if re-enabled later without a fresh mint. Idempotent.
export function disableCalendarFeed(profileId: number): void {
  const write = db.transaction(() => {
    setProfileSetting(profileId, "calendar_feed_enabled", "0");
    deleteProfileSetting(profileId, "calendar_feed_token_hash");
  });
  write();
}

export function setCalendarFeedDetail(
  profileId: number,
  detail: CalendarFeedDetail
): void {
  setProfileSetting(
    profileId,
    "calendar_feed_detail",
    detail === "full" ? "full" : "minimal"
  );
}

// Resolve a raw token from the feed URL to the owning profile id, or null. This is
// the ONE unauthenticated seam (the calendar client has no session): hash the
// caller-supplied token and match the stored hash across profile_settings — the
// attacker controls only the raw token, never the hash, and a non-matching hash
// returns no row, so there's no value-dependent timing on the secret. Returns null
// unless a matching row exists AND its feed is still enabled; the returned
// profile_id then re-scopes every downstream read (exactly like getShareLinkByToken).
// profile_settings is a settings tier, not profile-owned data, so this query is
// intentionally not profile-scoped (mirrors getProfilesByTelegramChatId).
export function resolveProfileByCalendarToken(rawToken: string): number | null {
  if (!rawToken) return null;
  const row = db
    .prepare(
      "SELECT profile_id FROM profile_settings WHERE key = 'calendar_feed_token_hash' AND value = ?"
    )
    .get(hashShareToken(rawToken)) as { profile_id?: number } | undefined;
  const profileId = row?.profile_id;
  if (!profileId) return null;
  const enabled = getProfileSetting(profileId, "calendar_feed_enabled") === "1";
  return enabled ? profileId : null;
}
