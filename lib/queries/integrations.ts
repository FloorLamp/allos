import { db, today } from "@/lib/db";
import type { IntegrationId, IntegrationSyncEvent } from "@/lib/types";
import {
  staleSyncs,
  staleSyncDetail,
  syncStalenessThreshold,
  isStaleSyncEvent,
  STALE_SYNC_EVENT_ID,
  type SyncFreshness,
} from "@/lib/integrations/staleness";
import type { AttentionIntegration } from "@/lib/attention";
import {
  currentlyFailingProviders,
  shouldShowConnectedSource,
  type ProvenanceTable,
} from "@/lib/integrations/sync-log";
import { timelineDayHref, biomarkerViewHref, type AppRoute } from "@/lib/hrefs";
import { INTEGRATIONS, getIntegration } from "@/lib/integrations/registry";
import {
  getConnection,
  isHealthConnectTokenExpired,
} from "@/lib/integrations/connections";
import { HEALTH_CONNECT_ID } from "@/lib/integrations/health-connect";
import {
  findActivityDuplicates,
  findBodyMetricConflicts,
  clusterActivityDuplicates,
  undecidedPairs,
  suppressingSignatures,
  ACTIVITY_DOMAIN,
  BODY_METRIC_DOMAIN,
  type ActivityDupInput,
  type ActivityDupPair,
  type ActivityDupCluster,
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

// The single most recent event (any outcome) for EACH provider the profile has any
// sync history for — one row per provider, newest-first overall. Unlike a window-
// capped "N newest across all providers" read, this is uncapped PER PROVIDER by
// construction (a correlated `id = latest-for-this-provider` match), so a provider
// whose latest event is a failure is never lost behind a chattier provider's flood of
// recent rows (issue #304). This is the failure detector's feed: it matches, row for
// row, what each grid card shows via getLatestSyncEvent, so the badge/hero and the
// per-provider card can no longer disagree. Profile-scoped.
export function getLatestSyncEventPerProvider(
  profileId: number
): IntegrationSyncEvent[] {
  // Instead of scanning every event with a correlated `id = latest-for-provider`
  // subquery per row (issue #388), enumerate the profile's DISTINCT providers and do
  // ONE indexed seek per provider — idx_sync_events_profile_provider_at
  // (profile_id, provider, at) satisfies both the DISTINCT skip-scan and each
  // `ORDER BY at DESC, id DESC LIMIT 1`, so this is O(providers × log N) rather than
  // O(N) with a per-row subquery. Output is byte-identical: the latest event per
  // provider, ordered newest-first overall.
  const providers = db
    .prepare(
      `SELECT DISTINCT provider FROM integration_sync_events
        WHERE profile_id = ?`
    )
    .all(profileId) as { provider: string }[];
  const latest = db.prepare(
    `SELECT * FROM integration_sync_events
      WHERE profile_id = ? AND provider = ?
      ORDER BY at DESC, id DESC
      LIMIT 1`
  );
  const out: IntegrationSyncEvent[] = [];
  for (const { provider } of providers) {
    const ev = latest.get(profileId, provider) as
      IntegrationSyncEvent | undefined;
    if (ev) out.push(ev);
  }
  return out.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : b.id - a.id));
}

// How many items the Data → Review inbox wants the user's attention on — the count
// behind the profile-menu badge. Two contributions (issue #10): integrations
// CURRENTLY in a failed state (self-clearing on the next good sync) PLUS unresolved
// detected duplicate/conflict pairs. Both are profile-scoped. The failing set is read
// per-provider (issue #304) so a broken integration can't be missed just because a
// chatty provider crowds a global-N window.
export function getImportReviewCount(profileId: number): number {
  // getImportIssues folds in the expired-Health-Connect-token signal (#607), so the
  // badge count matches the Issues list exactly — one source for both.
  return getImportIssues(profileId).length + getReviewPairCount(profileId);
}

