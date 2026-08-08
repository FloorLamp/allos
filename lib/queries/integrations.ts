import { db, today } from "@/lib/db";
import { cache } from "@/lib/request-cache";
import { tickCached } from "@/lib/tick-cache";
import { toUtcInstant, utcInstant } from "@/lib/date";
import { instantNow } from "@/lib/clock";
import { getTimezone } from "@/lib/settings";
import type { IntegrationId, IntegrationSyncEvent } from "@/lib/types";
import {
  staleSyncs,
  staleSyncDetail,
  silenceToleranceMinutes,
  isStaleSyncEvent,
  STALE_SYNC_EVENT_ID,
  type StaleSync,
} from "@/lib/integrations/staleness";
import type { AttentionIntegration } from "@/lib/attention";
import {
  shouldShowConnectedSource,
  type ProvenanceTable,
} from "@/lib/integrations/sync-log";
import {
  observedSuccessCadenceMinutes,
  providerStanding,
  standingEscalates,
  syncVocabularyForKind,
  STANDING_RUN_WINDOW,
  type ProviderStanding,
  type SyncVocabulary,
} from "@/lib/integrations/provider-state";
import { timelineDayHref, readingDetailHref, type AppRoute } from "@/lib/hrefs";
import {
  getIntegrationBackfillJobs,
  type IntegrationBackfillJob,
} from "@/lib/integrations/backfill-state";
import {
  INTEGRATIONS,
  getIntegration,
  isPullIntegration,
} from "@/lib/integrations/registry";
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
import {
  ACTIVITY_MIDNIGHT_CANDIDATE_SQL,
  ACTIVITY_MIDNIGHT_CANDIDATE_CLOCKS,
} from "@/lib/import-review/candidate-sql";

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
    // The synthetic row is SORTED against real events, so it must carry their
    // convention (#2205). integration_connections.updated_at is still on SQLite's
    // bare shape, hence the re-serialization rather than a raw copy.
    at: toUtcInstant(conn?.updated_at) ?? utcInstant(),
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
    created_at: toUtcInstant(conn?.updated_at) ?? utcInstant(),
  };
}

// THE per-provider standing resolution (#1772, flap-aware since #1880): connection
// status + the recent run window + the #1685 staleness facts, folded through the ONE
// pure derivation (providerStanding). Both getIntegrationState (every rendered
// surface) and getImportIssues (the badge / Needs attention / digest feed) read this
// helper, so a surface and the escalation set can never disagree about a provider's
// shape. Profile-scoped through every read it composes.
interface ProviderFacts {
  connected: boolean;
  needsReauth: boolean;
  latest: IntegrationSyncEvent | null;
  // The newest-first standing window (STANDING_RUN_WINDOW events) — the SAME depth
  // for every caller, however much display history it asked for.
  window: IntegrationSyncEvent[];
  lastSuccessAt: string | null;
  // The quiet-stop facts when the silence rule fires for this CONNECTED provider,
  // for the "no data since" copy. Null otherwise.
  stale: StaleSync | null;
  standing: ProviderStanding;
}

function resolveProviderFacts(
  profileId: number,
  providerId: IntegrationId
): ProviderFacts {
  const def = getIntegration(providerId);
  const status = getConnection(profileId, providerId)?.status;
  const connected = status === "connected";
  const needsReauth = status === "needs_reauth";
  const window = getIntegrationSyncEvents(
    profileId,
    providerId,
    STANDING_RUN_WINDOW
  );
  const latest = window[0] ?? null;
  const lastSuccessAt = getLastSuccessfulSyncAt(profileId, providerId);
  const toleranceMinutes = silenceToleranceMinutes(def);
  // NOW as an instant, through the clock seam (#2263): the silence rule is instant
  // arithmetic against `integration_sync_events.at`, which migration 163 put on the
  // canonical UTC+`Z` convention, so the comparison is lexically and numerically safe.
  const nowAt = instantNow();
  // The quiet-stop copy facts, from the same staleSyncs derivation the standing
  // composes (`alreadyFailing: false` — this IS the failing derivation, so there is
  // no other signal to defer to; getImportIssues still reports each provider once).
  const stale = connected
    ? (staleSyncs(
        [
          {
            provider: providerId,
            lastSuccessAt,
            toleranceMinutes,
            alreadyFailing: false,
          },
        ],
        nowAt
      )[0] ?? null)
    : null;
  return {
    connected,
    needsReauth,
    latest,
    window,
    lastSuccessAt,
    stale,
    standing: providerStanding({
      connected,
      needsReauth,
      latest,
      recentRuns: window,
      lastSuccessAt,
      toleranceMinutes,
      now: nowAt,
    }),
  };
}

