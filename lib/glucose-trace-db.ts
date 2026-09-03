// The WRITE PATH for the continuous-glucose trace (#2810), and the recompute that
// keeps its daily derivations in step. The derivation math itself is pure and lives
// in lib/glucose-trace.ts; nothing here re-derives it.
//
// TWO STORES, ONE ENTRY POINT. docs/internals/reading-model.md splits continuous
// glucose at the grain boundary: the raw per-5-minute trace is its own narrow
// instant-keyed table, and the once-a-day summaries it supports are `metric_samples`
// metrics. Those halves must never disagree, so there is exactly one way in —
// `recordGlucoseTrace` — which writes the points and then recomputes every
// profile-local day the batch touched, in one transaction.
//
// RECOMPUTED FROM THE STORE, NEVER FROM THE BATCH. A push is a rolling window: it
// may carry the tail of yesterday and half of today, and a later push fills the
// rest. Deriving a day's mean from the batch alone would publish a summary of
// whatever happened to arrive together. So the recompute re-reads the day's FULL
// stored trace, which also makes it idempotent — replaying a push writes the same
// summary rather than a different one.
//
// THE DERIVED ROWS GO THROUGH `upsertMetricSamples`, not a private INSERT. That core
// already answers the three questions a `metric_samples` writer has to answer — the
// #508 re-import tombstone, the #133 user-edit lock, and the insert/update/unchanged
// split the sync ledger counts — and re-implementing any of them here would be a
// second, quieter answer to a question that has one.
//
// PROFILE-LOCAL DAYS OVER A UTC COLUMN. `glucose_trace.ts` is a canonical UTC
// instant; every question here is a profile-LOCAL day question. The translation is
// lib/local-day-window.ts, the same seam `hr_minutes`' readers use since #2205: a
// day becomes a half-open UTC range the primary key's own index serves as a range
// scan, and `localDayOf` names the day a point belongs to. A day containing a DST
// transition is 23 or 25 hours long and comes out right because both edges are
// settled against the offset in force at that edge.

import { db, writeTx } from "./db";
import { utcMinute, parseUtcSql } from "./date";
import { localDayOf, localDayRange } from "./local-day-window";
import { getTimezone } from "./settings";
import {
  upsertMetricSamples,
  type NormMetricSample,
} from "./integrations/normalize";
import {
  classifyUpsert,
  emptyCounts,
  foldCounts,
  tallyUpsert,
  type UpsertCounts,
} from "./integrations/sync-log";
import {
  deriveGlucoseDay,
  GLUCOSE_DERIVED_METRICS,
  GLUCOSE_MEAN_METRIC,
  GLUCOSE_TIME_IN_RANGE_METRIC,
  GLUCOSE_TRACE_POINTS_METRIC,
  type GlucoseTracePoint,
} from "./glucose-trace";

/** One incoming sensor reading, before it is minute-truncated onto the key. */
export interface GlucoseTraceInput {
  /** Any parseable instant; stored minute-truncated on the canonical convention. */
  ts: string;
  mgdl: number;
}

export interface GlucoseTraceWrite {
  /** The trace's own insert/update/unchanged split. */
  trace: UpsertCounts;
  /** The derived `metric_samples` rows' split, folded across every touched day. */
  derived: UpsertCounts;
  /** The profile-local days the batch caused to be recomputed, ascending. */
  days: string[];
  /** Points the batch carried that had no usable instant or value. */
  skipped: number;
}

// The physiologic bound a sensor value has to sit inside to be stored at all. A CGM
// reports roughly 40–400 mg/dL and clamps at both ends; a value outside that is a
// parse error or a unit mix-up (an mmol/L number arriving unconverted reads as 5.4),
// and storing it would poison a mean that has no band to look wrong against.
const MIN_MGDL = 20;
const MAX_MGDL = 600;

/** Every stored trace point of one profile-local day, ascending by instant. */
export function getGlucoseTraceDay(
  profileId: number,
  day: string,
  source: string
): GlucoseTracePoint[] {
  const { startUtc, endUtc } = localDayRange(getTimezone(profileId), day);
  return db
    .prepare(
      `SELECT ts, mgdl FROM glucose_trace
        WHERE profile_id = ? AND source = ? AND ts >= ? AND ts < ?
        ORDER BY ts`
    )
    .all(profileId, source, startUtc, endUtc) as GlucoseTracePoint[];
}

// Rewrite one profile-local day's three derived samples from the stored trace.
// A day the trace no longer covers writes nothing rather than a zeroed summary —
// `deriveGlucoseDay` returns null and the existing rows are left alone, because
// removing them is a delete and this is an upsert path.
function recomputeDay(
  profileId: number,
  day: string,
  source: string
): UpsertCounts {
  const derived = deriveGlucoseDay(getGlucoseTraceDay(profileId, day, source));
  if (!derived) return emptyCounts();
  const { startUtc, endUtc } = localDayRange(getTimezone(profileId), day);
  // The natural key `upsertMetricSamples` merges on is
  // (profile, metric, source, origin, started_at), so the day's own local-midnight
  // instant is what makes a recompute an UPDATE instead of a second row. A profile
  // timezone change moves that boundary and so lands a new row for the affected
  // days — the same #94 skew every other derived-day metric carries, stated rather
  // than silently patched.
  const rows: NormMetricSample[] = [
    { metric: GLUCOSE_MEAN_METRIC, value: derived.meanMgdl },
    { metric: GLUCOSE_TIME_IN_RANGE_METRIC, value: derived.timeInRangePct },
    { metric: GLUCOSE_TRACE_POINTS_METRIC, value: derived.points },
  ].map(({ metric, value }) => ({
    metric,
    date: day,
    started_at: startUtc,
    ended_at: endUtc,
    value,
    origin: null,
  }));
  return upsertMetricSamples(profileId, rows, source);
}

