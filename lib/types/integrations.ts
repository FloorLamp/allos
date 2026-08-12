// Integrations domain types (registry defs, connection state, sync events,
// metric samples, HR minutes). Split out of lib/types.ts (#319); the `@/lib/types`
// barrel re-exports everything here, so import paths are unchanged.

// TYPE-ONLY (erased at build): `lib/hrefs` imports IntegrationId back from here, so a
// value import would be a real cycle. Route policy still lives there.
import type { RevalidateTarget } from "../revalidate";

// ---- Integrations ----

// How a source delivers data: 'push' (the source POSTs to us, e.g. Health
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

// The PULL facet (#2040): the declarative half of "this source is one we pull on a
// schedule". Its presence is what makes a source dispatchable — the generic
// "Sync now" action and the hourly tick iterate registered pull sources instead of
// naming four by hand, which is how the four copy-pasted action skeletons and the
// four copy-pasted tick blocks became one each.
//
// DATA ONLY. The runnable half (the `run` function) is bound in
// lib/integrations/pull-runners.ts, because binding it here would drag @/lib/db and
// the whole normalize/upsert stack behind every import of the registry — including
// the pure tier and the client components that render the grid.
export interface IntegrationPagingTunables {
  // Server-side per-request timeout, so a hung source request never stalls the
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
  // bounded backfill; the first run reaches as far as the source will go.
  backfillDays: number;
}

export interface IntegrationPullFacet {
  // The bounds of a PAGED credentialed pull. Absent for a pull source that has no
  // credential, no cursor, and no pagination — Weather's keyless fixed rolling
  // window — because declaring numbers that govern nothing would be a fiction.
  paging?: IntegrationPagingTunables;
  // HOW OFTEN THIS SOURCE MAY BE POLLED, in whole minutes (#2121 step 1). The tick
  // used to conflate two cadences: "how often do we evaluate what is due to send"
  // (bounded only by process boot) and "how often do we call someone else's API"
  // (bounded by their quota). Splitting them is what lets the tick go finer without
  // multiplying source calls, and this is the quota-bounded half — declared here,
  // beside the source's other delivery metadata, because the right number is a
  // property of the source's quota, not of the scheduler.
  //
  // Absent = the safe default (DEFAULT_PULL_CADENCE_MINUTES, hourly), which is what
  // every source was polled at before the split. Read ONLY through
  // pullCadenceMinutes (lib/integrations/pull-cadence.ts) so the guard, any future
  // operator surface, and the docs share one derivation.
  cadenceMinutes?: number;
  // The surfaces a completed run's data feeds. The one generic sync action fans
  // `revalidateRoute` over exactly these, so each is checked against the real route
  // tree by the compiler (#2149) — a retired surface can no longer go quietly
  // un-revalidated on every manual sync.
  revalidates: readonly RevalidateTarget[];
}

// ── The CONTINUOUS STREAM facet (#2146) ──────────────────────────────────────
//
// A source's connection can be green while one of its data streams has gone
// silent — a watch off the wrist while the phone keeps pushing daily aggregates.
// Seeing that needs one thing the app did not have: a DECLARATION of which of a
// source's streams are supposed to be arriving continuously, and what "quiet"
// means for each. This is that declaration, and it lives beside
// `silenceToleranceMinutes` for the same reason that one does — the right numbers
// are properties of how the source delivers, not of any one detector.
//
// A source with NO continuous streams (weather, the calendar feed, patient
// portals, a Takeout archive) simply declares none and is exempt BY CONSTRUCTION
// rather than by a special case in the detector.
//
// SHAPED TO BE THE ENUMERATION, not just a tolerance (#2162). Each entry is a
// NAMED stream with independently-optional facets hanging off it — `quiet` is the
// #2146 detection facet, `reminder` is the #2161 send adapter that watches the same
// stream — so a later lifecycle feature enumerates streams and asks which facets
// they carry, instead of needing this shape widened first. Adding a facet is adding
// an optional key; adding a stream is adding an entry.

// Which physical store a stream's rows land in. A UNION, not a free string: the
// query layer binds one reader per member (lib/queries/continuous-streams.ts), the
// same DATA-HERE / RUNNABLE-THERE split the `pull` facet uses, so the registry stays
// importable from the pure tier and no SQL is ever built from a declaration.
export type ContinuousStreamTable = "hr_minutes";

