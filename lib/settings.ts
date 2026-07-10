import * as React from "react";
import crypto from "node:crypto";
import { db, today, invalidateTimezoneMemo } from "./db";

// React's per-request cache() only exists in the canary React that Next vendors
// for server components. This module is also imported directly by tsx scripts
// (scripts/notify.ts) that resolve the plain `react` package, which doesn't export
// cache — importing the named binding there crashes at module load. Fall back to
// identity in that context (those scripts run each read at most once per tick, so
// per-request dedup is meaningless outside Next). Mirrors lib/queries/training.ts.
const cache: typeof React.cache =
  (React as { cache?: typeof React.cache }).cache ?? ((fn) => fn);
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
  parseFeedCategories,
  canonicalizeFeedCategories,
  clampFeedWindowDays,
  type FeedCategory,
} from "./calendar-ics";
import {
  diffSituations,
  parseSituationEvents,
  serializeSituationEvents,
  type SituationEvent,
} from "./trend-annotations";
import { normalizeBloodType } from "./emergency-card";
import {
  parsePackYears,
  parseQuitYear,
  parseSmokingStatus,
  type SmokingHistory,
} from "./smoking";
import {
  expiresAtFromChoice,
  isTokenExpired,
  shouldRecordUse,
  type TokenExpiryChoice,
} from "./token-lifecycle";

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

// ---- Settings tiers ----
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

// ---- Unit display preferences (per login) ----
// Wrapped in React `cache()` — a single render calls this many times (~4×/Training
// view, and once per unit-formatting boundary elsewhere), all for the same login.
// Request-scoped memoization collapses those to one pair of reads. Safe: the only
// writer (setUnitPrefs / saveUnitPrefs) revalidates rather than re-reading in the
// same request, and outside a request `cache()` degrades to a plain passthrough.
export const getUnitPrefs = cache(function getUnitPrefs(
  loginId: number
): UnitPrefs {
  const weight = getLoginSetting(loginId, "weight_unit");
  const distance = getLoginSetting(loginId, "distance_unit");
  return {
    weightUnit: weight === "lb" ? "lb" : DEFAULTS.weightUnit,
    distanceUnit: distance === "mi" ? "mi" : DEFAULTS.distanceUnit,
  };
});

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
  // Morning digest: the hour (0-23, this profile's timezone) to send
  // the once-a-day summary, or null = off. Off by default.
  digestHour: number | null;
  // Weekly recap (issue #32): the weekday (0=Sun … 6=Sat, this profile's timezone)
  // to send the seven-day summary, or null = off. Off by default. The recap fires
  // at weeklyRecapHour on that weekday.
  weeklyRecapDay: number | null;
  weeklyRecapHour: number | null; // hour 0-23; defaults to 9 when a day is set
  // Milestone alerts (issue #32): whether to notify when a milestone fires. On by
  // default — milestones are always recorded to the timeline regardless; this only
  // gates the (quiet) push/Telegram alert.
  milestonesEnabled: boolean;
  // Preventive-care reminders (issue #87): whether due/overdue preventive visits &
  // screenings send a proactive nudge AND appear in the "what's due" digest. On by
  // default. Off suppresses both push paths; the Upcoming page still lists them
  // (that's a pull surface, not a push).
  preventiveEnabled: boolean;
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
    // Weekly recap — off by default (opt-in). Weekday 0-6, else null.
    weeklyRecapDay: parseWeekday(
      getProfileSetting(profileId, "notify_recap_day")
    ),
    weeklyRecapHour:
      parseHour(getProfileSetting(profileId, "notify_recap_hour"), 9) ?? 9,
    // Milestone alerts on unless explicitly disabled.
    milestonesEnabled:
      (getProfileSetting(profileId, "notify_milestones") ?? "1") === "1",
    // Preventive-care reminders on unless explicitly disabled.
    preventiveEnabled:
      (getProfileSetting(profileId, "notify_preventive") ?? "1") === "1",
  };
}