// A synthetic failing sync event for an expired Health Connect ingest token (#607).
// The expiry is fully known server-side (stored on the connection), so an expired
// token surfaces as a failing provider even when the phone has stopped pushing — no
// real sync event is ever recorded for it (an expired token drops out of candidacy,
// so its pushes 401 with nothing to attribute). Returns null when the HC token isn't
// expired. The negative id can't collide with a real AUTOINCREMENT row.
function expiredHealthConnectIssue(
  profileId: number
): IntegrationSyncEvent | null {
  if (!isHealthConnectTokenExpired(profileId)) return null;
  const conn = getConnection(profileId, HEALTH_CONNECT_ID);
  return {
    id: -1,
    profile_id: profileId,
    provider: HEALTH_CONNECT_ID,
    at: conn?.updated_at ?? new Date().toISOString(),
    ok: 0,
    window_start: null,
    window_end: null,
    received: null,
    written: null,
    inserted: null,
    updated: null,
    unchanged: null,
    suppressed: null,
    edited: null,
    skipped: null,
    raw_ref: null,
    error:
      "Health Connect token expired — mint a new token on Integrations → Google Health Connect and update the phone exporter.",
    created_at: conn?.updated_at ?? new Date().toISOString(),
  };
}

// The profile's CONNECTED providers reduced to the freshness facts the pure staleness
// derivation needs (#1685). Only `connected` rows are considered: a `needs_reauth` one is
// already represented by its own reauth signal (and by the ok:0 event that flipped it),
// and a `disconnected` one is off on purpose. `alreadyFailing` carries the providers the
// failure detector is currently reporting so the pure layer can enforce the
// no-double-report rule in one place. Profile-scoped: the connection read and every
// last-success read filter by profile_id.
function syncFreshness(
  profileId: number,
  failingProviders: ReadonlySet<string>
): SyncFreshness[] {
  const rows = db
    .prepare(
      `SELECT provider FROM integration_connections
        WHERE profile_id = ? AND status = 'connected'`
    )
    .all(profileId) as { provider: string }[];
  return rows.map((r) => ({
    provider: r.provider,
    lastSuccessAt: getLastSuccessfulSyncAt(profileId, r.provider),
    thresholdDays: syncStalenessThreshold(
      getIntegration(r.provider as IntegrationId)
    ),
    alreadyFailing: failingProviders.has(r.provider),
  }));
}

// Synthetic failing sync events for connections that have gone QUIET (#1685) — a
// connection sitting at `connected` whose last successful sync is older than its
// provider's registry threshold. Shaped as IntegrationSyncEvents for the same reason the
// expired-token issue is: everything downstream of getImportIssues (the profile-menu
// badge, the Data → Review count and Issues list, the attention item, and now the digest)
// already reads that one list, so the staleness signal reaches every surface without any
// of them growing a second source. `at` is the last successful sync — the moment the data
// stopped — so the row sorts and reads honestly next to real events.
function staleSyncIssues(
  profileId: number,
  failingProviders: ReadonlySet<string>
): IntegrationSyncEvent[] {
  const td = today(profileId);
  return staleSyncs(syncFreshness(profileId, failingProviders), td).map((s) => {
    const def = getIntegration(s.provider as IntegrationId);
    return {
      id: STALE_SYNC_EVENT_ID,
      profile_id: profileId,
      provider: s.provider,
      at: s.since,
      ok: 0,
      window_start: null,
      window_end: null,
      received: null,
      written: null,
      inserted: null,
      updated: null,
      unchanged: null,
      suppressed: null,
      edited: null,
      skipped: null,
      raw_ref: null,
      error: staleSyncDetail(def?.name ?? s.provider, s),
      created_at: s.since,
    };
  });
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
  // A 'merged' decision must NOT suppress a RE-FORMED pair (#507): if both rows exist
  // again the resync undid the merge, so it belongs back in Review. Only kept-both /
  // dismissed keep suppressing on re-detection.
  const decided = suppressingSignatures(
    getPairDecisions(profileId, ACTIVITY_DOMAIN)
  );
  return undecidedPairs(
    findActivityDuplicates(loadActivityDupRows(profileId)),
    decided
  );
}

// Undecided duplicate activity rows CLUSTERED into connected groups (#1081): the
// pairwise detections above grouped by transitive closure, so a session that landed
// as 3–4 duplicate rows surfaces as ONE cluster card instead of C(n,2) pair cards. A
// 2-row cluster is the pairwise case. Profile-scoped (via getActivityDuplicates).
export function getActivityDuplicateClusters(
  profileId: number
): ActivityDupCluster<ActivityDupRow>[] {
  return clusterActivityDuplicates(getActivityDuplicates(profileId));
}

