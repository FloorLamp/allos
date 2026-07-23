// Integrations domain types (registry defs, connection state, sync events,
// metric samples, HR minutes). Split out of lib/types.ts (#319); the `@/lib/types`
// barrel re-exports everything here, so import paths are unchanged.

// ---- Integrations ----

// How a provider delivers data: 'push' (the source POSTs to us, e.g. Health
// Connect via an exporter app), 'oauth' (we connect and pull, e.g. Strava/Garmin),
// or 'feed' (we EXPOSE data for an external subscriber to pull — the calendar
// subscribe feed, where a calendar client polls our token-authed .ics URL).
// 'push' = phone exporter POSTs to us (Health Connect); 'oauth' = OAuth pull with a
// redirect/callback (Strava); 'token' = pull with a pasted personal access token, no
// OAuth app/redirect/callback (Oura); 'feed' = outbound subscription (calendar);
// 'public' = keyless pull needing NO account/credential — just a prerequisite already
// on the profile (the home location), e.g. Open-Meteo weather/UV (#1172).
export type IntegrationKind = "push" | "oauth" | "token" | "feed" | "public";

// 'available' integrations can be configured now; 'planned' render as a preview.
export type IntegrationStatus = "available" | "planned";

export type IntegrationId =
  | "health-connect"
  | "strava"
  | "oura"
  | "withings"
  | "garmin"
  | "weather"
  | "calendar-feed";

// A row in the integrations registry — the Integrations page renders from these.
export interface IntegrationDef {
  id: IntegrationId;
  name: string;
  kind: IntegrationKind;
  status: IntegrationStatus;
  blurb: string;
  dataTypes: string[];
  docsUrl?: string;
}

// Persisted connection state for a provider (integration_connections table).
// `needs_reauth` (issue #326) is the terminal-until-user-acts state a provider lands
// in after a DEFINITIVE auth failure (a dead/revoked refresh token or PAT): the
// hourly tick only auto-syncs `connected` rows, so it stops re-attempting forever,
// and the UI surfaces a "Reconnect" prompt. Stored in the existing bare-TEXT `status`
// column (no schema change); the value set is enforced at the single upsertConnection
// writer.
export type IntegrationConnectionStatus =
  "connected" | "disconnected" | "needs_reauth";

export interface IntegrationConnection {
  profile_id: number;
  provider: string;
  status: IntegrationConnectionStatus;
  config: string | null; // JSON: { token } for push; OAuth tokens for pull
  last_sync_at: string | null;
  last_sync_summary: string | null; // JSON counts
  created_at: string;
  updated_at: string;
}

// One append-only debug record of an integration sync (integration_sync_events).
// Written best-effort by the Health Connect ingest (one per POST) and the Strava
// sync (one per run), and read back by the "Recent activity" debug panel on the
// setup pages. Profile-scoped; `ok` is 1/0; count/window/error columns are nullable.
export interface IntegrationSyncEvent {
  id: number;
  profile_id: number;
  provider: string;
  at: string;
  ok: number; // 1 = success, 0 = failure
  window_start: string | null;
  window_end: string | null;
  received: number | null;
  written: number | null;
  // Real insert/update/unchanged accounting. Null on legacy rows recorded
  // before the split columns existed — the Review feed falls back to `written`.
  inserted: number | null;
  updated: number | null;
  unchanged: number | null;
  // Rows the source re-sent that a re-import tombstone held out (#507/#508). Null on
  // legacy rows recorded before the column existed.
  suppressed: number | null;
  // Rows the source re-sent that the user-edit lock held out (#133/#659). Null on
  // legacy rows recorded before the column existed (migration 033).
  edited: number | null;
  skipped: number | null;
  // Optional structured diagnostics for a successful sync (currently Health
  // Connect exporter-shape warnings and within-source origin choices).
  details?: string | null;
  // Bare filename of the captured raw provider payload under
  // data/integration-payloads/<profile_id>/ (issue #9), or null. Read back only by
  // the admin-only raw viewer route; never surfaced to members.
  raw_ref: string | null;
  error: string | null;
  created_at: string;
}

// One ingested record for a summable/scalar daily metric (metric_samples table).
export interface MetricSample {
  id: number;
  source: string;
  origin: string | null;
  metric: string;
  date: string;
  start_time: string;
  end_time: string;
  value: number;
}

// A 1-minute heart-rate bucket (hr_minutes table).
export interface HrMinute {
  ts: string; // 'YYYY-MM-DDTHH:MM'
  bpm: number; // count-weighted average
  bpm_min: number | null;
  bpm_max: number | null;
  n: number;
  source: string | null;
}
