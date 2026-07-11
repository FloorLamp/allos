import { db } from "@/lib/db";
import type { IntegrationSyncEvent } from "@/lib/types";
import {
  currentlyFailingProviders,
  shouldShowConnectedSource,
} from "@/lib/integrations/sync-log";
import { INTEGRATIONS } from "@/lib/integrations/registry";
import { getConnection } from "@/lib/integrations/connections";
import {
  findActivityDuplicates,
  findBodyMetricConflicts,
  undecidedPairs,
  ACTIVITY_DOMAIN,
  BODY_METRIC_DOMAIN,
  type ActivityDupInput,
  type ActivityDupPair,
  type BodyMetricConflictInput,
  type BodyMetricConflictPair,
  type PairDecision,
} from "@/lib/import-review/detect";

// Read side of the integration sync-event debug log. Every statement here is
// PROFILE-SCOPED (WHERE profile_id = ? AND provider = ?): the setup-page panels and
// the grid cards resolve the profile from requireSession(), and the Health Connect
// ingest writes its events under the token-resolved profile, so a profile sees
// exactly its own device's sync history.

// Recent sync events for one provider, newest first — the debug panel's table.
export function getIntegrationSyncEvents(
  profileId: number,
  provider: string,
  limit = 15
): IntegrationSyncEvent[] {
  return db
    .prepare(
      `SELECT * FROM integration_sync_events
        WHERE profile_id = ? AND provider = ?
        ORDER BY at DESC, id DESC
        LIMIT ?`
    )
    .all(profileId, provider, limit) as IntegrationSyncEvent[];
}

// Timestamp of the most recent SUCCESSFUL sync for a provider, or null — powers the
// "last successful sync" hint on the setup page and the grid card.
export function getLastSuccessfulSyncAt(
  profileId: number,
  provider: string
): string | null {
  const row = db
    .prepare(
      `SELECT at FROM integration_sync_events
        WHERE profile_id = ? AND provider = ? AND ok = 1
        ORDER BY at DESC, id DESC
        LIMIT 1`
    )
    .get(profileId, provider) as { at: string } | undefined;
  return row?.at ?? null;
}

// All recent sync events for a profile across EVERY provider, newest first — the
// feed behind the Data → Review tab (contrast getIntegrationSyncEvents, which is
// per-provider). Profile-scoped.
export function getRecentSyncEvents(
  profileId: number,
  limit = 30
): IntegrationSyncEvent[] {
  return db
    .prepare(
      `SELECT * FROM integration_sync_events
        WHERE profile_id = ?
        ORDER BY at DESC, id DESC
        LIMIT ?`
    )
    .all(profileId, limit) as IntegrationSyncEvent[];
}

// How many items the Data → Review inbox wants the user's attention on — the count
// behind the profile-menu badge. Two contributions (issue #10): integrations
// CURRENTLY in a failed state (self-clearing on the next good sync) PLUS unresolved
// detected duplicate/conflict pairs. Both are profile-scoped.
export function getImportReviewCount(profileId: number): number {
  return (
    currentlyFailingProviders(getRecentSyncEvents(profileId, 100)).length +
    getReviewPairCount(profileId)
  );
}

// ── Duplicate/conflict detection + durable decisions (issue #10, Phase 2) ──────
//
// The detection MATH is pure (lib/import-review/detect); this layer only (a) loads
// the profile's own rows, (b) runs the detectors, and (c) filters out pairs the
// user has already resolved via a durable decision. Every statement is
// PROFILE-SCOPED (WHERE profile_id = ?).

// A detected activity row with the display field (title) the UI shows alongside the
// detection fields, plus the numeric fold columns the conflict preview (issue #100)
// compares. Extra fields flow through the generic detectors untouched.
export interface ActivityDupRow extends ActivityDupInput {
  title: string;
  // Numeric magnitude fold-fields — the ones detectFieldConflicts can surface as a
  // per-field conflict (duration_min/distance_km already on ActivityDupInput).
  elevation_m: number | null;
  avg_hr: number | null;
  max_hr: number | null;
  avg_speed_kmh: number | null;
  max_speed_kmh: number | null;
  relative_effort: number | null;
  avg_power_w: number | null;
  max_power_w: number | null;
  weighted_avg_power_w: number | null;
  avg_cadence: number | null;
  kilojoules: number | null;
  avg_temp_c: number | null;
}

// A detected body-metrics row plus its notes for display.
export interface BodyMetricConflictRow extends BodyMetricConflictInput {
  notes: string | null;
}