// Undecided body-metric conflict pairs for the Review inbox. Profile-scoped.
export function getBodyMetricConflicts(
  profileId: number
): BodyMetricConflictPair<BodyMetricConflictRow>[] {
  // A re-formed 'merged' body-metric pair means the ON CONFLICT push resurrected the
  // absorbed row — resurface it (#507); kept-both / dismissed stay suppressed.
  const decided = suppressingSignatures(
    getPairDecisions(profileId, BODY_METRIC_DOMAIN)
  );
  return undecidedPairs(
    findBodyMetricConflicts(loadBodyMetricConflictRows(profileId)),
    decided
  );
}

// Total unresolved detected pairs (activities + body metrics) — the detection half
// of the review badge count. Profile-scoped.
export function getReviewPairCount(profileId: number): number {
  // Activities are counted by CLUSTER (#1081): a session that landed as 3–4 duplicate
  // rows is ONE thing to resolve, so it contributes one to the badge (not C(n,2)). A
  // 2-row cluster still counts one, so the pairwise case is unchanged.
  return (
    getActivityDuplicateClusters(profileId).length +
    getBodyMetricConflicts(profileId).length
  );
}

// The failing-integration events (most recent per currently-broken provider), for
// the Review tab's "Issues" section and the dashboard "Needs attention" hero.
// Profile-scoped via getLatestSyncEventPerProvider — per-provider, so it can't miss a
// broken provider whose failure has aged out of a global recent-events window (#304).
export function getImportIssues(profileId: number): IntegrationSyncEvent[] {
  const failing = currentlyFailingProviders(
    getLatestSyncEventPerProvider(profileId)
  );
  // Fold in the expired-Health-Connect-token signal (#607), but only when a real HC
  // failure event isn't already representing the provider (a rotated-token push
  // records its own via recordUnmatchedHealthConnectPush) — so HC appears at most once.
  if (!failing.some((e) => e.provider === HEALTH_CONNECT_ID)) {
    const expired = expiredHealthConnectIssue(profileId);
    if (expired) failing.push(expired);
  }
  // Fold in the silent-stop signal (#1685). Every provider already represented above is
  // excluded, so a broken connection is reported ONCE: a reauth prompt names the cause,
  // and a staleness line naming the symptom underneath it would be noise the user has to
  // reconcile. The exclusion set is built from what this function is about to return, so
  // it can never drift from the failure list.
  const represented = new Set(failing.map((e) => e.provider));
  failing.push(...staleSyncIssues(profileId, represented));
  return failing;
}

// The profile's broken providers reduced to what the shared attention model renders —
// one entry per currently-broken provider, tagged with WHICH kind of broken it is so the
// item can pick its copy (#1685).
//
// It lives here, next to getImportIssues, rather than in lib/queries/attention.ts because
// two unrelated readers need it: the attention model (dashboard hero + Upcoming page) and
// the morning digest gather. Keeping it in the attention module would have made
// lib/notifications/digest-data.ts import lib/queries/attention.ts, which already imports
// digest-data for the newly-flagged-biomarker read — a cycle. One home, no cycle, and the
// badge/page/digest provably read the same list.
export function getIntegrationAttention(
  profileId: number
): AttentionIntegration[] {
  return getImportIssues(profileId).map((ev) => {
    const integration = getIntegration(ev.provider as IntegrationId);
    return {
      id: integration?.id ?? null,
      provider: integration?.name ?? ev.provider,
      detail: ev.error ?? "Reconnect to resume syncing.",
      kind: isStaleSyncEvent(ev) ? ("stale" as const) : ("failing" as const),
    };
  });
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
  kind: string; // IntegrationKind: 'push' | 'oauth' | 'token' | 'public'
  connected: boolean;
  // The provider's credential died (dead/revoked token) and it flipped to
  // `needs_reauth` (issue #326) — distinct from a never-configured / user-removed
  // "not connected". The card surfaces a "Needs reconnect" prompt instead of the
  // benign "Not connected" one.
  needsReauth: boolean;
  canSyncNow: boolean;
  latest: IntegrationSyncEvent | null;
  history: IntegrationSyncEvent[];
  // The ids, among `latest` + `history`, whose sync actually recorded row provenance
  // (#1771). The "What this wrote" drill-in is offered ONLY for these; an event that
  // recorded none gets no expander at all rather than one that apologizes on open.
  provenanceEventIds: number[];
}