// Stable, source-local stream id. It keys the #2162 lifecycle and the date-scoped
// suppression key, so it must not be renamed once shipped.
export type ContinuousStreamId = "heart-rate";

// The send adapter watching a stream, when one exists (#2161). Declared here so
// "which streams have a reminder" is answered by reading the registry rather than by
// a module knowing a source id by heart.
export type ContinuousStreamReminderId = "bedtime-wear";

// How long a stream may DIP before its silence means something, and why that number.
// DECLARED, never inferred (#2146 constraint 2): there is no wear-pattern learner
// here and there must not be one — the threshold is a policy about when it is worth
// telling someone, and measurement's job is to check the policy clears the stream's
// ordinary variance, not to set it.
//
// SINCE #2341 IT IS A FLOOR, NOT THE DECISION. The discriminator is whether the
// stream's frontier MOVED across the last pushes (lib/stream-frontier.ts); this number
// bounds the frontier's own age on top of that, so a stream that went quiet two
// minutes ago is not announced on the strength of two quiet pushes. The quantity it
// bounds no longer contains the ingest-lag term that made it unthresholdable.
export interface ContinuousStreamQuietFacet {
  dipToleranceMin: number;
  // The evidence behind the number, carried as data so it is impossible to move the
  // threshold without restating why. Rendered nowhere; read by humans and by the
  // registry completeness test.
  because: string;
  // The rendered row's TAIL: what to check, and what this particular stream's silence
  // costs while it lasts. Distinct from the source-wide `stoppedConsequence`, which
  // is about the whole connection dying. It ASKS rather than instructs (#2097's copy
  // rule) — an observation domain carries no obligation, so "put your watch on" would
  // be an implied *should* the app has no standing to state.
  prompt: string;
}

// "Is this stream expected to be active at all?" — the SHARED #2097/#2146 shape, in
// the declaration rather than in either predicate. #2097 answers it for sleep as
// "at least `minDays` of the last `windowDays` carry a recorded night"; this is the
// same question about the same kind of stream, so it is the same predicate
// (lib/stream-activity.ts) with the window declared per stream.
//
// Without it, a watch abandoned three weeks ago is "quiet" every single day forever:
// the phone keeps syncing, so nothing else can see it either. With it, the row
// describes an interruption in something that WAS happening, which is the only thing
// it is honest to describe.
export interface ContinuousStreamActivityWindow {
  windowDays: number;
  minDays: number;
}

// The #2161 send adapter watching a stream, as a DECLARATION rather than a bare id
// (#2341).
//
// The reminder's threshold used to be `WEAR_QUIET_TOLERANCE_MIN`, a bare constant in
// lib/wear-reminder.ts — while the quiet facet's sibling threshold for the SAME stream
// lived here with its evidence beside it. One stream, two thresholds, opposite answers
// on the same night, and the one that was wrong was the one living away from its
// sibling: it never got the scrutiny the declared one got. #2146 moved stream
// declarations into the registry precisely so "what does this stream expect" has one
// answer; this is that threshold finally joining it.
export interface ContinuousStreamReminderFacet {
  id: ContinuousStreamReminderId;
  // A FLOOR on the frontier's own age, in whole minutes — not the decision. The
  // decision is whether the frontier moved across the last pushes
  // (lib/stream-frontier.ts); this stops a watch removed moments before the slot from
  // being announced on two quiet pushes.
  frontierFloorMin: number;
  // The evidence behind the number, carried as data exactly as `quiet.because` is, so
  // it is impossible to move the threshold without restating why.
  because: string;
}

// How much evidence a FROZEN frontier needs before it means anything, declared per
// stream (#2560).
//
// It used to be one shared constant in lib/stream-frontier.ts, defended there as "a
// property of what a push MEANS, not of any one stream's wear pattern". That argument
// was made against a measurement taken on the wrong leg. There are TWO batching stages
// on the Health Connect pipeline —
//
//     watch --(Bluetooth, batches coarsely)--> phone Health Connect
//           --(exporter, ~15 min)-----------> allos
//
// — and #2422 measured only the second. While a watch's own batch is pending, healthy
// pushes land carrying nothing new for the stream and the frontier is frozen with the
// watch on the wrist the whole time. How many pushes it takes for the SOURCE's state to
// be reflected is therefore a property of THAT source's delivery chain: a device
// writing straight into its vendor cloud would need 1. That is exactly the kind of fact
// `dipToleranceMin` and `frontierFloorMin` already live here to carry, and #2341 item 2
// moved the last constant that got this wrong for the same reason.
export interface ContinuousStreamFrozenEvidence {
  // N — successive successful pushes that must land WITHOUT advancing the frontier
  // before it may be called frozen.
  syncs: number;
  // The evidence behind the number, carried as data exactly as `quiet.because` is, so
  // it is impossible to move the bar without restating why.
  because: string;
}