// The candidate set for activity dedup, PRE-FILTERED in SQL to only the
// (date, type) buckets the pure detector could ever pair. This matters because the
// profile-menu badge runs detection on every app-page render (getImportReviewCount
// is threaded through the layout): without the pre-filter a years-deep Health
// Connect history would be loaded and bucketed in JS on every navigation. Most days
// have a single row, so this typically returns a handful of rows.
//
// The detector pairs a bucket when EITHER:
//   (a) it spans ≥2 provenances (a CROSS-SOURCE pair — manual vs an integration, or
//       two different integrations), OR
//   (b) since issue #64, ≥2 rows share ONE non-manual provenance (a SAME-SOURCE
//       pair — e.g. two `strava` rows from upstream double-feeding).
// (a) is `COUNT(DISTINCT COALESCE(source,'manual')) > 1`. (b) is expressed without
// re-counting manual rows: among NON-NULL-source rows, if the row count exceeds the
// number of distinct non-null sources then some non-manual source repeats
// (COUNT(DISTINCT source) ignores NULLs). This deliberately does NOT fire for a
// bucket whose only repeat is two MANUAL rows — those pairs are excluded by design
// (sameSourceDuplicate / crossSource), so loading them would be pure waste.
function loadActivityDupRows(profileId: number): ActivityDupRow[] {
  return db
    .prepare(
      `SELECT a.id, a.date, a.type, a.title, a.source, a.external_id,
              a.duration_min, a.distance_km, a.start_time, a.end_time,
              a.elevation_m, a.avg_hr, a.max_hr, a.avg_speed_kmh, a.max_speed_kmh,
              a.relative_effort, a.avg_power_w, a.max_power_w,
              a.weighted_avg_power_w, a.avg_cadence, a.kilojoules, a.avg_temp_c
         FROM activities a
         JOIN (SELECT date, type FROM activities
                WHERE profile_id = ?
                GROUP BY date, type
               HAVING COUNT(DISTINCT COALESCE(source, 'manual')) > 1
                   OR SUM(CASE WHEN source IS NOT NULL THEN 1 ELSE 0 END)
                        > COUNT(DISTINCT source)) m
           ON m.date = a.date AND m.type = a.type
        WHERE a.profile_id = ?`
    )
    .all(profileId, profileId) as ActivityDupRow[];
}

// Body-metric conflicts include duplicate MANUAL rows (same date, same source),
// so the pre-filter keeps any date carrying more than one row at all — still a
// tiny set (one row per day is the norm; body_metrics keys on (date, source)).
function loadBodyMetricConflictRows(
  profileId: number
): BodyMetricConflictRow[] {
  return db
    .prepare(
      `SELECT b.id, b.date, b.weight_kg, b.body_fat_pct, b.resting_hr, b.source, b.notes
         FROM body_metrics b
         JOIN (SELECT date FROM body_metrics
                WHERE profile_id = ?
                GROUP BY date
               HAVING COUNT(*) > 1) m
           ON m.date = b.date
        WHERE b.profile_id = ?`
    )
    .all(profileId, profileId) as BodyMetricConflictRow[];
}

// The profile's recorded decisions for a domain, as signature → decision. Used to
// suppress already-resolved pairs and (in the actions) to keep a re-decision an
// upsert rather than a duplicate row.
export function getPairDecisions(
  profileId: number,
  domain: string
): Map<string, PairDecision> {
  const rows = db
    .prepare(
      `SELECT pair_signature, decision
         FROM import_pair_decisions
        WHERE profile_id = ? AND domain = ?`
    )
    .all(profileId, domain) as {
    pair_signature: string;
    decision: PairDecision;
  }[];
  return new Map(rows.map((r) => [r.pair_signature, r.decision]));
}

// Record (or re-record) the user's terminal decision on a pair. Upserts on the
// stable (profile_id, domain, pair_signature) key, so re-deciding a pair — or the
// same pair resurfacing after a re-sync — just overwrites the row rather than
// stacking. Profile-scoped.
export function recordPairDecision(
  profileId: number,
  domain: string,
  signature: string,
  decision: PairDecision
): void {
  db.prepare(
    `INSERT INTO import_pair_decisions (profile_id, domain, pair_signature, decision)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(profile_id, domain, pair_signature)
       DO UPDATE SET decision = excluded.decision, created_at = datetime('now')`
  ).run(profileId, domain, signature, decision);
}

// Delete a recorded decision for a pair (issue #200). Used when UNDOING an activity
// merge: the merge recorded a durable 'merged' decision that permanently suppresses
// the pair from Review (keyed on the stable signature); clearing it on undo lets the
// now-unmerged pair resurface for a clean re-resolution. Profile-scoped; a no-op when
// no decision exists. Returns the number of rows removed.
export function deletePairDecision(
  profileId: number,
  domain: string,
  signature: string
): number {
  return db
    .prepare(
      `DELETE FROM import_pair_decisions
        WHERE profile_id = ? AND domain = ? AND pair_signature = ?`
    )
    .run(profileId, domain, signature).changes;
}

// Undecided detected duplicate activity pairs for the Review inbox, newest/highest-
// confidence first (ordering is the pure detector's). Profile-scoped.
export function getActivityDuplicates(
  profileId: number
): ActivityDupPair<ActivityDupRow>[] {
  const decided = new Set(getPairDecisions(profileId, ACTIVITY_DOMAIN).keys());
  return undecidedPairs(
    findActivityDuplicates(loadActivityDupRows(profileId)),
    decided
  );
}

