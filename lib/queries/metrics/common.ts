// Directory-private helpers shared by the submodules behind lib/queries/metrics.ts
// (issue #5171): the profile's source resolution and single-source choice for a
// metric with the SQL mirror of the selector match, the partial-today mark an
// accumulating daily bucket carries, the body_metrics column a BodyMetricKind reads,
// and the hr_minutes profile-local day-window aggregates (their convention is at the
// top of ./hr.ts). Nothing here is re-exported by the barrel.

import { db, today } from "../../db";
import { SOURCE_PREFERENCE } from "../../metric-sources";
import {
  DOCUMENTS_SOURCE_CLASS,
  resolveMetricSources,
  type MetricSourceChoice,
  type SourceResolution,
} from "../../metric-source-priority";
import { getMetricSourcePriority } from "../../settings";
import {
  localDayOf,
  localDayRange,
  offsetSegments,
} from "../../local-day-window";
import { profileDayZone } from "../../travel-excusal";
import type { ProfileDayZone } from "../../travel-timezone";
import { DOCUMENT_SOURCE_PREFIX } from "../../body-metric-extract";
import type { BodyMetricKind } from "../../types";

// The profile's resolved source selection for a metric (issues #14/#1640/#1642):
// its explicit primary source or class first (when set), then the instance
// defaults — or, in strict mode, that one selector ALONE. Consumed by the
// one-source-per-day pickers so additive metrics never sum across sources; for a
// single-source profile this degrades to passthrough.
function resolutionFor(profileId: number, metric: string): SourceResolution {
  return resolveMetricSources(
    metric,
    getMetricSourcePriority(profileId),
    SOURCE_PREFERENCE
  );
}

// The profile's explicit choice for a metric, or undefined when unset — the
// single-value reads' entry point (they resolve one source, not a per-day order).
function choiceFor(
  profileId: number,
  metric: string
): MetricSourceChoice | undefined {
  return getMetricSourcePriority(profileId)[metric];
}

// SQL mirror of sourceMatchesSelector: the condition matching a row's `source`
// column to ONE selector. 'manual' covers NULL (quick-add rows) as well as the
// training log's literal 'manual'; the 'documents' CLASS (#1640) covers every
// 'document:<id>' provenance through a prefix LIKE. Callers splice `sql` into a
// WHERE clause and spread `params` at that position.
function sourceMatchSql(selector: string): { sql: string; params: string[] } {
  if (selector === DOCUMENTS_SOURCE_CLASS) {
    return { sql: `source LIKE '${DOCUMENT_SOURCE_PREFIX}%'`, params: [] };
  }
  return selector === "manual"
    ? { sql: "(source IS NULL OR source = 'manual')", params: [] }
    : { sql: "source = ?", params: [selector] };
}

// ── THE DAY THAT IS NOT OVER (#4924) ────────────────────────────────────────
//
// A daily bucket over a STREAM is a running total until local midnight, and every
// reader here handed today's half-day back looking exactly like a finished one.
// On the owner's morning screenshot the Heart Rate card's headline read 59 bpm —
// an overnight-plus-morning average — off a last point that fell off a cliff, and
// Active Calories spiked for the same reason in the other direction. The as-of
// stamp could not help: it is a STALENESS gate, so a today-dated reading is
// treated as maximally trustworthy exactly when it is least finished.
//
// The flag is on the ROW because only the reader knows which day the profile is
// living in, and it is set only where the bucket genuinely accumulates: an
// additive daily total and the HR minute aggregate. A point reading taken today
// (a height, a tape measure) is complete the moment it is taken, and calling it
// partial would be a second, wrong claim.
//
// A metric with no row for today is untouched — there is nothing to qualify.

/** A daily row's day is the profile's own today, so the bucket is still filling. */
function markPartialToday<T extends { date: string }>(
  profileId: number,
  rows: T[]
): (T & { partial?: true })[] {
  const last = rows.at(-1);
  if (!last || last.date !== today(profileId)) return rows;
  return [...rows.slice(0, -1), { ...last, partial: true as const }];
}