export interface GlucoseTraceOptions {
  /**
   * A source this write now KNOWS to be the same sensor, whose points it takes over.
   *
   * THE LATE-METADATA CASE (#3182, the owner's source-identity addendum). A trace's
   * `source` is in its primary key, and the Health Connect exporter emits record
   * metadata CONDITIONALLY — so the same sensor's readings arrive under a bare
   * fallback source while the metadata is missing and under a qualified one once it
   * appears. Left alone that is two traces for one sensor, and a re-push of a reading
   * already stored is a second POINT rather than an update of the first.
   *
   * So the qualified write absorbs the unqualified one: its rows are re-keyed onto
   * this source, and the days they covered join the recompute below. Absorption runs
   * BEFORE the upsert loop, which is what makes a re-pushed reading count as
   * `unchanged` instead of `inserted` — the point was already stored, only its source
   * was unknown.
   *
   * One-directional and one-way: a qualified source is never absorbed into anything.
   */
  absorbSource?: string;
}

/**
 * Store a batch of CGM points and refresh the days they touch.
 *
 * `source` is the integration id that produced them, and it is part of the trace's
 * primary key: two writers describing the same sensor coexist instead of clobbering
 * each other, and a re-push from the same source replaces its own points.
 */
export function recordGlucoseTrace(
  profileId: number,
  rows: readonly GlucoseTraceInput[],
  source: string,
  options: GlucoseTraceOptions = {}
): GlucoseTraceWrite {
  const tz = getTimezone(profileId);
  const out: GlucoseTraceWrite = {
    trace: emptyCounts(),
    derived: emptyCounts(),
    days: [],
    skipped: 0,
  };
  // Minute-truncate and validate BEFORE opening the transaction, so a batch of
  // unusable rows costs no write at all and the day set is known up front.
  const points: GlucoseTracePoint[] = [];
  const days = new Set<string>();
  for (const r of rows) {
    const at = parseUtcSql(r.ts);
    const mgdl =
      typeof r.mgdl === "number" && Number.isFinite(r.mgdl) ? r.mgdl : null;
    if (!at || mgdl == null || mgdl < MIN_MGDL || mgdl > MAX_MGDL) {
      out.skipped++;
      continue;
    }
    const ts = utcMinute(at);
    const day = localDayOf(tz, ts);
    if (!day) {
      out.skipped++;
      continue;
    }
    points.push({ ts, mgdl });
    days.add(day);
  }
  if (points.length === 0) {
    out.days = [...days].sort();
    return out;
  }

  const absorb =
    options.absorbSource && options.absorbSource !== source
      ? options.absorbSource
      : null;

  writeTx(() => {
    if (absorb) {
      // The absorbed trace's own days join the recompute — its points move under a
      // new source, and a day is summarised PER SOURCE, so a day this batch never
      // mentions would otherwise keep a summary of a trace that is no longer there.
      for (const r of db
        .prepare(
          "SELECT ts FROM glucose_trace WHERE profile_id = ? AND source = ?"
        )
        .all(profileId, absorb) as { ts: string }[]) {
        const day = localDayOf(tz, r.ts);
        if (day) days.add(day);
      }
      // `OR REPLACE`: an instant this sensor already holds under BOTH names is one
      // reading, so the collision is resolved rather than raised — and every day
      // involved is recomputed below, so no summary survives the move.
      db.prepare(
        "UPDATE OR REPLACE glucose_trace SET source = ? WHERE profile_id = ? AND source = ?"
      ).run(source, profileId, absorb);
      // The derived half moves with it, or the two stores disagree — this module's
      // one invariant. The values are rewritten by the recompute; this only stops the
      // old source keeping a day's summary it no longer has a trace for.
      db.prepare(
        `UPDATE OR REPLACE metric_samples SET source = ?
          WHERE profile_id = ? AND source = ? AND metric IN (${GLUCOSE_DERIVED_METRICS.map(() => "?").join(", ")})`
      ).run(source, profileId, absorb, ...GLUCOSE_DERIVED_METRICS);
    }
    out.days = [...days].sort();
    // Pre-image on the full key: a re-push of an identical point is `unchanged`,
    // not a write. better-sqlite3's `info.changes` counts a matched row whether or
    // not a value differed, so the compare has to be explicit — the same reason
    // every other upsert in the app reads before it writes.
    const find = db.prepare(
      "SELECT mgdl FROM glucose_trace WHERE profile_id = ? AND ts = ? AND source = ?"
    );
    const stmt = db.prepare(
      `INSERT INTO glucose_trace (profile_id, ts, mgdl, source)
         VALUES (?, ?, ?, ?)
       ON CONFLICT(profile_id, ts, source) DO UPDATE SET mgdl = excluded.mgdl`
    );
    for (const p of points) {
      const found = find.get(profileId, p.ts, source) as
        { mgdl: number } | undefined;
      stmt.run(profileId, p.ts, p.mgdl, source);
      tallyUpsert(out.trace, classifyUpsert(!!found, found?.mgdl === p.mgdl));
    }
    out.derived = foldCounts(
      out.days.map((day) => recomputeDay(profileId, day, source))
    );
  });
  return out;
}
