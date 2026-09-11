// PER-SOURCE COMPARISON SERIES — one of the five submodules behind
// lib/queries/metrics.ts (issue #5171): the "Compare sources" overlay's per-source
// daily series over metric_samples, body_metrics and hr_minutes, windowed and
// in-range. Every read is profile-scoped.

import { db } from "../../db";
import {
  SOURCE_PREFERENCE,
  pickRowsOneOriginPerSourceDay,
} from "../../metric-sources";
import { sourceKey } from "../../metric-source-priority";
import { getTimezone } from "../../settings";
import { localDayOf, localDaySpan } from "../../local-day-window";
import { metricAggregation } from "../../metric-buckets";
import type { BodyMetricKind } from "../../types";
import {
  bodyMetricColumn,
  hrDayAggregates,
  hrInstantBounds,
  recentHrCutoff,
} from "./common";

// ---- Per-source comparison series (issue #14) ----
// The raw material for the "Compare sources" overlay: the SAME daily rollup the
// single-series charts use, but grouped per source instead of collapsed to one.
// Sources are ordered by the default source preference (then alphabetically) so
// series colors/legends are stable.

export interface MetricSourceSeries {
  source: string; // sourceKey — 'manual' covers NULL/manual provenance
  data: { date: string; value: number }[]; // oldest→newest
}

function orderSources(sources: string[]): string[] {
  return sources.sort((a, b) => {
    const ia = SOURCE_PREFERENCE.indexOf(a);
    const ib = SOURCE_PREFERENCE.indexOf(b);
    if (ia !== -1 || ib !== -1) {
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    }
    return a < b ? -1 : 1;
  });
}

function foldSourceSeries(
  rows: { date: string; source: string | null; value: number }[]
): MetricSourceSeries[] {
  const bySource = new Map<string, { date: string; value: number }[]>();
  for (const r of rows) {
    const key = sourceKey(r.source);
    let list = bySource.get(key);
    if (!list) {
      list = [];
      bySource.set(key, list);
    }
    list.push({ date: r.date, value: r.value });
  }
  return orderSources([...bySource.keys()]).map((source) => ({
    source,
    data: bySource.get(source)!.sort((a, b) => (a.date < b.date ? -1 : 1)),
  }));
}

// Per-source daily series for a metric_samples metric (SUM or AVG per the
// metric's aggregation; empty for a categorical metric, which does not
// aggregate), windowed to the limitDays most recent dates-with-data.
export function getMetricSeriesBySource(
  profileId: number,
  metric: string,
  limitDays = 180
): MetricSourceSeries[] {
  const recentDates = db
    .prepare(
      `SELECT date FROM metric_samples WHERE profile_id = ? AND metric = ?
        GROUP BY date ORDER BY date DESC LIMIT ?`
    )
    .all(profileId, metric, limitDays) as { date: string }[];
  if (recentDates.length === 0) return [];
  const cutoff = recentDates[recentDates.length - 1].date;
  return getMetricSeriesBySourceInRange(profileId, metric, cutoff, null);
}

// Exact calendar-window variant for a detail page whose source overlay must obey
// the SAME range control as its authoritative chart. Null on either side means
// unbounded on that side; both null is reserved for an explicit all-time view.
export function getMetricSeriesBySourceInRange(
  profileId: number,
  metric: string,
  from: string | null,
  to: string | null
): MetricSourceSeries[] {
  const agg = metricAggregation(metric);
  switch (agg) {
    case "SUM": {
      const rows = db
        .prepare(
          `SELECT date, source, origin, SUM(value) AS value
             FROM metric_samples
            WHERE profile_id = ? AND metric = ?
              AND date >= COALESCE(?, '0000-00-00')
              AND date <= COALESCE(?, '9999-12-31')
            GROUP BY date, source, origin`
        )
        .all(profileId, metric, from, to) as {
        date: string;
        source: string | null;
        origin: string | null;
        value: number;
      }[];
      return foldSourceSeries(
        pickRowsOneOriginPerSourceDay(
          rows,
          (r) => r.date,
          (r) => r.source,
          (r) => r.origin,
          (r) => r.value
        )
      );
    }
    case "AVG": {
      const rows = db
        .prepare(
          `SELECT date, source, AVG(value) AS value
             FROM metric_samples
            WHERE profile_id = ? AND metric = ?
              AND date >= COALESCE(?, '0000-00-00')
              AND date <= COALESCE(?, '9999-12-31')
            GROUP BY date, source`
        )
        .all(profileId, metric, from, to) as {
        date: string;
        source: string | null;
        value: number;
      }[];
      return foldSourceSeries(rows);
    }
    case "NONE":
      // A CATEGORICAL metric declines to aggregate (#3167), and a per-source daily
      // series is an aggregation like any other — a day's readings would have to be
      // averaged or summed per source to become one point. NO SERIES is the honest
      // answer; the overlay renders nothing rather than a fabricated daily category.
      return [];
    default: {
      const exhaustive: never = agg;
      return exhaustive;
    }
  }
}