// Pull-integration ids the app can sync on demand ("Sync now"): Strava (OAuth),
// Oura (personal-access-token), and Withings (OAuth) all have a REST pull path;
// Health Connect is push-only, so it shows an explainer instead of the button.
const SYNC_NOW_PROVIDERS = new Set(["strava", "oura", "withings"]);

// The integration kinds that produce a RECURRING sync stream, and therefore belong in
// "Connected sources": push (Health Connect), oauth (Strava, Withings), token (Oura),
// and public (Weather & UV — keyless, but it runs on the hourly tick and appends a
// sync event per run exactly like the others). Excluded: 'archive' (Fitbit Takeout is
// a one-off upload and lives in the chronological Imports feed) and 'feed' (the
// outbound calendar subscription, which imports nothing). Weather was missing here,
// which left its successful history unreachable while its failures still showed under
// Needs attention (#1614).
const RECURRING_SOURCE_KINDS = new Set(["push", "oauth", "token", "public"]);

// The recurring-stream providers for the "Connected sources" section, each collapsed
// to its latest sync outcome plus a short expandable history. Profile-scoped via the
// per-provider reads it composes (getConnection / getLatestSyncEvent /
// getIntegrationSyncEvents). A provider is only surfaced once it's been set up:
// currently connected, or carrying historical sync events (issue #294) — a
// never-configured integration is hidden rather than shown as an empty
// "Not connected" card.
export function getConnectedSources(profileId: number): ConnectedSource[] {
  return INTEGRATIONS.filter(
    (i) => i.status === "available" && RECURRING_SOURCE_KINDS.has(i.kind)
  )
    .map((i) => {
      const status = getConnection(profileId, i.id)?.status;
      const latest = getLatestSyncEvent(profileId, i.id);
      const history = getIntegrationSyncEvents(profileId, i.id, 10);
      const ids = history.map((e) => e.id);
      if (latest) ids.push(latest.id);
      return {
        id: i.id,
        name: i.name,
        kind: i.kind,
        connected: status === "connected",
        needsReauth: status === "needs_reauth",
        canSyncNow: SYNC_NOW_PROVIDERS.has(i.id),
        latest,
        history,
        provenanceEventIds: ids.length
          ? eventsWithProvenance(profileId, i.id, Math.min(...ids))
          : [],
      };
    })
    .filter((s) =>
      shouldShowConnectedSource({
        connected: s.connected,
        hasHistory: s.history.length > 0,
      })
    );
}