// A synthetic failing sync event for a connection that went QUIET (#1685) — no
// recorded failure, just a last success beyond the provider's threshold. Shaped as an
// IntegrationSyncEvent for the same reason the expired-token issue is: everything
// downstream of getImportIssues (the profile-menu badge, the Data → Review count and
// Needs-attention card, the attention item, and the digest) already reads that one
// list. `at` is the INSTANT of the last successful sync — the moment the data stopped
// — so the row sorts and reads honestly next to real events. It was the bare DATE
// until #2263, which made a synthetic row compare as midnight against a column of
// full instants.
function syntheticStaleIssue(
  profileId: number,
  provider: string,
  s: StaleSync
): IntegrationSyncEvent {
  const def = getIntegration(provider as IntegrationId);
  return {
    id: STALE_SYNC_EVENT_ID,
    profile_id: profileId,
    provider,
    at: s.sinceAt,
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
    error: staleSyncDetail(def?.name ?? provider, s),
    created_at: s.sinceAt,
  };
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
  // Numeric magnitude fold-fields — the ones detectClusterFieldConflicts can surface as a
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

// The candidate set for activity dedup, PRE-FILTERED in SQL to only the DATE
// buckets the pure detector could ever pair. This matters because the
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
//
// (c), since #2056: the ADJACENT-DAY buckets. Grouping on the calendar date assumed
// the two copies of one session land on the same day, which a wrong UTC offset that
// pushes a late-evening activity across midnight makes false — and a pair the loader
// never returns is a pair the classifier never sees. The widening is bounded to the
// near-midnight window the rescue could forgive anyway
// (ACTIVITY_MIDNIGHT_CANDIDATE_SQL); the detector's own narrowness still does the
// filtering.
//
// The bucket key is the DATE ALONE since #2271. It was `(date, type)`, which made an
// INFERRED classification a blocking key: Health Connect sent EXERCISE_TYPE_OTHER_
// WORKOUT ("unspecified") for a gym session, the parser turned that into a positive
// `sport`, Strava called the same session `strength`, and the two copies landed in
// different buckets — so the pair was never loaded, never classified, and never
// offered. A pre-filter may only ever be a SUPERSET of what the pure detector will
// accept; type is the detector's question, on the branches where it still asks it.
function loadActivityDupRows(profileId: number): ActivityDupRow[] {
  return db
    .prepare(
      `WITH midnight AS (${ACTIVITY_MIDNIGHT_CANDIDATE_SQL})
       SELECT a.id, a.date, a.type, a.title, a.source, a.external_id,
              a.duration_min, a.distance_km, a.start_time, a.end_time,
              a.elevation_m, a.avg_hr, a.max_hr, a.avg_speed_kmh, a.max_speed_kmh,
              a.relative_effort, a.avg_power_w, a.max_power_w,
              a.weighted_avg_power_w, a.avg_cadence, a.kilojoules, a.avg_temp_c
         FROM activities a
         JOIN (SELECT date FROM activities
                WHERE profile_id = ?
                GROUP BY date
               HAVING COUNT(DISTINCT COALESCE(source, 'manual')) > 1
                   OR SUM(CASE WHEN source IS NOT NULL THEN 1 ELSE 0 END)
                        > COUNT(DISTINCT source)
               UNION SELECT evening_date FROM midnight
               UNION SELECT morning_date FROM midnight) m
           ON m.date = a.date
        WHERE a.profile_id = ?`
    )
    .all(
      profileId,
      ...ACTIVITY_MIDNIGHT_CANDIDATE_CLOCKS,
      profileId,
      profileId
    ) as ActivityDupRow[];
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

// The ESCALATED-integration events (one per genuinely-broken provider), for the
// Review tab's "Needs attention" card, the profile-menu/Data badge, the dashboard
// hero, and the digest. Since #1880 this is the flap-aware standing, not
// latest-event-wins: a provider contributes an issue only when its standing
// escalates (`failing` — no successful run inside the provider's silence tolerance,
// #2263 — or `needs-reauth`). An `intermittent` provider — failures in the recent
// window but a success inside the tolerance — never appears here; it renders as a
// calm amber fact on the non-escalating surfaces instead. Profile-scoped via getLatestSyncEventPerProvider
// — per-provider, so it can't miss a broken provider whose failure has aged out of
// a global recent-events window (#304).
export function getImportIssues(profileId: number): IntegrationSyncEvent[] {
  const failing: IntegrationSyncEvent[] = [];
  for (const latest of getLatestSyncEventPerProvider(profileId)) {
    const def = getIntegration(latest.provider as IntegrationId);
    if (!def) {
      // An unregistered provider id (hand-inserted or retired) has no registry
      // standing, so the latest-event rule keeps covering it rather than silently
      // dropping a recorded failure.
      if (!latest.ok) failing.push(latest);
      continue;
    }
    const facts = resolveProviderFacts(profileId, def.id);
    if (!standingEscalates(facts.standing)) continue;
    if (facts.latest && !facts.latest.ok) {
      // A recorded failure names the cause — the honest row.
      failing.push(facts.latest);
    } else if (facts.stale) {
      // The quiet stop: nothing failed, nothing arrived. The synthetic row states
      // the observation. One row per provider either way.
      failing.push(syntheticStaleIssue(profileId, def.id, facts.stale));
    }
  }
  // Fold in the expired-Health-Connect-token signal (#607), but only when a real HC
  // failure event isn't already representing the provider (a rotated-token push
  // records its own via recordUnmatchedHealthConnectPush) — so HC appears at most once.
  if (!failing.some((e) => e.provider === HEALTH_CONNECT_ID)) {
    const expired = expiredHealthConnectIssue(profileId);
    if (expired) failing.push(expired);
  }
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
//
// MEMOIZED ON BOTH LIFETIMES (#2283). `getImportIssues` behind it walks EVERY provider
// with a recorded event — a DISTINCT-provider scan, an indexed seek per provider, then
// a `resolveProviderFacts` standing window plus a last-success seek for each — and one
// digest tick asks it TWICE for the same profile: `logDigestTick` reports
// `providerHealthy` on the decision (#2192), and `gatherDigestInput` builds the banded
// broken-sync section (#1685) from the same list. `cache()` is identity in a tick
// (lib/request-cache.ts says so deliberately), so the collapse that matters here is
// `tickCached`; the `cache()` beside it collapses the request-side readers — the
// dashboard hero and the Upcoming page both reach this through the attention model,
// and the Sleep page's source card asks separately.
//
// Nothing inside a tick writes these rows AFTER the first read. `syncIntegrations` is
// the FIRST statement of `tickProfile`, and it is the only thing in the tick that
// writes `integration_sync_events` or moves a connection to `needs_reauth` — the pull
// pass has finished before anything in the scope reads them, and no pull runner reads
// this list, so the sync cannot seed a memo it then invalidates. The other writers
// (the Health Connect ingest route, the Fitbit Takeout import route, the OAuth
// callbacks) are request paths, and the retention sweep `pruneSyncEvents` runs in
// `tick()` AFTER the profile loop, outside every scope. The scope closes with the
// profile — see lib/tick-cache.ts for the rule this depends on.
//
// The one input that is not a row is NOW: `resolveProviderFacts` compares
// `instantNow()` against the last successful run, so the memo pins the tick's first
// reading of the clock for the rest of that profile's tick. That is sound because the
// quantity being compared is a SILENCE TOLERANCE measured in hours (the registry's
// declared cadence, #2263) while a profile's tick is seconds long — a standing that
// flips mid-tick would have flipped mid-read anyway.
export const getIntegrationAttention = cache(
  tickCached(
    "getIntegrationAttention",
    (profileId: number) => String(profileId),
    getIntegrationAttentionUncached
  )
);

function getIntegrationAttentionUncached(
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

// THE per-provider state record (#1772). One provider used to be described by four
// surfaces in three visual languages — the Integrations grid card, the setup page's
// status card (its own badge, a raw SQLite UTC timestamp, and the `last_sync_summary`
// JSON echoed as key:value badges, a third accounting with no formatter),
// IntegrationSyncHistoryLink, and Review's Connected-sources card. They now all read
// THIS, and format it through the pure lib/integrations/provider-state helpers.
//
// `canSyncNow` marks a provider the app can pull on demand; a push-only provider
// (Health Connect) explains that instead of offering the button.
export interface IntegrationState {
  id: IntegrationId;
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
  // How many rows the drill-in can actually LIST, per event id, among `latest` +
  // `history` (#1771, corrected in #1991). An event absent from this map recorded no
  // provenance and gets no expander at all rather than one that apologizes on open.
  // The COUNT matters as much as the presence: "What this wrote (30)" used to label
  // the split total while listing only what `integration_sync_rows` holds — and
  // recordSyncRows deliberately skips minute-grain tables with no row id — so on a
  // Health Connect push it overstated by 10× and a partial list looked complete.
  provenanceCounts: Record<number, number>;
  // The last run that SUCCEEDED, however long ago — what the setup page's status
  // header reports when the latest attempt failed.
  lastSuccessAt: string | null;
  // The pure derivations, resolved once here so no surface re-derives them: which
  // shape the provider is in, and which words its counts are reported in.
  standing: ProviderStanding;
  vocabulary: SyncVocabulary;
  // The quiet-stop facts when the silence rule fires (a `failing` standing whose
  // latest run SUCCEEDED long ago) — the "no data since <date>" copy's ingredients.
  // Null otherwise.
  stale: StaleSync | null;
  // The standing window's tally (#1880): how many of the last `total` runs failed,
  // for the intermittent surfaces' honest "3 of the last 10 runs failed" copy.
  recentRuns: { total: number; failed: number };
  // The OBSERVED median gap between successful runs in that window, in whole minutes
  // (#2263 decision 4) — the SIGNAL the amber surfaces state beside the failure
  // tally, which is only the noise. Null when the window holds fewer than two
  // successes. Display only: it never feeds the declared escalation tolerance.
  successCadenceMinutes: number | null;
  // The PROFILE's time zone and its today, resolved once here (#1991). History groups
  // by DAY, and a day is the reader's — a UTC slice would put a 21:00 local push on
  // the wrong side of midnight for anyone east or west of Greenwich.
  timeZone: string;
  today: string;
  // Durable enrichment work (progress survives navigation/restarts).
  backfills: IntegrationBackfillJob[];
}

// Retained for the surfaces that speak of "connected sources" (Data → Review). Same
// record — the name is the surface's, the shape is the model's.
export type ConnectedSource = IntegrationState;

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
    .map((i) => getIntegrationState(profileId, i.id, REVIEW_HISTORY_LIMIT))
    .filter((s): s is IntegrationState => s !== null)
    .filter((s) =>
      shouldShowConnectedSource({
        connected: s.connected,
        hasHistory: s.history.length > 0,
      })
    );
}

// How many events each surface loads. Review is an inbox — it shows the current
// state, so it needs only enough history to say whether the latest run is typical.
// The setup page is the provider's HOME and owns the full history table, so it reads
// deeper (the #388 retention sweep already bounds how much exists).
const REVIEW_HISTORY_LIMIT = 10;
export const SETUP_HISTORY_LIMIT = 25;

// ONE provider's complete state, for whichever surface is asking (#1772): the
// Integrations grid card, its setup page's status header + history table, or Review's
// Connected-sources entry. Returns null for an id that isn't a registered
// integration. Profile-scoped through every read it composes.
export function getIntegrationState(
  profileId: number,
  providerId: string,
  historyLimit: number = REVIEW_HISTORY_LIMIT
): IntegrationState | null {
  const def = getIntegration(providerId as IntegrationId);
  if (!def) return null;
  const facts = resolveProviderFacts(profileId, def.id);
  // The DISPLAY history is the caller's depth; the STANDING window is always
  // resolveProviderFacts' STANDING_RUN_WINDOW, so a surface that renders no history
  // (the grid card) still derives the same standing as one that renders 25 rows.
  const history =
    historyLimit <= STANDING_RUN_WINDOW
      ? facts.window.slice(0, Math.max(0, historyLimit))
      : getIntegrationSyncEvents(profileId, def.id, historyLimit);
  const ids = history.map((e) => e.id);
  if (facts.latest) ids.push(facts.latest.id);
  return {
    id: def.id,
    name: def.name,
    kind: def.kind,
    connected: facts.connected,
    needsReauth: facts.needsReauth,
    // Which providers can be synced on demand is a REGISTRY fact now (#2040): a
    // provider with a pull facet has a runner behind the button. Health Connect is
    // push-only and shows an explainer instead.
    canSyncNow: isPullIntegration(def),
    latest: facts.latest,
    history,
    provenanceCounts: ids.length
      ? provenanceCountsByEvent(profileId, def.id, Math.min(...ids))
      : {},
    lastSuccessAt: facts.lastSuccessAt,
    standing: facts.standing,
    vocabulary: syncVocabularyForKind(def.kind),
    stale: facts.stale,
    recentRuns: {
      total: facts.window.length,
      failed: facts.window.filter((e) => !e.ok).length,
    },
    successCadenceMinutes: observedSuccessCadenceMinutes(facts.window),
    timeZone: getTimezone(profileId),
    today: today(profileId),
    backfills: getIntegrationBackfillJobs(profileId, def.id),
  };
}

// How many provenance rows each of a provider's recent sync events RECORDED (#1771,
// counted rather than merely detected in #1991). The "What this wrote" drill-in
// promises record-level detail, so it may only be offered for an event that has some,
// and it must promise exactly as many as it will list — whether an event has any, and
// how many, is a fact about
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
export function provenanceCountsByEvent(
  profileId: number,
  provider: string,
  minEventId: number
): Record<number, number> {
  const rows = db
    .prepare(
      `SELECT r.event_id AS event_id, COUNT(*) AS n
         FROM integration_sync_rows r
         JOIN integration_sync_events e ON e.id = r.event_id
        WHERE e.profile_id = ? AND e.provider = ? AND r.event_id >= ?
        GROUP BY r.event_id`
    )
    .all(profileId, provider, minEventId) as {
    event_id: number;
    n: number;
  }[];
  const out: Record<number, number> = {};
  for (const r of rows) out[r.event_id] = r.n;
  return out;
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
      // medical_records → the reading's OWN detail surface (#1932): the metric
      // detail page for a continuous vital, the reference-range page for a lab,
      // the list without a canonical name. The helper owns that choice.
      const rec = findRecord.get(r.target_id, profileId) as
        | { date: string; name: string | null; canonical_name: string | null }
        | undefined;
      deleted = !rec;
      date = rec?.date ?? null;
      // Canonical FIRST (#1501): the label and the href below must name the same
      // identity — the link already commits to the canonical analyte, so a raw-first
      // label reads "URIC ACID" on a row that opens "Uric Acid".
      label = rec?.canonical_name?.trim() || rec?.name || "Lab result";
      href = readingDetailHref(rec?.canonical_name ?? null, rec?.name ?? null);
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
