// Integrations domain types (registry defs, connection state, sync events,
// metric samples, HR minutes). Split out of lib/types.ts (#319); the `@/lib/types`
// barrel re-exports everything here, so import paths are unchanged.

// TYPE-ONLY (erased at build): `lib/hrefs` imports IntegrationId back from here, so a
// value import would be a real cycle. Route policy still lives there.
import type { AppRoute } from "../hrefs";

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

// The PULL facet (#2040): the declarative half of "this provider is one we pull on a
// schedule". Its presence is what makes a provider dispatchable — the generic
// "Sync now" action and the hourly tick iterate registered pull providers instead of
// naming four by hand, which is how the four copy-pasted action skeletons and the
// four copy-pasted tick blocks became one each.
//
// DATA ONLY. The runnable half (the `run` function) is bound in
// lib/integrations/pull-runners.ts, because binding it here would drag @/lib/db and
// the whole normalize/upsert stack behind every import of the registry — including
// the pure tier and the client components that render the grid.
export interface IntegrationPagingTunables {
  // Server-side per-request timeout, so a hung provider request never stalls the
  // hourly tick (it processes profiles sequentially).
  timeoutMs: number;
  // Safety cap on pages (or, for Strava, per-activity detail calls) per endpoint per
  // run: an unbounded pagination loop can't spin forever. Anything remaining at the
  // cap marks the run truncated.
  maxPages: number;
  // Trailing days re-fetched before the cursor each run, so a reading finalized or
  // edited a day or two late isn't skipped. Upserts are keyed, so this is free.
  rescanDays: number;
  // How far back the FIRST-EVER sync reaches when there is no cursor yet. 0 = no
  // bounded backfill; the first run reaches as far as the provider will go.
  backfillDays: number;
}

export interface IntegrationPullFacet {
  // The bounds of a PAGED credentialed pull. Absent for a pull provider that has no
  // credential, no cursor, and no pagination — Weather's keyless fixed rolling
  // window — because declaring numbers that govern nothing would be a fiction.
  paging?: IntegrationPagingTunables;
  // HOW OFTEN THIS PROVIDER MAY BE POLLED, in whole minutes (#2121 step 1). The tick
  // used to conflate two cadences: "how often do we evaluate what is due to send"
  // (bounded only by process boot) and "how often do we call someone else's API"
  // (bounded by their quota). Splitting them is what lets the tick go finer without
  // multiplying provider calls, and this is the quota-bounded half — declared here,
  // beside the provider's other delivery metadata, because the right number is a
  // property of the provider's quota, not of the scheduler.
  //
  // Absent = the safe default (DEFAULT_PULL_CADENCE_MINUTES, hourly), which is what
  // every provider was polled at before the split. Read ONLY through
  // pullCadenceMinutes (lib/integrations/pull-cadence.ts) so the guard, any future
  // operator surface, and the docs share one derivation.
  cadenceMinutes?: number;
  // The surfaces a completed run's data feeds. The one generic sync action
  // revalidates exactly these; lib/__tests__/nav-routes.test.ts sweeps them, since
  // `revalidatePath` takes a plain string that typedRoutes cannot check.
  revalidates: readonly AppRoute[];
}

export interface IntegrationBackfillFacet {
  // Stable provider-local operation id. It keys the durable job checkpoint and the
  // runnable binding; a provider may eventually expose several independent fills.
  id: string;
  label: string;
  itemNoun: string;
}

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
  // Present exactly on the providers allos PULLS on a schedule (#2040). Absent for
  // push, archive, feed, attended-external, and `planned` entries — there is nothing
  // to run for those, so nothing dispatches them.
  pull?: IntegrationPullFacet;
  // Optional enrichment of rows already imported. Metadata stays registry-pure;
  // executable runners bind separately in lib/integrations/backfill-runners.ts.
  backfills?: readonly IntegrationBackfillFacet[];
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