// Undecided body-metric conflict pairs for the Review inbox. Profile-scoped.
export function getBodyMetricConflicts(
  profileId: number
): BodyMetricConflictPair<BodyMetricConflictRow>[] {
  const decided = new Set(
    getPairDecisions(profileId, BODY_METRIC_DOMAIN).keys()
  );
  return undecidedPairs(
    findBodyMetricConflicts(loadBodyMetricConflictRows(profileId)),
    decided
  );
}

// Total unresolved detected pairs (activities + body metrics) — the detection half
// of the review badge count. Profile-scoped.
export function getReviewPairCount(profileId: number): number {
  return (
    getActivityDuplicates(profileId).length +
    getBodyMetricConflicts(profileId).length
  );
}

// The failing-integration events (most recent per currently-broken provider), for
// the Review tab's "Issues" section. Profile-scoped via getRecentSyncEvents.
export function getImportIssues(profileId: number): IntegrationSyncEvent[] {
  return currentlyFailingProviders(getRecentSyncEvents(profileId, 100));
}

// The single most recent event (any outcome) for a provider, or null — the grid
// card uses it for a subtle last-sync time / last-error dot.
export function getLatestSyncEvent(
  profileId: number,
  provider: string
): IntegrationSyncEvent | null {
  const row = db
    .prepare(
      `SELECT * FROM integration_sync_events
        WHERE profile_id = ? AND provider = ?
        ORDER BY at DESC, id DESC
        LIMIT 1`
    )
    .get(profileId, provider) as IntegrationSyncEvent | undefined;
  return row ?? null;
}

// One recurring-stream provider's state for the Data → Review "Connected sources"
// section (issue #208): its connection status, latest sync outcome, and a recent
// history tail. `canSyncNow` marks a provider the app can pull on demand (Strava —
// it has the sync machinery); a push-only provider (Health Connect) explains that
// instead of offering the button.
export interface ConnectedSource {
  id: string;
  name: string;
  kind: string; // IntegrationKind: 'push' | 'oauth' | 'token'
  connected: boolean;
  // The provider's credential died (dead/revoked token) and it flipped to
  // `needs_reauth` (issue #326) — distinct from a never-configured / user-removed
  // "not connected". The card surfaces a "Needs reconnect" prompt instead of the
  // benign "Not connected" one.
  needsReauth: boolean;
  canSyncNow: boolean;
  latest: IntegrationSyncEvent | null;
  history: IntegrationSyncEvent[];
}

// Pull-integration ids the app can sync on demand ("Sync now"): Strava (OAuth),
// Oura (personal-access-token), and Withings (OAuth) all have a REST pull path;
// Health Connect is push-only, so it shows an explainer instead of the button.
const SYNC_NOW_PROVIDERS = new Set(["strava", "oura", "withings"]);

// The recurring-stream providers for the "Connected sources" section: every
// AVAILABLE pull/push integration (Health Connect, Strava, Oura — not the outbound
// calendar feed, not the 'planned' Garmin), each collapsed to its latest sync
// outcome plus a short expandable history. Profile-scoped via the per-provider
// reads it composes (getConnection / getLatestSyncEvent / getIntegrationSyncEvents).
// A provider is only surfaced once it's been set up: currently connected, or
// carrying historical sync events (issue #294) — a never-configured integration is
// hidden rather than shown as an empty "Not connected" card.
export function getConnectedSources(profileId: number): ConnectedSource[] {
  return INTEGRATIONS.filter(
    (i) =>
      i.status === "available" &&
      (i.kind === "push" || i.kind === "oauth" || i.kind === "token")
  )
    .map((i) => {
      const status = getConnection(profileId, i.id)?.status;
      return {
        id: i.id,
        name: i.name,
        kind: i.kind,
        connected: status === "connected",
        needsReauth: status === "needs_reauth",
        canSyncNow: SYNC_NOW_PROVIDERS.has(i.id),
        latest: getLatestSyncEvent(profileId, i.id),
        history: getIntegrationSyncEvents(profileId, i.id, 10),
      };
    })
    .filter((s) =>
      shouldShowConnectedSource({
        connected: s.connected,
        hasHistory: s.history.length > 0,
      })
    );
}

// The captured raw-payload ref for one sync event, scoped to the profile — powers
// the admin-only raw viewer route (app/api/integrations/raw/[id]). Profile-scoped
// (id AND profile_id) so one profile can never resolve another's payload by id;
// the route additionally requires the acting login to be an admin.
export function getSyncEventRawRef(
  profileId: number,
  id: number
): string | null {
  const row = db
    .prepare(
      `SELECT raw_ref FROM integration_sync_events
        WHERE id = ? AND profile_id = ?`
    )
    .get(id, profileId) as { raw_ref: string | null } | undefined;
  return row?.raw_ref ?? null;
}