// Per-source daily series for a body_metrics column (weight/body fat/resting HR),
// canonical units, windowed to the limitDays most-recent dates-with-data.
export function getBodyMetricSeriesBySource(
  profileId: number,
  metric: BodyMetricKind,
  limitDays = 365
): MetricSourceSeries[] {
  const col = bodyMetricColumn(metric);
  // Window by the limitDays most-recent DISTINCT dates (issue #623), NOT an outer
  // row LIMIT over (date,source) groups: a row LIMIT counts group rows, so N
  // sources would shrink each source's span to ~limitDays/N. `>= cutoff` gives
  // every source the full window, exactly as getMetricSeriesBySource does.
  const recentDates = db
    .prepare(
      `SELECT DISTINCT date FROM body_metrics
        WHERE profile_id = ? AND ${col} IS NOT NULL
        ORDER BY date DESC LIMIT ?`
    )
    .all(profileId, limitDays) as { date: string }[];
  if (recentDates.length === 0) return [];
  const cutoff = recentDates[recentDates.length - 1].date;
  return getBodyMetricSeriesBySourceInRange(profileId, metric, cutoff, null);
}

export function getBodyMetricSeriesBySourceInRange(
  profileId: number,
  metric: BodyMetricKind,
  from: string | null,
  to: string | null
): MetricSourceSeries[] {
  const col = bodyMetricColumn(metric);
  const rows = db
    .prepare(
      `SELECT date, source, AVG(${col}) AS value FROM body_metrics
        WHERE profile_id = ? AND ${col} IS NOT NULL
          AND date >= COALESCE(?, '0000-00-00')
          AND date <= COALESCE(?, '9999-12-31')
        GROUP BY date, source`
    )
    .all(profileId, from, to) as {
    date: string;
    source: string | null;
    value: number;
  }[];
  return foldSourceSeries(rows);
}

// Per-source daily average HR from the 1-minute buckets.
export function getHrSeriesBySource(
  profileId: number,
  limitDays = 180
): MetricSourceSeries[] {
  // Bound the GROUP BY to the limitDays most-recent DISTINCT days-with-data
  // (issue #387/#623) via `>= cutoff` and NO outer row LIMIT: an outer
  // `LIMIT limitDays` counts (date,source) GROUP rows, so N sources would consume
  // the window N× faster (2 sources → only ~limitDays/2 days per source). The
  // cutoff already bounds the day span, exactly as getMetricSeriesBySource does,
  // giving every source the full window.
  const cutoff = recentHrCutoff(profileId, limitDays);
  if (cutoff === null) return [];
  return getHrSeriesBySourceInRange(profileId, cutoff, null);
}

export function getHrSeriesBySourceInRange(
  profileId: number,
  from: string | null,
  to: string | null
): MetricSourceSeries[] {
  const tz = getTimezone(profileId);
  const bounds = hrInstantBounds(profileId);
  if (!bounds) return [];
  const fromDay = from ?? localDayOf(tz, bounds.first);
  const toDay = to ?? localDayOf(tz, bounds.last);
  if (!fromDay || !toDay || fromDay > toDay) return [];
  const { startUtc, endUtc } = localDaySpan(tz, fromDay, toDay);
  const rows = hrDayAggregates(profileId, tz, startUtc, endUtc).map((r) => ({
    date: r.date,
    source: r.source,
    value: r.avg,
  }));
  return foldSourceSeries(rows);
}