// Parse a stored weekday (0=Sun … 6=Sat); "" / unset / out-of-range → null (off).
function parseWeekday(raw: string | undefined): number | null {
  if (raw === undefined || raw === "") return null;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= 6 ? n : null;
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
  setProfileSetting(
    profileId,
    "notify_recap_day",
    sched.weeklyRecapDay == null ? "" : String(sched.weeklyRecapDay)
  );
  setProfileSetting(
    profileId,
    "notify_recap_hour",
    sched.weeklyRecapHour == null ? "9" : String(sched.weeklyRecapHour)
  );
  setProfileSetting(
    profileId,
    "notify_milestones",
    sched.milestonesEnabled ? "1" : "0"
  );
  setProfileSetting(
    profileId,
    "notify_preventive",
    sched.preventiveEnabled ? "1" : "0"
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

// ---- Smoking history (issue #83) ----
// A per-profile STRUCTURED smoking record — status (never | former | current;
// absent = unknown, the tri-state the risk-gated screening rules need), pack-years,
// and the quit year — stored as discrete profile_settings keys like sex/birthdate.
// A `smoking_source` key records provenance ('manual' | 'imported') so a CCD
// re-import (adoptSmokingStatusFromImport) never clobbers a user's correction. This
// content is more sensitive than most profile_settings and, like the rest of the
// passport, is visible to any login granted the profile — the UI states that.
export function getSmokingHistory(profileId: number): SmokingHistory {
  return {
    status: parseSmokingStatus(getProfileSetting(profileId, "smoking_status")),
    packYears: parsePackYears(
      getProfileSetting(profileId, "smoking_pack_years")
    ),
    quitYear: parseQuitYear(getProfileSetting(profileId, "smoking_quit_year")),
  };
}

// Persist the structured smoking record. Manual entry is AUTHORITATIVE: it marks
// the source 'manual' so a later import leaves it alone. status null clears the
// whole record. pack-years applies only to an ever-smoker (former/current) and the
// quit year only to a former smoker; a 'never'/unset status drops both so a stale
// quantity can't linger and mislead the gate.
export function setSmokingHistory(
  profileId: number,
  record: SmokingHistory,
  source: "manual" | "imported" = "manual"
): void {
  const write = db.transaction(() => {
    if (record.status == null) {
      deleteProfileSetting(profileId, "smoking_status");
      deleteProfileSetting(profileId, "smoking_pack_years");
      deleteProfileSetting(profileId, "smoking_quit_year");
      deleteProfileSetting(profileId, "smoking_source");
      return;
    }
    setProfileSetting(profileId, "smoking_status", record.status);
    if (record.status !== "never" && record.packYears != null) {
      setProfileSetting(
        profileId,
        "smoking_pack_years",
        String(record.packYears)
      );
    } else {
      deleteProfileSetting(profileId, "smoking_pack_years");
    }
    if (record.status === "former" && record.quitYear != null) {
      setProfileSetting(
        profileId,
        "smoking_quit_year",
        String(record.quitYear)
      );
    } else {
      deleteProfileSetting(profileId, "smoking_quit_year");
    }
    setProfileSetting(profileId, "smoking_source", source);
  });
  write();
}

// Seed the structured smoking STATUS from an imported CCD social-history smoking
// condition (issue #83) so the risk-gated screening rules read structured data and
// the two representations don't drift. Respects a manual entry: when the record was
// last set by the user (source 'manual') the import leaves it untouched — a wrong
// import can't overwrite a correction. Otherwise it (re)seeds the status
// (latest-import-wins, mirroring the condition row) WITHOUT touching pack-years (a
// CCD rarely carries them), clearing a now-stale quit year only when the new status
// is 'current'.
export function adoptSmokingStatusFromImport(
  profileId: number,
  status: "former" | "current"
): void {
  if (getProfileSetting(profileId, "smoking_source") === "manual") return;
  const write = db.transaction(() => {
    setProfileSetting(profileId, "smoking_status", status);
    if (status === "current") {
      deleteProfileSetting(profileId, "smoking_quit_year");
    }
    setProfileSetting(profileId, "smoking_source", "imported");
  });
  write();
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

// ---- Emergency card (issue #42) ----
// Whether the offline emergency card is cached for this profile. Default OFF: the
// card holds the profile's allergies/meds/conditions, and caching it offline means
// a stolen UNLOCKED phone (or shared device) can read it without a login — which is
// simultaneously the point (a first responder needs it) and the trade-off, so it's
// strictly opt-in per profile.
export function getEmergencyCardEnabled(profileId: number): boolean {
  return getProfileSetting(profileId, "emergency_card_offline") === "1";
}

export function setEmergencyCardEnabled(
  profileId: number,
  enabled: boolean
): void {
  setProfileSetting(profileId, "emergency_card_offline", enabled ? "1" : "0");
}

// A manually-entered blood type for the profile (e.g. "O+"). The emergency card
// prefers this over one derived from lab records (ABO/Rh), since most people know
// their type without a lab on file. Stored canonicalized (see normalizeBloodType);
// null clears it. Kept in profile_settings like the other per-person facts.
export function getBloodType(profileId: number): string | null {
  return getProfileSetting(profileId, "blood_type") ?? null;
}

export function setBloodType(profileId: number, value: string | null): void {
  const v = normalizeBloodType(value);
  if (!v) {
    deleteProfileSetting(profileId, "blood_type");
    return;
  }
  setProfileSetting(profileId, "blood_type", v);
}

// The profile's emergency contact — the person a first responder should call.
// Three discrete keys in profile_settings (name / phone / relation), all optional;
// the card shows the contact only when at least a name or phone is set.
export interface EmergencyContactSetting {
  name: string;
  phone: string;
  relation: string;
}

export function getEmergencyContact(
  profileId: number
): EmergencyContactSetting {
  return {
    name: getProfileSetting(profileId, "emergency_contact_name") ?? "",
    phone: getProfileSetting(profileId, "emergency_contact_phone") ?? "",
    relation: getProfileSetting(profileId, "emergency_contact_relation") ?? "",
  };
}

export function setEmergencyContact(
  profileId: number,
  contact: EmergencyContactSetting
): void {
  const write = db.transaction(() => {
    const set = (key: string, value: string) => {
      const v = value.trim().slice(0, 200);
      if (v) setProfileSetting(profileId, key, v);
      else deleteProfileSetting(profileId, key);
    };
    set("emergency_contact_name", contact.name);
    set("emergency_contact_phone", contact.phone);
    set("emergency_contact_relation", contact.relation);
  });
  write();
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
  // Log the start/stop transitions (Trends event annotations) before
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

// The profile's active-situation change log (Trends event annotations):
// the dated start/stop transitions appended by setActiveSituations.
// Read defensively — a malformed blob yields an empty list.
export function getSituationEvents(profileId: number): SituationEvent[] {
  return parseSituationEvents(getProfileSetting(profileId, "situation_events"));
}

// Pin-to-Trends — the profile's pinned Trends-Overview
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

// Saved views — named snapshots of the Trends hub state
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

// Per-profile dashboard customization — the widget order + hidden
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
//   calendar_feed_categories  JSON string[] of FeedCategory (default ["appointment"])
//   calendar_feed_reminders   "1" | "0"            (default "1" — emit VALARMs)
//   calendar_feed_past_days   integer string       (default "30")
//   calendar_feed_future_days integer string       (absent = unbounded horizon)
// Minimal is the default: the feed then reveals nothing but "Medical appointment"
// (+ location). Full is an explicit opt-in that sends provider/reason too. The
// customization keys (issue #12) all default to the historical appointments-only,
// reminders-on, 30-day-past, unbounded-future behaviour so an existing feed is
// unchanged until the user opts in.

export type CalendarFeedDetail = "minimal" | "full";

export interface CalendarFeed {
  enabled: boolean;
  detail: CalendarFeedDetail;
  // Content/window customization (issue #12).
  categories: FeedCategory[]; // which category kinds the feed emits
  reminders: boolean; // emit VALARM reminders on events
  pastWindowDays: number; // how far back a stale-but-scheduled item is carried
  futureWindowDays: number | null; // optional horizon; null = unbounded
  hasToken: boolean; // whether a token is minted (never exposes the token itself)
  // Token lifecycle (issue #24). ISO 8601 UTC strings, or null when absent.
  createdAt: string | null; // when the current token was minted
  lastUsedAt: string | null; // last successful feed fetch (throttled write)
  expiresAt: string | null; // optional expiry; null = never expires
}

export function getCalendarFeed(profileId: number): CalendarFeed {
  const detail = getProfileSetting(profileId, "calendar_feed_detail");
  const pastRaw = getProfileSetting(profileId, "calendar_feed_past_days");
  const futureRaw = getProfileSetting(profileId, "calendar_feed_future_days");
  const past = pastRaw != null ? Number(pastRaw) : NaN;
  const future = futureRaw != null ? Number(futureRaw) : NaN;
  return {
    enabled: getProfileSetting(profileId, "calendar_feed_enabled") === "1",
    detail: detail === "full" ? "full" : "minimal",
    categories: parseFeedCategories(
      getProfileSetting(profileId, "calendar_feed_categories")
    ),
    // Default ON: only an explicit "0" disables reminders.
    reminders: getProfileSetting(profileId, "calendar_feed_reminders") !== "0",
    pastWindowDays: Number.isFinite(past) ? clampFeedWindowDays(past) : 30,
    futureWindowDays: Number.isFinite(future)
      ? clampFeedWindowDays(future)
      : null,
    hasToken: !!getProfileSetting(profileId, "calendar_feed_token_hash"),
    createdAt:
      getProfileSetting(profileId, "calendar_feed_token_created_at") ?? null,
    lastUsedAt:
      getProfileSetting(profileId, "calendar_feed_token_last_used_at") ?? null,
    expiresAt:
      getProfileSetting(profileId, "calendar_feed_token_expires_at") ?? null,
  };
}

// Mint a fresh 256-bit token, store its hash, mark the feed enabled, and return
// the RAW token exactly once (for building the subscribe URL — it's never stored,
// so it can't be shown again). Rotating = calling this again: a new token, and the
// previous URL immediately stops resolving. `expiry` (issue #24) records an
// optional absolute expiry alongside the hash; "never" (default) preserves the
// historical no-expiry behaviour. A fresh mint clears the previous last-used stamp.
export function mintCalendarFeedToken(
  profileId: number,
  expiry: TokenExpiryChoice = "never"
): string {
  const token = crypto.randomBytes(32).toString("hex");
  const now = new Date();
  const expiresAt = expiresAtFromChoice(expiry, now.getTime());
  const write = db.transaction(() => {
    setProfileSetting(
      profileId,
      "calendar_feed_token_hash",
      hashShareToken(token)
    );
    setProfileSetting(profileId, "calendar_feed_enabled", "1");
    setProfileSetting(
      profileId,
      "calendar_feed_token_created_at",
      now.toISOString()
    );
    if (expiresAt) {
      setProfileSetting(profileId, "calendar_feed_token_expires_at", expiresAt);
    } else {
      deleteProfileSetting(profileId, "calendar_feed_token_expires_at");
    }
    deleteProfileSetting(profileId, "calendar_feed_token_last_used_at");
  });
  write();
  return token;
}

// Disable the feed (the route then 404s) and drop the token hash so the URL is
// dead even if re-enabled later without a fresh mint. Also clears the lifecycle
// stamps so a later re-enable starts clean. Idempotent.
export function disableCalendarFeed(profileId: number): void {
  const write = db.transaction(() => {
    setProfileSetting(profileId, "calendar_feed_enabled", "0");
    deleteProfileSetting(profileId, "calendar_feed_token_hash");
    deleteProfileSetting(profileId, "calendar_feed_token_created_at");
    deleteProfileSetting(profileId, "calendar_feed_token_expires_at");
    deleteProfileSetting(profileId, "calendar_feed_token_last_used_at");
  });
  write();
}

// Record a successful feed fetch, throttled to once an hour (mirrors the session
// sliding-refresh write in lib/auth) so a frequently-polled feed isn't written on
// every request. Best-effort: called from the token-authed route on the read path.
export function recordCalendarFeedUse(profileId: number): void {
  const last = getProfileSetting(profileId, "calendar_feed_token_last_used_at");
  if (!shouldRecordUse(last, Date.now())) return;
  setProfileSetting(
    profileId,
    "calendar_feed_token_last_used_at",
    new Date().toISOString()
  );
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

// The content/window customization the user controls (issue #12). Category list is
// validated + canonicalized, windows clamped, all written in one transaction. An
// unbounded future horizon (null) DELETES the key so the absence reads back as
// unbounded. detail is left to setCalendarFeedDetail (its own PHI-warned control).
export interface CalendarFeedOptionsInput {
  categories: readonly string[];
  reminders: boolean;
  pastWindowDays: number;
  futureWindowDays: number | null;
}

export function setCalendarFeedOptions(
  profileId: number,
  opts: CalendarFeedOptionsInput
): void {
  const categories = canonicalizeFeedCategories(opts.categories);
  const write = db.transaction(() => {
    setProfileSetting(
      profileId,
      "calendar_feed_categories",
      JSON.stringify(categories)
    );
    setProfileSetting(
      profileId,
      "calendar_feed_reminders",
      opts.reminders ? "1" : "0"
    );
    setProfileSetting(
      profileId,
      "calendar_feed_past_days",
      String(clampFeedWindowDays(opts.pastWindowDays))
    );
    if (opts.futureWindowDays != null && opts.futureWindowDays >= 0) {
      setProfileSetting(
        profileId,
        "calendar_feed_future_days",
        String(clampFeedWindowDays(opts.futureWindowDays))
      );
    } else {
      deleteProfileSetting(profileId, "calendar_feed_future_days");
    }
  });
  write();
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
  if (!enabled) return null;
  // An expired token (issue #24) is rejected exactly like a bad/disabled one — the
  // same uniform null → 404 with no oracle distinguishing expired from invalid.
  const expiresAt = getProfileSetting(
    profileId,
    "calendar_feed_token_expires_at"
  );
  if (isTokenExpired(expiresAt, Date.now())) return null;
  // Successful resolve → stamp last-used (throttled).
  recordCalendarFeedUse(profileId);
  return profileId;
}

// ---- Consolidated (per-LOGIN) calendar feed --------------------------------
// The "family calendar": a login-scoped .ics feed merging EVERY profile the login
// can currently access. Same token machinery as the per-profile feed (mint/rotate/
// disable/last-used/expiry via lib/token-lifecycle), but keyed by LOGIN in
// login_settings — which has `ON DELETE CASCADE` on logins(id), so deleting the
// login drops the token and the feed dies. Two deliberate differences from the
// per-profile feed:
//   1. NO detail level is stored here — the consolidated feed honors EACH profile's
//      own `calendar_feed_detail`, so a profile set to minimal contributes only
//      "Medical appointment" even inside the shared feed.
//   2. The set of profiles is resolved AT REQUEST TIME from live grants (see the
//      route), never frozen at mint — a revoked grant stops appearing immediately.
// Keys (login_settings): consolidated_calendar_feed_{enabled,token_hash,
//   token_created_at,token_last_used_at,token_expires_at}.

const CCF_KEY = {
  enabled: "consolidated_calendar_feed_enabled",
  hash: "consolidated_calendar_feed_token_hash",
  createdAt: "consolidated_calendar_feed_token_created_at",
  lastUsedAt: "consolidated_calendar_feed_token_last_used_at",
  expiresAt: "consolidated_calendar_feed_token_expires_at",
} as const;

export interface ConsolidatedCalendarFeed {
  enabled: boolean;
  hasToken: boolean;
  createdAt: string | null;
  lastUsedAt: string | null;
  expiresAt: string | null;
}

export function getConsolidatedCalendarFeed(
  loginId: number
): ConsolidatedCalendarFeed {
  return {
    enabled: getLoginSetting(loginId, CCF_KEY.enabled) === "1",
    hasToken: !!getLoginSetting(loginId, CCF_KEY.hash),
    createdAt: getLoginSetting(loginId, CCF_KEY.createdAt) ?? null,
    lastUsedAt: getLoginSetting(loginId, CCF_KEY.lastUsedAt) ?? null,
    expiresAt: getLoginSetting(loginId, CCF_KEY.expiresAt) ?? null,
  };
}

// Mint a fresh per-login token, store its hash, enable the feed, and return the RAW
// token once (never stored — can't be shown again). Rotating = calling this again:
// the previous URL immediately stops resolving. Mirrors mintCalendarFeedToken.
export function mintConsolidatedCalendarFeedToken(
  loginId: number,
  expiry: TokenExpiryChoice = "never"
): string {
  const token = crypto.randomBytes(32).toString("hex");
  const now = new Date();
  const expiresAt = expiresAtFromChoice(expiry, now.getTime());
  const write = db.transaction(() => {
    setLoginSetting(loginId, CCF_KEY.hash, hashShareToken(token));
    setLoginSetting(loginId, CCF_KEY.enabled, "1");
    setLoginSetting(loginId, CCF_KEY.createdAt, now.toISOString());
    if (expiresAt) setLoginSetting(loginId, CCF_KEY.expiresAt, expiresAt);
    else deleteLoginSetting(loginId, CCF_KEY.expiresAt);
    deleteLoginSetting(loginId, CCF_KEY.lastUsedAt);
  });
  write();
  return token;
}

// Disable the feed (route then 404s) and drop the token hash so the URL is dead.
// Also clears the lifecycle stamps so a later re-enable starts clean. Idempotent.
export function disableConsolidatedCalendarFeed(loginId: number): void {
  const write = db.transaction(() => {
    setLoginSetting(loginId, CCF_KEY.enabled, "0");
    deleteLoginSetting(loginId, CCF_KEY.hash);
    deleteLoginSetting(loginId, CCF_KEY.createdAt);
    deleteLoginSetting(loginId, CCF_KEY.expiresAt);
    deleteLoginSetting(loginId, CCF_KEY.lastUsedAt);
  });
  write();
}

// Record a successful feed fetch, throttled to once an hour (mirrors the per-profile
// feed + the session sliding-refresh write).
export function recordConsolidatedCalendarFeedUse(loginId: number): void {
  const last = getLoginSetting(loginId, CCF_KEY.lastUsedAt);
  if (!shouldRecordUse(last, Date.now())) return;
  setLoginSetting(loginId, CCF_KEY.lastUsedAt, new Date().toISOString());
}

// Resolve a raw token from the family feed URL to the owning LOGIN id, or null. The
// unauthenticated seam (a calendar client has no session): hash the caller-supplied
// token and match the stored hash across login_settings. Returns null unless a
// matching row exists AND its feed is still enabled AND unexpired — a uniform null →
// 404 with no oracle. login_settings is a settings tier (per-login, not
// profile-owned data), so this query is intentionally not profile-scoped, mirroring
// resolveProfileByCalendarToken. The returned login id drives request-time grant
// resolution in the route (a revoked grant stops appearing).
export function resolveLoginByConsolidatedCalendarToken(
  rawToken: string
): number | null {
  if (!rawToken) return null;
  const row = db
    .prepare(
      "SELECT login_id FROM login_settings WHERE key = 'consolidated_calendar_feed_token_hash' AND value = ?"
    )
    .get(hashShareToken(rawToken)) as { login_id?: number } | undefined;
  const loginId = row?.login_id;
  if (!loginId) return null;
  if (getLoginSetting(loginId, CCF_KEY.enabled) !== "1") return null;
  if (isTokenExpired(getLoginSetting(loginId, CCF_KEY.expiresAt), Date.now()))
    return null;
  recordConsolidatedCalendarFeedUse(loginId);
  return loginId;
}