export interface ContinuousStreamDef {
  id: ContinuousStreamId;
  // What the user calls this stream, lowercase, for mid-sentence use
  // ("no heart-rate data has arrived since …").
  label: string;
  table: ContinuousStreamTable;
  // Rows per hour while the stream is genuinely active. Not used as a threshold —
  // the tolerance is — but it is what makes the tolerance readable: 60 rows/hour
  // means a 2.5-hour tolerance is ~150 missing rows, not a rounding error.
  rowsPerHour: number;
  expectedActive: ContinuousStreamActivityWindow;
  // The DECISION's evidence bar (#2560). Required, so a new stream cannot inherit an
  // accidental default from the module that owns the fold.
  frozenEvidence: ContinuousStreamFrozenEvidence;
  // The #2146 detection facet. Absent = this stream is enumerated (so #2162 can
  // offer it) but never reported quiet.
  quiet?: ContinuousStreamQuietFacet;
  // The #2161 send adapter watching this stream, when one exists — the adapter's id
  // AND the threshold it is asked at (#2341).
  reminder?: ContinuousStreamReminderFacet;
}

// ── The ARCHIVE REFRESH facet (#2164) ────────────────────────────────────────
//
// A `kind: "archive"` source is a one-off import, not a connection: it has no
// cadence to be late against, which is why it declares `silenceToleranceMinutes:
// null` and why no connection-level detector can see it going stale. But some of its
// data reaches allos through NO OTHER PATH — Fitbit does not forward scale weight,
// body fat, or its own sleep/readiness scores to Health Connect — so those streams are
// exactly as fresh as the last manual download, silently and indefinitely.
//
// This facet declares WHICH streams only the archive can deliver and HOW LONG they may
// age, in the same place and for the same reason `silenceToleranceMinutes` and
// `continuousStreams` live here: the right numbers are properties of how the source
// delivers. DECLARED, never inferred (#2164 constraint 2) — there is no learner here
// and there must not be one.
//
// A source that declares no facet raises nothing, so exemption is by construction
// rather than by an exemption list in the detector. Read ONLY through
// lib/integrations/archive-refresh.ts.

// Which physical store an archive-exclusive stream's rows land in. A UNION, not a free
// string, and a DISCRIMINATED one: the query layer binds one reader per member
// (lib/queries/upcoming/records-recency.ts), the same DATA-HERE / RUNNABLE-THERE split
// the `pull` and `continuousStreams` facets use, so the registry stays importable from
// the pure tier and no SQL is ever built out of a declaration.
export type ArchiveStreamSelector =
  | { table: "body_metrics"; column: "weight_kg" | "body_fat_pct" }
  | { table: "metric_samples"; metric: string };

export interface ArchiveExclusiveStreamDef {
  // Stable, source-local stream id. It appears in no persisted key today, but the
  // registry completeness test pins it, so treat it as shipped vocabulary.
  id: string;
  // What the user calls this stream, lowercase, for mid-sentence use
  // ("weight, body fat and sleep score reach allos only through …").
  label: string;
  selector: ArchiveStreamSelector;
  // WHY only the archive can deliver it, carried as data so it is impossible to add a
  // stream here without stating the claim. Rendered nowhere; read by humans and by the
  // registry completeness test.
  because: string;
}

export interface IntegrationArchiveRefreshFacet {
  // How many days the newest archive-sourced DATA may age before the ask is raised.
  // Stale STRICTLY after it (lib/freshness.ts).
  horizonDays: number;
  // The evidence behind the number, carried as data — the same discipline as
  // ContinuousStreamQuietFacet.because.
  because: string;
  // The streams only this archive can deliver. Empty is not allowed: a source with
  // nothing exclusive omits the whole facet.
  streams: readonly ArchiveExclusiveStreamDef[];
}

