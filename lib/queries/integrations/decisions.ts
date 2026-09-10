// DUPLICATE DECISIONS AND REVIEW — one of the three submodules behind
// lib/queries/integrations.ts (issue #5171): the duplicate/conflict detection over
// the profile's own rows with the durable pair decisions, the review badge count,
// the escalated-integration issues (getImportIssues) with the synthetic expired-token
// and quiet-stop rows they fold in, and the attention rows including the dropping
// verdict. The standing resolution and dropped-types window they read live in
// ./common. Every statement is profile-scoped.

import { db, hoistedStatement } from "@/lib/db";
import { cache } from "@/lib/request-cache";
import { tickCached } from "@/lib/tick-cache";
import { toUtcInstant, utcInstant } from "@/lib/date";
import type { IntegrationId, IntegrationSyncEvent } from "@/lib/types";
import {
  staleSyncDetail,
  silenceToleranceMinutes,
  formatTolerance,
  isStaleSyncEvent,
  STALE_SYNC_EVENT_ID,
  type StaleSync,
} from "@/lib/integrations/staleness";
import { metricLabel } from "@/lib/integrations/sync-details";
import type { AttentionIntegration } from "@/lib/attention";
import { standingEscalates } from "@/lib/integrations/source-state";
import { getIntegration } from "@/lib/integrations/registry";
import {
  getConnection,
  isHealthConnectTokenExpired,
} from "@/lib/integrations/connections";
import { HEALTH_CONNECT_ID } from "@/lib/integrations/health-connect";
import {
  findActivityDuplicates,
  findBodyMetricConflicts,
  clusterActivityDuplicates,
  highConfidenceTwinIds,
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
import { getUnreadableDoseAmounts } from "@/lib/queries/data-quality";
import { droppedTypesForSource, resolveSourceFacts } from "./common";
import { getLatestSyncEventPerSource } from "./sync-events";

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
//
// Hoisted (#2110): getReviewPairCount reaches this on every attention gather, and the
// Household page runs one gather per member — so the widest text this module compiles
// was being recompiled once per member. Text is fixed at import (both
// interpolations are module constants); the value is not cached, so the review-pair
// count the rollup folds in is unchanged.
const ACTIVITY_DUP_ROWS_STMT = hoistedStatement(
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
);

function loadActivityDupRows(profileId: number): ActivityDupRow[] {
  return ACTIVITY_DUP_ROWS_STMT.all(
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

// THE POST-WORKOUT DISPATCH'S DUPLICATE AWARENESS (#2570).
//
// Given an activity that is about to be announced, the id of a row a HIGH-confidence
// detection calls the same session AND which has already been announced — or null.
//
// This exists because one-contact-per-session was never a stated property of the send.
// It was an emergent side effect of merge timing: a freshly-imported duplicate usually
// got auto-merged away inside its own 60-second dispatch window, so its timer found no
// row and stayed quiet. When auto-merge DECLINES — and it declines every same-source
// group by design, `detect.ts`'s cross-source gate — nothing was watching, and one bike
// ride mirrored twice into Health Connect by the same app produced two contacts.
//
// `undecidedPairs` is what makes this honour the user. A `kept-both` decision is the
// user saying these are two different sessions; the second one must then be announced,
// and a suppressed pair is exactly the set this must not read. (A `merged` decision is
// excluded from suppression by #507 — but a merged pair has no second row to detect, so
// it cannot reach here anyway.)
//
// It also covers the case no fold can: a pair a human has NOT yet merged, sitting in
// Review, must still not be announced twice.
export function announcedActivityTwin(
  profileId: number,
  activityId: number,
  announced: (twinId: number) => boolean
): number | null {
  const twins = highConfidenceTwinIds(
    getActivityDuplicates(profileId),
    activityId
  );
  return twins.find((id) => announced(id)) ?? null;
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

// The ESCALATED-integration events (one per genuinely-broken source), for the
// Review tab's "Needs attention" card, the profile-menu/Data badge, dashboard
// placement, and the digest. Since #1880 this is the flap-aware standing, not
// latest-event-wins: a source contributes an issue only when its standing
// escalates (`failing` — no successful run inside the source's silence tolerance,
// #2263 — or `needs-reauth`). An `intermittent` source — failures in the recent
// window but a success inside the tolerance — never appears here; it renders as a
// calm amber fact on the non-escalating surfaces instead. Profile-scoped via getLatestSyncEventPerSource
// — per-source, so it can't miss a broken source whose failure has aged out of
// a global recent-events window (#304).
export function getImportIssues(profileId: number): IntegrationSyncEvent[] {
  const failing: IntegrationSyncEvent[] = [];
  for (const latest of getLatestSyncEventPerSource(profileId)) {
    const def = getIntegration(latest.source_id as IntegrationId);
    if (!def) {
      // An unregistered source id (hand-inserted or retired) has no registry
      // standing, so the latest-event rule keeps covering it rather than silently
      // dropping a recorded failure.
      if (!latest.ok) failing.push(latest);
      continue;
    }
    const facts = resolveSourceFacts(profileId, def.id);
    if (!standingEscalates(facts.standing)) continue;
    if (facts.latest && !facts.latest.ok) {
      // A recorded failure names the cause — the honest row.
      failing.push(facts.latest);
    } else if (facts.stale) {
      // The quiet stop: nothing failed, nothing arrived. The synthetic row states
      // the observation. One row per source either way.
      failing.push(syntheticStaleIssue(profileId, def.id, facts.stale));
    }
    // A `dropping` source (#4975) passes the gate above and matches NEITHER arm — its
    // latest run succeeded and it is not stale — so it contributes no row here, ON
    // PURPOSE and not by accident. This function's currency is a sync EVENT, and a
    // drop is not an event: it is a pattern across runs that every one of them
    // recorded as `ok`, so there is no honest row to push and a synthetic one would
    // have to invent a failure that did not happen. `droppingIntegrations` emits the
    // row instead, in the vocabulary that can carry it — and this silence is exactly
    // what keeps #4967 working, because a source absent from `failing` is absent from
    // `represented`, which is what lets the dropping row through.
  }
  // Fold in the expired-Health-Connect-token signal (#607), but only when a real HC
  // failure event isn't already representing the source (a rotated-token push
  // records its own via recordUnmatchedHealthConnectPush) — so HC appears at most once.
  if (!failing.some((e) => e.source_id === HEALTH_CONNECT_ID)) {
    const expired = expiredHealthConnectIssue(profileId);
    if (expired) failing.push(expired);
  }
  return failing;
}

// The profile's broken sources reduced to what the shared attention model renders —
// one entry per currently-broken source, tagged with WHICH kind of broken it is so the
// item can pick its copy (#1685).
//
// It lives here, next to getImportIssues, rather than in lib/queries/attention.ts because
// two unrelated readers need it: the attention model (dashboard placement + Upcoming page) and
// the morning digest gather. Keeping it in the attention module would have made
// lib/notifications/digest-data.ts import lib/queries/attention.ts, which already imports
// digest-data for the newly-flagged-biomarker read — a cycle. One home, no cycle, and the
// badge/page/digest provably read the same list.
//
// MEMOIZED ON BOTH LIFETIMES (#2283). `getImportIssues` behind it walks EVERY source
// with a recorded event — a distinct-source scan, an indexed seek per source, then
// a `resolveSourceFacts` standing window plus a last-success seek for each — and one
// digest tick asks it TWICE for the same profile: `logDigestTick` reports
// `sourceHealthy` on the decision (#2192), and `gatherDigestInput` builds the banded
// broken-sync section (#1685) from the same list. `cache()` is identity in a tick
// (lib/request-cache.ts says so deliberately), so the collapse that matters here is
// `tickCached`; the `cache()` beside it collapses the request-side readers — the
// dashboard placement and the Upcoming page both reach this through the attention model,
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
// The one input that is not a row is NOW: `resolveSourceFacts` compares
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
  const issues = getImportIssues(profileId).map((ev) => {
    const integration = getIntegration(ev.source_id as IntegrationId);
    return {
      id: integration?.id ?? null,
      sourceName: integration?.name ?? ev.source_id,
      detail: ev.error ?? "Reconnect to resume syncing.",
      kind: isStaleSyncEvent(ev) ? ("stale" as const) : ("failing" as const),
    };
  });
  // A source already reported as broken is not ALSO reported as dropping: one row per
  // source is the rule every one of these signals obeys, and "reconnect it" outranks
  // "one of its types isn't landing" — you cannot act on the second until the first is
  // fixed. This is the same yielding `quiet-stream` does, applied one rung up.
  const represented = new Set(issues.map((i) => i.id));
  return [
    ...issues,
    ...droppingIntegrations(profileId).filter((i) => !represented.has(i.id)),
  ];
}

// How many items the Data → Review inbox wants the user's attention on — the count
// behind the profile-menu badge: integrations currently in a failed state, unresolved
// detected duplicate/conflict pairs, and unreadable dose amounts. All are profile-scoped. The failing set is read
// per-source (issue #304) so a broken integration can't be missed just because a
// chatty source crowds a global-N window.
export function getImportReviewCount(profileId: number): number {
  // getImportIssues folds in the expired-Health-Connect-token signal (#607), so the
  // badge count matches the Issues list exactly — one source for both.
  return (
    getImportIssues(profileId).length +
    getReviewPairCount(profileId) +
    getUnreadableDoseAmounts(profileId).length
  );
}

// A synthetic failing sync event for an expired Health Connect ingest token (#607).
// The expiry is fully known server-side (stored on the connection), so an expired
// token surfaces as a failing source even when the phone has stopped pushing — no
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
    source_id: HEALTH_CONNECT_ID,
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
    superseded: null,
    skipped: null,
    raw_ref: null,
    error:
      "Health Connect token expired — mint a new token on Integrations → Google Health Connect and update the phone exporter.",
    created_at: toUtcInstant(conn?.updated_at) ?? utcInstant(),
  };
}

// A synthetic failing sync event for a connection that went QUIET (#1685) — no
// recorded failure, just a last success beyond the source's threshold. Shaped as an
// IntegrationSyncEvent for the same reason the expired-token issue is: everything
// downstream of getImportIssues (the profile-menu badge, the Data → Review count and
// Needs-attention card, dashboard placement, and the digest) already reads that one
// list. `at` is the INSTANT of the last successful sync — the moment the data stopped
// — so the row sorts and reads honestly next to real events. It was the bare DATE
// until #2263, which made a synthetic row compare as midnight against a column of
// full instants.
function syntheticStaleIssue(
  profileId: number,
  sourceId: string,
  s: StaleSync
): IntegrationSyncEvent {
  const def = getIntegration(sourceId as IntegrationId);
  return {
    id: STALE_SYNC_EVENT_ID,
    profile_id: profileId,
    source_id: sourceId,
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
    superseded: null,
    skipped: null,
    raw_ref: null,
    error: staleSyncDetail(def?.name ?? sourceId, s),
    created_at: s.sinceAt,
  };
}

// The profile's CONNECTED sources, which is exactly the set a dropping verdict can be
// about. Asked directly rather than through getLatestSyncEventPerSource: that reader's
// DISTINCT scan is already issued once per tick by getImportIssues, and asking it a
// second time here doubled it (#2283's memo guard catches precisely that).
const DROPPING_SOURCES_STMT = hoistedStatement(
  `SELECT source_id FROM integration_connections
    WHERE profile_id = ? AND status = 'connected'`
);

// SOURCES THAT ARE ALIVE AND SWALLOWING A RECORD TYPE (#4956).
//
// Every run `ok`, rows landing, the card green — and one type arriving in every push
// and being discarded, because the sender renamed the field the parser reads. Three
// types went that way for six days across 405 `ok` pushes, and the only trace was one
// line on one history page. `droppedTypes` reads the per-type tally each run recorded;
// this decides whether the source has been doing it long enough to say so, over the
// SAME silence tolerance the quiet-stop rule uses, so a source has one window and not
// two. A type that lands once clears itself on the next read.
function droppingIntegrations(profileId: number): AttentionIntegration[] {
  const out: AttentionIntegration[] = [];
  const connected = DROPPING_SOURCES_STMT.all(profileId) as {
    source_id: string;
  }[];
  for (const row of connected) {
    const def = getIntegration(row.source_id as IntegrationId);
    const tolerance = silenceToleranceMinutes(def);
    // No declared tolerance means no window to judge over — the same exemption the
    // staleness rule takes for a source whose cadence we cannot state.
    if (!def || tolerance == null) continue;
    const dropped = droppedTypesForSource(profileId, def.id);
    if (!dropped.length) continue;
    out.push({
      id: def.id,
      sourceName: def.name,
      detail: `${dropped.map(metricLabel).join(", ")} arrived in every sync for the last ${formatTolerance(tolerance)} and none were stored. Check the sync history.`,
      kind: "dropping" as const,
    });
  }
  return out;
}