// The body_metrics column a body metric reads — shared by the latest/dated body
// reads and the per-source body series.
function bodyMetricColumn(metric: BodyMetricKind): string {
  return metric === "weight"
    ? "weight_kg"
    : metric === "body_fat"
      ? "body_fat_pct"
      : "resting_hr";
}

// hr_minutes day-window aggregates, shared by the hr_minutes readers (./hr.ts) and
// the per-source HR series (./by-source.ts).
interface HrDayRow {
  date: string;
  source: string | null;
  avg: number;
  min: number;
  max: number;
  n: number;
}

// Fold per-segment aggregates into one row per (day, source). `avg` is re-weighted by
// bucket COUNT — averaging two averages would silently weight a 3-hour DST tail the
// same as the 21 hours before it.
function mergeHrDayRows(rows: HrDayRow[]): HrDayRow[] {
  const byKey = new Map<string, HrDayRow>();
  for (const r of rows) {
    const key = `${r.date}\u001f${r.source ?? ""}`;
    const seen = byKey.get(key);
    if (!seen) {
      byKey.set(key, { ...r });
      continue;
    }
    const n = seen.n + r.n;
    seen.avg = n > 0 ? (seen.avg * seen.n + r.avg * r.n) / n : seen.avg;
    seen.min = Math.min(seen.min, r.min);
    seen.max = Math.max(seen.max, r.max);
    seen.n = n;
  }
  return [...byKey.values()];
}

// Per-(local day, source) HR aggregates over the half-open UTC window, segment by
// segment. Returns [] for an empty window.
function hrDayAggregates(
  profileId: number,
  zone: ProfileDayZone,
  startUtc: string,
  endUtc: string
): HrDayRow[] {
  const stmt = db.prepare(
    `SELECT date(ts, ?) AS date, source,
            AVG(bpm) AS avg, MIN(bpm_min) AS min, MAX(bpm_max) AS max,
            COUNT(*) AS n
       FROM hr_minutes
      WHERE profile_id = ? AND ts >= ? AND ts < ?
      GROUP BY date(ts, ?), source`
  );
  const out: HrDayRow[] = [];
  // A DST transition and a recorded travel switch are the same kind of boundary to
  // this loop (#3428): each piece carries the offset the profile's day was actually
  // running on, so a pre-move day still buckets midnight-to-midnight in the zone it
  // was lived in instead of being re-spanned under the zone it is standing in now.
  for (const seg of offsetSegments(zone, startUtc, endUtc)) {
    out.push(
      ...(stmt.all(
        seg.modifier,
        profileId,
        seg.startUtc,
        seg.endUtc,
        seg.modifier
      ) as HrDayRow[])
    );
  }
  return mergeHrDayRows(out);
}