export interface IntegrationBackfillFacet {
  // Stable source-local operation id. It keys the durable job checkpoint and the
  // runnable binding; a source may eventually expose several independent fills.
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
  // How many MINUTES a CONNECTED source may go without a successful run before it
  // is treated as broken (#2263). This is THE escalation rule — the one question
  // "how long may this source be silent before it is broken?", asked once. It
  // replaced a pair that answered it at two incompatible grains: a consecutive-failed-
  // RUN count (three runs = three hours for an hourly source, below that source's
  // own p90 gap between successes) and a whole-DAY staleness threshold. Silence is
  // silence whether it was recorded as failures, recorded as nothing, or a mix, so
  // one measure covers both — and neither over-reports an idempotent source whose
  // next good run catches everything up.
  //
  // It belongs beside the source's other metadata because the right number is a
  // property of how the source delivers, not of the detector.
  //
  // ABSENT = derive it from the source's declared poll cadence
  // (DEFAULT_SILENCE_TOLERANCE_POLLS × cadence). A source with NO declared cadence
  // — a `push` source has no poll interval — must state a number or an explicit
  // null; a registry completeness test fails an undeclared one.
  //
  // NULL = exempt, and exemption is a statement about the source: a manual archive
  // import has no cadence to be late against, and a planned/outbound entry never syncs
  // inbound at all. Read ONLY through silenceToleranceMinutes (lib/integrations/
  // staleness.ts) so the badge, the attention item, and the digest line share one
  // derivation (#221).
  silenceToleranceMinutes?: number | null;
  // The consequence of THIS source being broken, in user terms (#1880 item 2):
  // what stops arriving, named the way the user thinks of it ("measurements from
  // your scale and cuff"), not by transport. Rendered on the escalated Review card
  // through failureConsequence (lib/integrations/source-state.ts), which owns
  // the generic fallback for sources that don't declare one.
  stoppedConsequence?: string;
  // Present exactly on the sources allos PULLS on a schedule (#2040). Absent for
  // push, archive, feed, attended-external, and `planned` entries — there is nothing
  // to run for those, so nothing dispatches them.
  pull?: IntegrationPullFacet;
  // The source's CONTINUOUS streams (#2146) — the ones expected to keep arriving
  // minute after minute while the device is worn, as opposed to the daily aggregates
  // and event rows that arrive when something happens. Absent = none, which is a
  // statement about the source (weather, an outbound feed, attended portals and a
  // one-off archive have no continuous stream to be silent), and the reason the
  // quiet-stream detector needs no per-source exemption list. Read ONLY through
  // lib/integrations/continuous-streams.ts.
  continuousStreams?: readonly ContinuousStreamDef[];
  // The streams only a `kind: "archive"` import can deliver, and how long they may age
  // before the refresh ask is raised (#2164). Absent = nothing here is archive-only, so
  // there is nothing to fall behind — which is every source except the Takeout
  // archive. Read ONLY through lib/integrations/archive-refresh.ts.
  archiveRefresh?: IntegrationArchiveRefreshFacet;
  // Optional enrichment of rows already imported. Metadata stays registry-pure;
  // executable runners bind separately in lib/integrations/backfill-runners.ts.
  backfills?: readonly IntegrationBackfillFacet[];
}

// Persisted connection state for a source (integration_connections table).
// `needs_reauth` (issue #326) is the terminal-until-user-acts state a source lands
// in after a DEFINITIVE auth failure (a dead/revoked refresh token or PAT): the
// hourly tick only auto-syncs `connected` rows, so it stops re-attempting forever,
// and the UI surfaces a "Reconnect" prompt. Stored in the existing bare-TEXT `status`
// column (no schema change); the value set is enforced at the single upsertConnection
// writer.
export type IntegrationConnectionStatus =
  "connected" | "disconnected" | "needs_reauth";

export interface IntegrationConnection {
  profile_id: number;
  // THE #2487 BOUNDARY. In TypeScript an integration source is a `sourceId`; the
  // persisted column is still named `provider`, and renaming it is deferred to its own
  // forward migration. Every read of this table therefore selects
  // `provider AS source_id` explicitly — the alias IS the mapping, so no shared domain
  // type is left carrying two meanings for one word.
  source_id: string;
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
  // The #2487 boundary again: the column is still `provider`, every read aliases it to
  // `source_id`. See IntegrationConnection.source_id.
  source_id: string;
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
  // Bare filename of the captured raw source payload under
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
