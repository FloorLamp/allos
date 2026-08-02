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
// on the profile (the home location), e.g. Open-Meteo weather/UV (#1172); 'archive' =
// the user hands us an export FILE they downloaded from the vendor — no account, no
// credential, no schedule, and nothing to reconnect (Fitbit via Google Takeout). It is
// the only kind with no ongoing connection: an import is an event, not a link.
// The EXECUTION MODE of an integration, not its data domain. The registry already spans
// modes allos cannot drive itself — `archive` is a file the user acquires elsewhere and
// imports by hand, `feed` is outbound-only — so `external-attended` (#1739) is a new kind
// rather than a new concept: an external, attended tool runs on the USER'S machine
// (portal 2FA needs a person and sessions idle out in minutes), and pushes results in
// through the token-authenticated upload API. Allos never executes it and never holds its
// address; it only records what the tool reports.
export type IntegrationKind =
  | "push"
  | "oauth"
  | "token"
  | "feed"
  | "public"
  | "archive"
  | "external-attended";

// 'available' integrations can be configured now; 'planned' render as a preview.
export type IntegrationStatus = "available" | "planned";

export type IntegrationId =
  | "health-connect"
  | "strava"
  | "oura"
  | "withings"
  | "garmin"
  | "weather"
  | "calendar-feed"
  | "fitbit-takeout"
  | "patient-portals";

// A row in the integrations registry — the Integrations page renders from these.
export interface IntegrationDef {
  id: IntegrationId;
  name: string;
  kind: IntegrationKind;
  status: IntegrationStatus;
  blurb: string;
  dataTypes: string[];
  docsUrl?: string;
  // How many whole days a CONNECTED provider may go without a successful sync before
  // it is treated as silently stopped (#1685). The transient-vs-definitive classifier
  // (lib/integrations/auth-failure.ts, #326) deliberately keeps a 429/5xx/timeout from
  // tearing down a healthy connection, and the failing-provider detector only fires
  // when the provider's LATEST event is a failure — neither covers a connection that
  // records nothing at all (a phone exporter that stopped pushing, a refresh that
  // never gets far enough to log). This threshold is that cover: it belongs beside the
  // provider's other metadata because the right number is a property of how the
  // provider delivers, not of the detector.
  //
  // NULL = exempt, and exemption is a statement about the provider: a manual archive
  // import has no cadence to be late against, and a planned/outbound entry never syncs
  // inbound at all. Read ONLY through syncStalenessThreshold (lib/integrations/
  // staleness.ts) so the badge, the attention item, and the digest line share one
  // derivation (#221).
  staleAfterDays?: number | null;
  // The consequence of THIS provider being broken, in user terms (#1880 item 2):
  // what stops arriving, named the way the user thinks of it ("measurements from
  // your scale and cuff"), not by transport. Rendered on the escalated Review card
  // through failureConsequence (lib/integrations/provider-state.ts), which owns
  // the generic fallback for providers that don't declare one.
  stoppedConsequence?: string;
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
