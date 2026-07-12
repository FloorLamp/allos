import { DEFAULT_TIMEZONE, isValidTimezone } from "../timezone";
import { clampAuditRetentionMonths } from "../retention";
import { db, writeTx } from "../db";
import { getSetting, setSetting } from "./kv";
import {
  clampMaxRunsPerDay,
  DEFAULT_MAX_RUNS_PER_DAY,
} from "../recommendation-run";

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
  writeTx(() => {
    setSetting("backup_enabled", cfg.enabled ? "1" : "0");
    setSetting("backup_hour", String(cfg.hour));
    setSetting("backup_keep_daily", String(cfg.keepDaily));
    setSetting("backup_keep_weekly", String(cfg.keepWeekly));
  });
}

// Audit-log retention window (issue #98), stored app-globally as a whole-month
// count. The `audit_events` trail is deliberately durable, but a self-hosted box
// still wants a bound; this is the admin-tunable window (Settings → Server) the
// hourly notify tick prunes against. Absent/garbage → the generous default.
export function getAuditRetentionMonths(): number {
  const raw = getSetting("audit_retention_months");
  return clampAuditRetentionMonths(Number(raw));
}

export function setAuditRetentionMonths(months: number): void {
  setSetting(
    "audit_retention_months",
    String(clampAuditRetentionMonths(months))
  );
}

// AI automation knobs, stored app-globally in the settings table.
export interface AiPrefs {
  // Auto-generate supplement suggestions when new/changed biomarkers are
  // imported (see autoSuggestFromBiomarkers). On by default. This is the
  // document-imported trigger's enable for the supplement half of a run (#424).
  autoSupplementSuggestions: boolean;
  // The global ceiling on AI recommendation runs per profile per day (issue
  // #424). Scheduled cadence already caps at 1/day; this backstops upload/manual
  // bursts. Admin-set; clamped 1..24.
  recommendationMaxRunsPerDay: number;
}

export function getAiPrefs(): AiPrefs {
  return {
    autoSupplementSuggestions:
      (getSetting("ai_auto_supplement_suggestions") ?? "1") === "1",
    recommendationMaxRunsPerDay: getRecommendationMaxRunsPerDay(),
  };
}

export function setAiPrefs(prefs: AiPrefs): void {
  setSetting(
    "ai_auto_supplement_suggestions",
    prefs.autoSupplementSuggestions ? "1" : "0"
  );
  setRecommendationMaxRunsPerDay(prefs.recommendationMaxRunsPerDay);
}

// The global per-profile daily cap on recommendation runs (issue #424). Stored
// app-globally; read/clamped through the pure clampMaxRunsPerDay so a bad stored
// value can never disable the backstop. Default 1.
export function getRecommendationMaxRunsPerDay(): number {
  const raw = getSetting("recommendation_max_runs_per_day");
  return clampMaxRunsPerDay(
    raw != null ? Number(raw) : DEFAULT_MAX_RUNS_PER_DAY
  );
}

export function setRecommendationMaxRunsPerDay(n: number): void {
  setSetting("recommendation_max_runs_per_day", String(clampMaxRunsPerDay(n)));
}
