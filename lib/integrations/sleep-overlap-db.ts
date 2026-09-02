import { db } from "@/lib/db";
import { utcMinute } from "@/lib/date";
import {
  decideSleepOverlap,
  observeHeartRate,
  sleepOverlapPairs,
  stagesOwnedBy,
  type HeartRateMinute,
  type SleepSessionRow,
} from "@/lib/sleep-overlap";
import { continuousStream } from "./continuous-streams";
import { HEALTH_CONNECT_ID } from "./health-connect";
import { writeImportTombstone } from "./tombstones";
import { metricSampleTombstoneKey } from "./tombstone-keys";

// THE STORE HALF of the same-origin overlapping sleep collapse (#3628). The rule and its
// argument live in lib/sleep-overlap.ts; this file supplies it with rows and performs the
// one write it licenses.
//
// IT RUNS AFTER THE PUSH'S HEART RATE IS ON DISK, not inside the metric-sample chunk
// loop, and that placement is the reason it can decide anything: `ingestHealthConnectPayload`
// commits `hr_minutes` after `metric_samples`, so a collapse planned during the sample
// chunks would judge the corrected night against a store that does not yet hold the
// minutes proving it. Running last also keeps #3424's commit-order property — at every
// commit point the store holds the old rows, or old + new, never neither.
//
// THE PUSH IS THE TRIGGER, NEVER THE TIE-BREAK. `pushed_at` is read here only to bound
// what is examined to the sessions this push actually touched, which is what keeps the
// pass off the profile's whole sleep history on every 15-minute push. It never reaches
// the decision: `decideSleepOverlap` reads the pair symmetrically, so the same session
// survives whichever order the two arrived in, and a backfill that delivers them
// newest-first collapses to the same row as the live trace.

// A day either side of the pair, as the span the awake reference is drawn from. It is a
// SPAN, not a threshold: what governs whether the reference is usable is the amount of
// awake observation found inside it (below), so widening or narrowing this changes how
// much evidence is on offer and never what counts as sleep.
const REFERENCE_SPAN_MS = 24 * 60 * 60 * 1000;

// `metric_samples.date` is a profile-local wake day, so an overlapping PAIR can be filed
// under two different days — that is the defect's own signature. The candidate SQL
// narrows on the indexed `(profile_id, metric, date)` prefix with room for both; the pure
// predicate decides on the instants. SQL NARROWS, THE RULE DECIDES — widening this range
// must not widen what gets deleted.
const CANDIDATE_DAY_RADIUS = 2;

const STAGE_METRICS_SQL =
  "('sleep_deep_min','sleep_rem_min','sleep_light_min','sleep_awake_min')";

interface StoredRow extends SleepSessionRow {
  date: string;
}

function dayOffset(date: string, days: number): string {
  const ms = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(ms)) return date;
  return new Date(ms + days * 86_400_000).toISOString().slice(0, 10);
}

/** The declared silence a worn heart-rate stream may show — see `corroboratesSleep`. */
function dipToleranceMs(source: string): number | null {
  if (source !== HEALTH_CONNECT_ID) return null;
  const min = continuousStream(source, "heart-rate")?.stream.quiet
    ?.dipToleranceMin;
  return typeof min === "number" ? min * 60_000 : null;
}

function heartRateInWindow(
  profileId: number,
  startMs: number,
  endMs: number
): HeartRateMinute[] {
  return db
    .prepare(
      `SELECT ts, bpm FROM hr_minutes
        WHERE profile_id = ? AND ts >= ? AND ts < ?`
    )
    .all(
      profileId,
      utcMinute(new Date(startMs)),
      utcMinute(new Date(endMs))
    ) as HeartRateMinute[];
}

/**
 * The person's own AWAKE mean heart rate around a pair, and how many minutes it rests on.
 *
 * "Awake" is taken from the store's own declarations rather than inferred: every minute
 * inside ANY recorded sleep session — the two candidates included, and whatever other
 * source recorded a night in the span — is subtracted, and the reference is the mean over
 * what is left. That is what makes the comparison the one the prod repair made by hand
 * (58 bpm inside the real window against a 68 bpm daytime block) rather than a bpm
 * constant, and it needs no wear-pattern learner: it is a mean of stored readings over a
 * stated span.
 */
function awakeReference(
  profileId: number,
  spanStartMs: number,
  spanEndMs: number
): { meanBpm: number | null; minutes: number } {
  const asleep = (
    db
      .prepare(
        `SELECT started_at, ended_at FROM metric_samples
          WHERE profile_id = ? AND metric = 'sleep_min'
            AND date >= ? AND date <= ?`
      )
      .all(
        profileId,
        dayOffset(new Date(spanStartMs).toISOString().slice(0, 10), -1),
        dayOffset(new Date(spanEndMs).toISOString().slice(0, 10), 1)
      ) as { started_at: string; ended_at: string }[]
  )
    .map((r) => ({ s: Date.parse(r.started_at), e: Date.parse(r.ended_at) }))
    .filter((r) => Number.isFinite(r.s) && Number.isFinite(r.e) && r.e > r.s)
    .sort((x, y) => x.s - y.s);

  // The span minus every recorded session, as the intervals that are left.
  const awake: { s: number; e: number }[] = [];
  let cursor = spanStartMs;
  for (const block of asleep) {
    if (block.e <= cursor) continue;
    if (block.s > cursor)
      awake.push({ s: cursor, e: Math.min(block.s, spanEndMs) });
    cursor = Math.max(cursor, block.e);
    if (cursor >= spanEndMs) break;
  }
  if (cursor < spanEndMs) awake.push({ s: cursor, e: spanEndMs });

  const totals = db.prepare(
    `SELECT COUNT(*) AS c, SUM(bpm) AS s FROM hr_minutes
      WHERE profile_id = ? AND ts >= ? AND ts < ?`
  );
  let minutes = 0;
  let sum = 0;
  for (const gap of awake) {
    if (gap.e <= gap.s) continue;
    const row = totals.get(
      profileId,
      utcMinute(new Date(gap.s)),
      utcMinute(new Date(gap.e))
    ) as { c: number; s: number | null };
    minutes += row.c;
    sum += row.s ?? 0;
  }
  return { meanBpm: minutes > 0 ? sum / minutes : null, minutes };
}