// Which of a provider's recent sync events actually RECORDED row provenance (#1771).
// The "What this wrote" drill-in promises record-level detail, so it may only be
// offered for an event that has some — and whether an event has any is a fact about
// the EVENT, not about the provider: Weather legitimately records none (it writes
// cells of the global location-keyed forecast cache, which name no user record —
// #1212's scoping decision), and genuine pre-#1333 legacy events of the other
// providers have none either. Both used to render an expander that apologized 100%
// of the time.
//
// One indexed seek per provider rather than a per-event existence check: sync-event
// ids are monotonic, so the events being rendered are exactly those at or above the
// oldest id in the rendered set, and `integration_sync_rows` is keyed on event_id.
// PROFILE-SCOPED through the parent event (the child-table convention — the table has
// no own profile_id).
export function eventsWithProvenance(
  profileId: number,
  provider: string,
  minEventId: number
): number[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT r.event_id AS event_id
         FROM integration_sync_rows r
         JOIN integration_sync_events e ON e.id = r.event_id
        WHERE e.profile_id = ? AND e.provider = ? AND r.event_id >= ?`
    )
    .all(profileId, provider, minEventId) as { event_id: number }[];
  return rows.map((r) => r.event_id);
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

// ---- Per-row sync provenance drill-in (issue #1333) -------------------------

// One record a sync inserted/updated, resolved to a human label + a typed deep link
// to the surface that owns it (#285). `deleted` marks a target that no longer resolves
// (the record was later removed) — its link still points at the day/list, but the label
// says so. `date` is the record's own date, used to build the timeline-day link.
export interface SyncRowLink {
  id: number;
  targetTable: ProvenanceTable;
  targetId: number;
  disposition: "inserted" | "updated";
  date: string | null;
  label: string;
  href: AppRoute;
  deleted: boolean;
}

// The records a single sync event wrote, newest-persisted first, each resolved to a
// deep link. PROFILE-SCOPED at both ends: the event must belong to `profileId` (the
// join naming e.profile_id), and every target lookup filters the owned table by
// profile_id too, so one profile can never resolve another's records by id. Legacy
// events (before #1333) have no provenance rows and return []; the caller then shows
// the pre-existing inert window text. Only inserted/updated rows were ever recorded
// (the volume cap — see recordSyncRows), so this never lists an unchanged re-send.
export function getSyncRowProvenance(
  profileId: number,
  eventId: number
): SyncRowLink[] {
  const rows = db
    .prepare(
      `SELECT r.id, r.target_table, r.target_id, r.disposition
         FROM integration_sync_rows r
         JOIN integration_sync_events e ON e.id = r.event_id
        WHERE r.event_id = ? AND e.profile_id = ?
        ORDER BY r.id`
    )
    .all(eventId, profileId) as {
    id: number;
    target_table: ProvenanceTable;
    target_id: number;
    disposition: "inserted" | "updated";
  }[];

  // Per-table, profile-scoped resolvers (literal SQL so the profile-scoping guard can
  // read the profile_id filter directly). Each returns the record's date + a label, or
  // undefined when the row was since deleted.
  const findActivity = db.prepare(
    "SELECT date, title, type FROM activities WHERE id = ? AND profile_id = ?"
  );
  const findBody = db.prepare(
    "SELECT date FROM body_metrics WHERE id = ? AND profile_id = ?"
  );
  const findSample = db.prepare(
    "SELECT date, metric FROM metric_samples WHERE id = ? AND profile_id = ?"
  );
  const findRecord = db.prepare(
    "SELECT date, name, canonical_name FROM medical_records WHERE id = ? AND profile_id = ?"
  );
  const findPractice = db.prepare(
    "SELECT date, practice FROM practice_logs WHERE id = ? AND profile_id = ?"
  );

  const out: SyncRowLink[] = [];
  for (const r of rows) {
    let date: string | null = null;
    let label = "";
    let href: AppRoute = timelineDayHref(""); // replaced below
    let deleted = false;
    if (r.target_table === "activities") {
      const rec = findActivity.get(r.target_id, profileId) as
        { date: string; title: string | null; type: string | null } | undefined;
      deleted = !rec;
      date = rec?.date ?? null;
      label = rec?.title || rec?.type || "Activity";
      href = date ? timelineDayHref(date) : timelineDayHref("");
    } else if (r.target_table === "body_metrics") {
      const rec = findBody.get(r.target_id, profileId) as
        { date: string } | undefined;
      deleted = !rec;
      date = rec?.date ?? null;
      label = "Body metrics";
      href = date ? timelineDayHref(date) : timelineDayHref("");
    } else if (r.target_table === "metric_samples") {
      const rec = findSample.get(r.target_id, profileId) as
        { date: string; metric: string } | undefined;
      deleted = !rec;
      date = rec?.date ?? null;
      label = rec?.metric ?? "Metric";
      href = date ? timelineDayHref(date) : timelineDayHref("");
    } else if (r.target_table === "medical_records") {
      // medical_records → Results (biomarker view when canonical, else the list).
      const rec = findRecord.get(r.target_id, profileId) as
        | { date: string; name: string | null; canonical_name: string | null }
        | undefined;
      deleted = !rec;
      date = rec?.date ?? null;
      // Canonical FIRST (#1501): the label and the href below must name the same
      // identity — the link already commits to the canonical analyte, so a raw-first
      // label reads "URIC ACID" on a row that opens "Uric Acid".
      label = rec?.canonical_name?.trim() || rec?.name || "Lab result";
      href = biomarkerViewHref(rec?.canonical_name ?? null, rec?.name ?? null);
    } else {
      const rec = findPractice.get(r.target_id, profileId) as
        { date: string; practice: string } | undefined;
      deleted = !rec;
      date = rec?.date ?? null;
      label = rec?.practice || "Wellness practice";
      href = date ? timelineDayHref(date) : timelineDayHref("");
    }
    out.push({
      id: r.id,
      targetTable: r.target_table,
      targetId: r.target_id,
      disposition: r.disposition,
      date,
      label,
      href,
      deleted,
    });
  }
  return out;
}
