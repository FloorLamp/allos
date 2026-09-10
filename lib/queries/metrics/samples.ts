// INTEGRATION METRIC SAMPLES (steps, distance, calories, HR) — one of the five
// submodules behind lib/queries/metrics.ts (issue #5171): the per-day totals of a
// metric_samples metric under the one-source-per-day election, the additive batch
// read, the latest reading, and the pediatric growth series. Every read is
// profile-scoped.

import { db } from "../../db";
import { ALL_ROWS } from "../../trends";
import { snapshotCached } from "../../read-snapshot";
import {
  SOURCE_PREFERENCE,
  pickOneSourcePerDay,
  pickRowsOneOriginPerSourceDay,
} from "../../metric-sources";
import { resolveMetricSources } from "../../metric-source-priority";
import { getMetricSourcePriority } from "../../settings";
import { metricAggregation } from "../../metric-buckets";
import { getBodyMetricDailySeries } from "./body";
import { choiceFor, markPartialToday, sourceMatchSql } from "./common";

// ---- Integration metrics (steps, distance, calories, HR) ----

// Daily values for a metric, oldest→newest: averaged per day for instantaneous
// point metrics (see AVERAGED_METRICS), summed for additive ones.
//
// Source handling (issue #14): an ADDITIVE metric is never summed across sources
// — every SUM metric picks one source per day (the profile's primary source
// first, else the default preference, else single-source passthrough), so two
// synced sources cannot double-count; hydration adds manual contributions (#4148).
// A POINT (AVG) metric
// keeps averaging every source's readings per day (they measure the same
// quantity and a same-date manual + imported reading must agree, not sum);
// an explicit primary source narrows it to that source's readings.
//
// Strict mode (#1642) removes both fallbacks: only the chosen source's rows are
// read, and an empty result stays empty rather than reverting to all sources.
function getMetricDailyTotalsUncached(
  profileId: number,
  metric: string,
  limitDays = 180
): { date: string; value: number; partial?: true }[] {
  const priority = getMetricSourcePriority(profileId);
  if (metricAggregation(metric) === "AVG") {
    const chosen = priority[metric];
    if (chosen) {
      const cond = sourceMatchSql(chosen.source);
      const rows = db
        .prepare(
          `SELECT date, AVG(value) AS value
             FROM metric_samples WHERE profile_id = ? AND metric = ? AND ${cond.sql}
            GROUP BY date ORDER BY date DESC LIMIT ?`
        )
        .all(profileId, metric, ...cond.params, limitDays) as {
        date: string;
        value: number;
      }[];
      // Fall through to the all-sources read when the chosen source has no data
      // at all, so a stale pick can't blank the chart — unless the pick is
      // STRICT, where an empty chart is the honest answer.
      if (rows.length > 0 || chosen.strict) return rows.reverse();
    }
    const rows = db
      .prepare(
        `SELECT date, AVG(value) AS value
           FROM metric_samples WHERE profile_id = ? AND metric = ?
          GROUP BY date ORDER BY date DESC LIMIT ?`
      )
      .all(profileId, metric, limitDays) as { date: string; value: number }[];
    return rows.reverse();
  }
  // An additive daily total ACCUMULATES through the local day, so today's is a
  // running number rather than the day's (#4924). The AVG branch above returns
  // point readings, which are complete when taken.
  return markPartialToday(
    profileId,
    getAdditiveMetricDailyTotalsBatchWithPriority(
      profileId,
      [metric],
      limitDays,
      priority
    ).get(metric)!
  );
}
export const getMetricDailyTotals = snapshotCached(
  "metrics.daily-totals",
  (profileId: number, metric: string, limitDays = 180) =>
    `${profileId}:${metric}:${limitDays}`,
  getMetricDailyTotalsUncached
);

type AdditiveDailyRow = {
  metric: string;
  date: string;
  source: string | null;
  origin: string | null;
  value: number;
};