/**
 * Collapse the same-origin overlapping sleep sessions this push touched.
 *
 * Returns the number of `metric_samples` rows removed — the losing session plus the stage
 * rows that went with it — which the caller reports as this push's `superseded` split, so
 * Review says a stored night was deleted rather than "nothing new".
 */
export function collapseSleepSessionOverlaps(
  profileId: number,
  source: string,
  pushedAt: string | null
): number {
  const tolerance = dipToleranceMs(source);
  if (pushedAt === null || tolerance === null) return 0;

  const touched = db
    .prepare(
      `SELECT id, date, metric, origin, started_at, ended_at, edited
         FROM metric_samples
        WHERE profile_id = ? AND source = ? AND pushed_at = ? AND metric = 'sleep_min'
        ORDER BY id`
    )
    .all(profileId, source, pushedAt) as StoredRow[];
  if (touched.length === 0) return 0;

  const findSessions = db.prepare(
    `SELECT id, date, metric, origin, started_at, ended_at, edited
       FROM metric_samples
      WHERE profile_id = ? AND metric = 'sleep_min' AND source = ?
        AND date >= ? AND date <= ?
      ORDER BY id`
  );
  const findStages = db.prepare(
    `SELECT id, date, metric, origin, started_at, ended_at, edited
       FROM metric_samples
      WHERE profile_id = ? AND source = ? AND origin IS ?
        AND metric IN ${STAGE_METRICS_SQL}
        AND date >= ? AND date <= ?
      ORDER BY id`
  );
  const dropRow = db.prepare(
    "DELETE FROM metric_samples WHERE id = ? AND profile_id = ?"
  );

  let removed = 0;
  const settled = new Set<number>();

  for (const session of touched) {
    if (settled.has(session.id)) continue;
    const from = dayOffset(session.date, -CANDIDATE_DAY_RADIUS);
    const to = dayOffset(session.date, CANDIDATE_DAY_RADIUS);
    const neighbourhood = findSessions.all(
      profileId,
      source,
      from,
      to
    ) as StoredRow[];
    for (const pair of sleepOverlapPairs(neighbourhood)) {
      const { a, b } = pair;
      if (a.id !== session.id && b.id !== session.id) continue;
      if (settled.has(a.id) || settled.has(b.id)) continue;

      const observations = {
        a: observeHeartRate(
          pair.aStartMs,
          pair.aEndMs,
          heartRateInWindow(profileId, pair.aStartMs, pair.aEndMs)
        ),
        b: observeHeartRate(
          pair.bStartMs,
          pair.bEndMs,
          heartRateInWindow(profileId, pair.bStartMs, pair.bEndMs)
        ),
      };
      const reference = awakeReference(
        profileId,
        Math.min(pair.aStartMs, pair.bStartMs) - REFERENCE_SPAN_MS,
        Math.max(pair.aEndMs, pair.bEndMs) + REFERENCE_SPAN_MS
      );
      // THE REFERENCE MUST BE AT LEAST AS WELL OBSERVED AS THE CLAIM IT JUDGES. Stated as
      // a relationship rather than as a minute count, so there is no constant here to be
      // wrong for a short nap or for a twelve-hour window: a mean over ten awake minutes
      // does not get to delete a night measured over six hours.
      const enough =
        reference.minutes >=
        Math.max(observations.a.covered, observations.b.covered);
      const verdict = decideSleepOverlap(
        pair,
        observations,
        enough ? reference.meanBpm : null,
        tolerance
      );
      if (verdict.kind === "undecided") continue;

      const { keep, drop } = verdict;
      const dropWindow =
        drop.id === a.id
          ? { startMs: pair.aStartMs, endMs: pair.aEndMs }
          : { startMs: pair.bStartMs, endMs: pair.bEndMs };
      const owned = stagesOwnedBy(
        dropWindow,
        neighbourhood.filter((s) => s.id !== drop.id),
        findStages.all(profileId, source, drop.origin, from, to) as StoredRow[]
      );
      // THE #133 LOCK COVERS THE BREAKDOWN, NOT ONLY THE TOTAL. A hand-corrected stage
      // row is the person's, and deleting the session out from under it would leave an
      // edited row belonging to a night that no longer exists — so an edited stage holds
      // the WHOLE collapse, and the pair is left for them to resolve.
      if (owned.some((stage) => stage.edited)) continue;

      for (const row of [drop, ...owned]) {
        removed += dropRow.run(row.id, profileId).changes;
        // The exporter keeps re-sending the losing record for up to 48 h, so the natural
        // key has to stay dead or the next push re-inserts it.
        writeImportTombstone(
          profileId,
          "metric_samples",
          metricSampleTombstoneKey(
            row.metric,
            source,
            row.origin,
            row.started_at
          )
        );
      }
      settled.add(drop.id);
      settled.add(keep.id);
    }
  }
  return removed;
}