// The profile's newest and oldest stored instants, or null when it has no HR at all.
// The open-ended readers need real data bounds to build a window from, and scanning to
// find them would undo the point.
//
// TWO SEEKS, AND THEY HAD TO BE WRITTEN AS TWO (#5201). The comment here used to
// promise "two indexed seeks" over `SELECT MIN(ts), MAX(ts) … WHERE profile_id = ?`,
// and that promise was not kept: SQLite's min/max optimisation applies to a query with
// exactly ONE aggregate, so asking for both in one statement gives up the index walk
// and visits every row the profile has. The dashboard runs this three times a warm
// render, so it grew with the profile's whole history inside otherwise bounded readers.
//
// TWO MEASUREMENTS, AND THEY ARE NOT THE SAME MEASUREMENT — said this way because an
// earlier draft of this comment quoted one of them while describing the other's setup,
// which is how a number stops being attributable:
//   • #5201 measured a fresh PRODUCTION snapshot, 125,951 rows for the profile:
//     6.91 ms median for the combined form against 0.016 ms for the endpoint form.
//   • The change itself was measured on a SYNTHETIC in-memory table of the same row
//     count with two neighbour profiles sharing the index, on one box: 18.07 ms
//     against 0.020 ms, over 100 alternating pairs after warmup.
// Neither is an end-to-end speedup claim, and the two disagree by a factor the setups
// account for. What both say, and all that is being claimed here, is that one form
// grows with the profile's history and the other does not.
//
// Each subquery seeks one end of the `(profile_id, ts, source)` index — the table's
// primary key since `014-hr-minutes-per-source.ts` added `source` to the pair the
// baseline declared — which already covers both columns; no new index and no history
// cutoff. `ts` is NOT NULL, so `ORDER BY ts` and `MIN`/`MAX` cannot disagree about a
// missing value — the one way this substitution could have changed an answer.
function hrInstantBounds(
  profileId: number
): { first: string; last: string } | null {
  const row = db
    .prepare(
      `SELECT
         (SELECT ts FROM hr_minutes WHERE profile_id = ?
           ORDER BY ts ASC LIMIT 1) AS first,
         (SELECT ts FROM hr_minutes WHERE profile_id = ?
           ORDER BY ts DESC LIMIT 1) AS last`
    )
    .get(profileId, profileId) as { first: string | null; last: string | null };
  return row.first && row.last ? { first: row.first, last: row.last } : null;
}

// The date (YYYY-MM-DD) of the `limitDays`-th most-recent distinct HR day, or null
// when the profile has no hr_minutes at all. Used as an inclusive `>= cutoff` lower
// bound so the daily-summary / per-source reads GROUP BY only the recent window
// instead of all history — hr_minutes is the fastest-growing table (~0.5M rows/year
// for an all-day wearable), so an unbounded GROUP BY sorts a million rows per Trends
// render on year two (issue #387). Bounding at this cutoff is EXACT: the window it
// opens holds precisely the limitDays most-recent days-with-data, which is the same
// window the callers' post-group slice/LIMIT already kept.
//
// The walk below replaced a DISTINCT-days scan when #2205 made `ts` a UTC instant.
// That scan leaned on idx_hr_minutes_day over `substr(ts,1,10)`, which migration 164
// dropped: a substring of a UTC instant is a UTC day, and every caller wants the
// profile-local one. Seeking day-by-day costs limitDays indexed lookups instead of
// one scan, and is exact under DST where a substring never could be.
function recentHrCutoff(profileId: number, limitDays: number): string | null {
  const bounds = hrInstantBounds(profileId);
  if (!bounds) return null;
  const zone = profileDayZone(profileId);
  let day = localDayOf(zone, bounds.last);
  if (!day) return null;
  if (limitDays < 0) return localDayOf(zone, bounds.first);
  // Walk back one day-with-data at a time: from the current day's UTC start, the
  // newest row STRICTLY BEFORE it is the newest row of the previous day-with-data.
  // Each step is one indexed seek on (profile_id, ts), so the whole walk is
  // `limitDays` seeks and never scans the days in between — the #387 bound, kept.
  // The old DISTINCT-days scan leaned on idx_hr_minutes_day, which 164 dropped
  // because a substring of a UTC instant is a UTC day, not this one.
  const prev = db.prepare(
    `SELECT ts FROM hr_minutes
      WHERE profile_id = ? AND ts < ?
      ORDER BY ts DESC LIMIT 1`
  );
  for (let seen = 1; seen < limitDays; seen++) {
    const row = prev.get(profileId, localDayRange(zone, day).startUtc) as
      { ts: string } | undefined;
    if (!row) break;
    const earlier = localDayOf(zone, row.ts);
    if (!earlier) break;
    day = earlier;
  }
  return day;
}

// Shared with the sibling submodules only; the barrel does not re-export these.
export {
  bodyMetricColumn,
  choiceFor,
  hrDayAggregates,
  hrInstantBounds,
  markPartialToday,
  recentHrCutoff,
  resolutionFor,
  sourceMatchSql,
};
