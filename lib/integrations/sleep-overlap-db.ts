import { db } from "@/lib/db";
import { parseUtcSql, shiftDateStr, utcMinute } from "@/lib/date";
import {
  decideSleepOverlap,
  observeHeartRate,
  sleepOverlapPairs,
  SLEEP_STAGE_METRICS,
  stagesOwnedBy,
  type HeartRateMinute,
  type SleepOverlapPair,
  type SleepSessionRow,
} from "@/lib/sleep-overlap";
import { instantMs, windowsOverlap } from "@/lib/metric-window-overlap";
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

// DERIVED from the one list, never restated: a second spelling here could drift from
// the one the re-time reads (#5021) and strand a stage row on a night that has moved.
const STAGE_METRICS_SQL = `(${SLEEP_STAGE_METRICS.map((m) => `'${m}'`).join(",")})`;

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

// ── THE RE-STAMPED TWIN (#5020) ──────────────────────────────────────────────
// A zone error larger than the night is long produces two rows that do not touch, so
// `sleepOverlapPairs` — which is geometry and nothing else — forms no pair, and the
// fragment merge in `mainSleepPeriod` then glues the twin onto the real night as its
// second half. The 08-30 pair on prod is two 298-minute rows six hours apart.
//
// What identifies them is not their duration. Two nights of the same length are ordinary
// and pairing on that alone would offer a real night up to the collapse. What identifies
// them is that they carry THE SAME STAGE BREAKDOWN, shifted whole: every stage of one
// sits at the same offset inside its session as a stage of the other, same metric, same
// length. That is a re-write of one recording, not two sleeps that happen to match.
//
// It needs the stage read, which is why it lives here beside the heart-rate observation
// and not in the pure half (owner ruling, 2026-09-04).
//
// Pairing is ALL this does. Everything after it is unchanged: `decideSleepOverlap` still
// collapses only when exactly one window is corroborated by the person's own heart rate,
// and neither or both leaves the pair standing for Data → Review.
const TWIN_SHIFT_MAX_MS = 24 * 60 * 60 * 1000;

// A stage set of ONE metric is a duration, not a shape. Two thirty-minute naps recorded
// as one light block each would otherwise match each other exactly, and two naps are two
// sleeps. The cost is a twin whose whole night was scored with a single metric, which
// this rule then does not see — a miss, and a miss is the failure this rule is allowed.
function stageShape(
  sessionStartMs: number,
  stages: readonly SleepSessionRow[]
): string | null {
  if (new Set(stages.map((s) => s.metric)).size < 2) return null;
  return stages
    .map((stage) => {
      const from = (instantMs(stage.started_at) ?? 0) - sessionStartMs;
      const to = (instantMs(stage.ended_at) ?? 0) - sessionStartMs;
      return `${stage.metric}@${from}+${to - from}`;
    })
    .sort()
    .join("|");
}

/**
 * The same-origin sessions in `sessions` that are one recording written twice.
 *
 * Non-overlapping by construction — an overlapping pair is `sleepOverlapPairs`'s, and
 * these two sets never intersect. The shift must be non-zero and UNDER A DAY: a day or
 * more apart is another night, not the same one re-stamped, and a person on an identical
 * schedule two nights running sits at exactly a day. That bound is what keeps them out,
 * so it also means an offset error of a day or more is not seen here — the observed
 * errors are zone offsets of a few hours.
 */
export function restampedTwinPairs<
  T extends SleepSessionRow & { date: string },
>(
  profileId: number,
  source: string,
  sessions: readonly T[]
): SleepOverlapPair<T>[] {
  if (sessions.length < 2) return [];
  const days = sessions.map((s) => s.date).sort();
  const stages = db
    .prepare(
      `SELECT id, date, metric, origin, started_at, ended_at, edited
         FROM metric_samples
        WHERE profile_id = ? AND source = ? AND metric IN ${STAGE_METRICS_SQL}
          AND date >= ? AND date <= ?
        ORDER BY id`
    )
    .all(
      profileId,
      source,
      days[0],
      days[days.length - 1]
    ) as SleepSessionRow[];
  if (stages.length === 0) return [];

  const shapeOf = (session: T, startMs: number, endMs: number): string | null =>
    stageShape(
      startMs,
      stagesOwnedBy(
        { date: session.date, startMs, endMs },
        sessions.filter((s) => s.id !== session.id),
        stages.filter((stage) => stage.origin === session.origin)
      )
    );

  const pairs: SleepOverlapPair<T>[] = [];
  for (let i = 0; i < sessions.length; i++) {
    for (let j = i + 1; j < sessions.length; j++) {
      const a = sessions[i];
      const b = sessions[j];
      if (a.origin === null || b.origin === null || a.origin !== b.origin)
        continue;
      const aStartMs = instantMs(a.started_at);
      const aEndMs = instantMs(a.ended_at);
      const bStartMs = instantMs(b.started_at);
      const bEndMs = instantMs(b.ended_at);
      if (
        aStartMs === null ||
        aEndMs === null ||
        bStartMs === null ||
        bEndMs === null
      )
        continue;
      if (windowsOverlap(a.started_at, a.ended_at, b.started_at, b.ended_at))
        continue;
      // ONE delta, on both edges: the whole window moved, nothing was re-scored.
      const shift = bStartMs - aStartMs;
      if (shift === 0 || bEndMs - aEndMs !== shift) continue;
      if (Math.abs(shift) >= TWIN_SHIFT_MAX_MS) continue;
      const shapeA = shapeOf(a, aStartMs, aEndMs);
      if (shapeA === null || shapeA !== shapeOf(b, bStartMs, bEndMs)) continue;
      pairs.push({ a, b, aStartMs, aEndMs, bStartMs, bEndMs });
    }
  }
  return pairs;
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
        shiftDateStr(new Date(spanStartMs).toISOString().slice(0, 10), -1),
        shiftDateStr(new Date(spanEndMs).toISOString().slice(0, 10), 1)
      ) as { started_at: string; ended_at: string }[]
  )
    // parseUtcSql: `metric_samples.started_at`/`ended_at` carry no brand; a synced
    // session's own absolute instant is the shape expected here (#5338).
    .map((r) => ({
      s: parseUtcSql(r.started_at)?.getTime() ?? NaN,
      e: parseUtcSql(r.ended_at)?.getTime() ?? NaN,
    }))
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
    .all(profileId, source, pushedAt) as SleepSessionRow[];
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
    const from = shiftDateStr(session.date, -CANDIDATE_DAY_RADIUS);
    const to = shiftDateStr(session.date, CANDIDATE_DAY_RADIUS);
    const neighbourhood = findSessions.all(
      profileId,
      source,
      from,
      to
    ) as SleepSessionRow[];
    for (const pair of [
      ...sleepOverlapPairs(neighbourhood),
      ...restampedTwinPairs(profileId, source, neighbourhood),
    ]) {
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
          ? { date: drop.date, startMs: pair.aStartMs, endMs: pair.aEndMs }
          : { date: drop.date, startMs: pair.bStartMs, endMs: pair.bEndMs };
      const owned = stagesOwnedBy(
        dropWindow,
        neighbourhood.filter((s) => s.id !== drop.id),
        findStages.all(
          profileId,
          source,
          drop.origin,
          from,
          to
        ) as SleepSessionRow[]
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