// The additive half of getMetricDailyTotals for several metrics at once. The
// ranked-date CTE preserves the existing latest-N-DATES bound independently per
// metric, while the shared projection below remains the one source-election rule.
function getAdditiveMetricDailyTotalsBatchWithPriority(
  profileId: number,
  metrics: readonly string[],
  limitDays: number,
  priority: ReturnType<typeof getMetricSourcePriority>
): Map<string, { date: string; value: number }[]> {
  const unique = [...new Set(metrics)];
  const out = new Map(
    unique.map((metric) => [metric, [] as { date: string; value: number }[]])
  );
  if (unique.length === 0 || limitDays === 0) return out;
  const placeholders = unique.map(() => "?").join(", ");
  const bounded = limitDays >= 0;
  const rows = db
    .prepare(
      `WITH ranked_dates AS (
         SELECT metric, date,
                ROW_NUMBER() OVER (
                  PARTITION BY metric ORDER BY date DESC
                ) AS recency
           FROM metric_samples
          WHERE profile_id = ? AND metric IN (${placeholders})
          GROUP BY metric, date
       )
       SELECT samples.metric, samples.date, samples.source, samples.origin,
              SUM(samples.value) AS value
         FROM metric_samples samples
         JOIN ranked_dates dates
           ON dates.metric = samples.metric AND dates.date = samples.date
          ${bounded ? "AND dates.recency <= ?" : ""}
        WHERE samples.profile_id = ?
        GROUP BY samples.metric, samples.date, samples.source, samples.origin`
    )
    .all(
      profileId,
      ...unique,
      ...(bounded ? [limitDays] : []),
      profileId
    ) as AdditiveDailyRow[];

  for (const metric of unique) {
    const candidates = rows.filter((row) => row.metric === metric);
    out.set(
      metric,
      pickOneSourcePerDay(
        pickRowsOneOriginPerSourceDay(
          candidates,
          (row) => row.date,
          (row) => row.source,
          (row) => row.origin,
          (row) => row.value
        ),
        resolveMetricSources(metric, priority, SOURCE_PREFERENCE),
        metric === "hydration_l" ? "manual" : undefined
      ).sort((left, right) => left.date.localeCompare(right.date))
    );
  }
  return out;
}

export function getAdditiveMetricDailyTotalsBatch(
  profileId: number,
  metrics: readonly string[],
  limitDays = 180
): Map<string, { date: string; value: number }[]> {
  for (const metric of metrics) {
    if (metricAggregation(metric) !== "SUM") {
      throw new Error(`${metric} is not an additive metric`);
    }
  }
  return getAdditiveMetricDailyTotalsBatchWithPriority(
    profileId,
    metrics,
    limitDays,
    getMetricSourcePriority(profileId)
  );
}

// The most recent value for a point metric (e.g. 'height_cm'), or null.
// The most recent metric_samples reading with its measured date (the ended_at's
// calendar day), or null. The passport surfaces the date next to each stat.
// A configured primary source (issue #14) wins when it has any reading; a
// profile without one (or whose chosen source has no data) reads the newest
// reading regardless of source, as before. A STRICT choice (#1642) never falls
// back: no reading from that source means null, not another source's number.
export function getLatestMetricSample(
  profileId: number,
  metric: string
): { value: number; date: string } | null {
  const chosen = choiceFor(profileId, metric);
  if (chosen) {
    const cond = sourceMatchSql(chosen.source);
    const row = db
      .prepare(
        `SELECT value, substr(ended_at, 1, 10) AS date FROM metric_samples
          WHERE profile_id = ? AND metric = ? AND ${cond.sql}
          ORDER BY ended_at DESC LIMIT 1`
      )
      .get(profileId, metric, ...cond.params) as
      { value: number; date: string } | undefined;
    if (row) return row;
    if (chosen.strict) return null;
  }
  const row = db
    .prepare(
      "SELECT value, substr(ended_at, 1, 10) AS date FROM metric_samples WHERE profile_id = ? AND metric = ? ORDER BY ended_at DESC LIMIT 1"
    )
    .get(profileId, metric) as { value: number; date: string } | undefined;
  return row ?? null;
}

export function getLatestMetricValue(
  profileId: number,
  metric: string
): number | null {
  return getLatestMetricSample(profileId, metric)?.value ?? null;
}

// The three dated series a pediatric growth trajectory is built from, in canonical
// cm / kg: height and head circumference from metric_samples, weight from
// body_metrics. ONE reader, so every growth surface scores the same rows (#2802) —
// the passport badge used to skip the series entirely and score two scalars.
//
// Unbounded (ALL_ROWS) on purpose: a growth chart plots the child's WHOLE
// trajectory, and the default row cap silently started the percentile track a few
// months ago on a daily-synced child (#399).
export function getGrowthMeasurementSeries(profileId: number): {
  heights: { date: string; value: number }[];
  weights: { date: string; value: number }[];
  headCircs: { date: string; value: number }[];
} {
  return {
    heights: getMetricDailyTotals(profileId, "height_cm", ALL_ROWS),
    weights: getBodyMetricDailySeries(profileId, "weight", ALL_ROWS),
    headCircs: getMetricDailyTotals(
      profileId,
      "head_circumference_cm",
      ALL_ROWS
    ),
  };
}
