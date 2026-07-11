import { db } from "../db";
import {
  PROVIDER_PREFERENCE,
  pickOneProviderPerDay,
  pickRowsOneSourcePerDay,
} from "../metric-providers";
import { sourceKey, sourcePreference } from "../metric-source-priority";
import { getMetricSourcePriority } from "../settings";
import { metricAggregation } from "../metric-buckets";
import { DOCUMENT_SOURCE_PREFIX } from "../body-metric-extract";
import { getIntegration } from "../integrations/registry";
import type {
  BodyMetric,
  BodyMetricKind,
  BodyMetricWithSource,
  HrMinute,
  IntegrationId,
} from "../types";

// The profile's source-preference list for a metric (issue #14): its explicit
// primary source first (when set), then the instance defaults. Consumed by the
// one-source-per-day pickers so additive metrics never sum across sources; for a
// single-source profile this degrades to passthrough.
function preferenceFor(profileId: number, metric: string): string[] {
  return sourcePreference(
    metric,
    getMetricSourcePriority(profileId),
    PROVIDER_PREFERENCE
  );
}

// ---- Body metrics ----
export function getBodyMetrics(profileId: number, limit = 365): BodyMetric[] {
  return db
    .prepare(
      "SELECT * FROM body_metrics WHERE profile_id = ? ORDER BY date DESC LIMIT ?"
    )
    .all(profileId, limit) as BodyMetric[];
}

// Weight series (rows that actually carry a weight), newest first. body_metrics
// interleaves weightless HR/body-fat rows, so a weight consumer MUST filter
// in SQL: a JS filter after a LIMIT would let a run of weightless days starve the
// window (e.g. a daily-HR syncer with weekly weigh-ins). weight_kg is non-null on
// every returned row. Backs the dashboard + weight-page weight/BMI charts.
export function getWeights(
  profileId: number,
  limit = 365
): (BodyMetric & { weight_kg: number })[] {
  return db
    .prepare(
      "SELECT * FROM body_metrics WHERE profile_id = ? AND weight_kg IS NOT NULL ORDER BY date DESC LIMIT ?"
    )
    .all(profileId, limit) as (BodyMetric & { weight_kg: number })[];
}

// Human label for a source document: its lab/provider, else doc type, else
// filename. Shared by the body-metrics history and the biomarker readings table
// so the same document is named identically on every provenance surface.
export function documentLabel(d: {
  source: string | null;
  doc_type: string | null;
  filename: string | null;
}): string {
  return d.source || d.doc_type || d.filename || "Document";
}

// Body-metrics rows with their provenance resolved for the history table: rows
// imported from a medical document ('document:<id>') pick up the document's label
// and id for linking; integration ids resolve to the registry's display name;
// manual rows (source NULL, or the journal's 'manual') label as "Manual".
export function getBodyMetricsWithSource(
  profileId: number,
  limit = 365
): BodyMetricWithSource[] {
  const rows = db
    .prepare(
      `SELECT w.*, d.id AS document_id, d.source AS doc_source,
              d.doc_type AS doc_type, d.filename AS doc_filename
         FROM body_metrics w
         LEFT JOIN medical_documents d
           ON w.source = '${DOCUMENT_SOURCE_PREFIX}' || d.id
          AND d.profile_id = w.profile_id
        WHERE w.profile_id = ?
        ORDER BY w.date DESC
        LIMIT ?`
    )
    .all(profileId, limit) as (BodyMetric & {
    document_id: number | null;
    doc_source: string | null;
    doc_type: string | null;
    doc_filename: string | null;
  })[];
  return rows.map(({ doc_source, doc_type, doc_filename, ...w }) => ({
    ...w,
    source_label:
      w.document_id != null
        ? documentLabel({
            source: doc_source,
            doc_type,
            filename: doc_filename,
          })
        : !w.source || w.source === "manual"
          ? "Manual"
          : w.source.startsWith(DOCUMENT_SOURCE_PREFIX)
            ? "Document" // source document row no longer exists
            : (getIntegration(w.source as IntegrationId)?.name ?? w.source),
  }));
}

// ---- Integration metrics (steps, distance, calories, HR) ----

// Daily values for a metric, oldest→newest: averaged per day for instantaneous
// point metrics (see AVERAGED_METRICS), summed for additive ones.
//
// Source handling (issue #14): an ADDITIVE metric is never summed across sources
// — every SUM metric picks one source per day (the profile's primary source
// first, else the default preference, else single-source passthrough), so two
// providers reporting the same day can't double-count. A POINT (AVG) metric
// keeps averaging every source's readings per day (they measure the same
// quantity and a same-date manual + imported reading must agree, not sum);
// an explicit primary source narrows it to that source's readings.
export function getMetricDailyTotals(
  profileId: number,
  metric: string,
  limitDays = 180
): { date: string; value: number }[] {
  const priority = getMetricSourcePriority(profileId);
  if (metricAggregation(metric) === "AVG") {
    const chosen = priority[metric];
    if (chosen) {
      const rows = db
        .prepare(
          `SELECT date, AVG(value) AS value
             FROM metric_samples WHERE profile_id = ? AND metric = ? AND source = ?
            GROUP BY date ORDER BY date DESC LIMIT ?`
        )
        .all(profileId, metric, chosen, limitDays) as {
        date: string;
        value: number;
      }[];
      // Fall through to the all-sources read when the chosen source has no data
      // at all, so a stale pick can't blank the chart.
      if (rows.length > 0) return rows.reverse();
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
  // Additive metric: one source per day. pickOneProviderPerDay must run in JS,
  // so we can't just LIMIT the aggregate; instead find the cutoff date of the
  // limitDays most-recent dates-with-data first, then aggregate only from there.
  // This is exact (the output is those same dates), while bounding both the SUM
  // scan and the JS work to the window instead of all history.
  const recentDates = db
    .prepare(
      `SELECT date FROM metric_samples WHERE profile_id = ? AND metric = ?
        GROUP BY date ORDER BY date DESC LIMIT ?`
    )
    .all(profileId, metric, limitDays) as { date: string }[];
  if (recentDates.length === 0) return [];
  const cutoff = recentDates[recentDates.length - 1].date;
  const rows = db
    .prepare(
      `SELECT date, source, SUM(value) AS value
         FROM metric_samples WHERE profile_id = ? AND metric = ? AND date >= ?
        GROUP BY date, source`
    )
    .all(profileId, metric, cutoff) as {
    date: string;
    source: string | null;
    value: number;
  }[];
  return pickOneProviderPerDay(
    rows,
    sourcePreference(metric, priority, PROVIDER_PREFERENCE)
  )
    .sort((a, b) => (a.date < b.date ? 1 : -1))
    .slice(0, limitDays)
    .reverse();
}

// The most recent value for a point metric (e.g. 'height_cm'), or null.
// The most recent metric_samples reading with its measured date (the end_time's
// calendar day), or null. The passport surfaces the date next to each stat.
// A configured primary source (issue #14) wins when it has any reading; a
// profile without one (or whose chosen source has no data) reads the newest
// reading regardless of source, as before.
export function getLatestMetricSample(
  profileId: number,
  metric: string
): { value: number; date: string } | null {
  const chosen = getMetricSourcePriority(profileId)[metric];
  if (chosen) {
    const row = db
      .prepare(
        "SELECT value, substr(end_time, 1, 10) AS date FROM metric_samples WHERE profile_id = ? AND metric = ? AND source = ? ORDER BY end_time DESC LIMIT 1"
      )
      .get(profileId, metric, chosen) as
      { value: number; date: string } | undefined;
    if (row) return row;
  }
  const row = db
    .prepare(
      "SELECT value, substr(end_time, 1, 10) AS date FROM metric_samples WHERE profile_id = ? AND metric = ? ORDER BY end_time DESC LIMIT 1"
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

// Per-night sleep stage totals (minutes), oldest→newest, pivoted from the four
// sleep_*_min metrics. Each metric is summed per date (a night maps to one date —
// its wake day — set by the parser). Stage minutes are additive, and two sources
// can report the same night (Health Connect + Oura), so ONE source is kept per
// night (issue #14) — keyed by the 'sleep_min' primary-source choice so the
// nightly-duration chart and the stage breakdown always agree on whose night is
// shown.
export function getSleepStageDailyTotals(
  profileId: number,
  limitDays = 180
): { date: string; deep: number; rem: number; light: number; awake: number }[] {
  const recentDates = db
    .prepare(
      `SELECT date FROM metric_samples
        WHERE profile_id = ?
          AND metric IN ('sleep_deep_min','sleep_rem_min','sleep_light_min','sleep_awake_min')
        GROUP BY date ORDER BY date DESC LIMIT ?`
    )
    .all(profileId, limitDays) as { date: string }[];
  if (recentDates.length === 0) return [];
  const cutoff = recentDates[recentDates.length - 1].date;
  const rows = db
    .prepare(
      `SELECT date, source,
              SUM(CASE WHEN metric = 'sleep_deep_min'  THEN value ELSE 0 END) AS deep,
              SUM(CASE WHEN metric = 'sleep_rem_min'   THEN value ELSE 0 END) AS rem,
              SUM(CASE WHEN metric = 'sleep_light_min' THEN value ELSE 0 END) AS light,
              SUM(CASE WHEN metric = 'sleep_awake_min' THEN value ELSE 0 END) AS awake
         FROM metric_samples
        WHERE profile_id = ? AND date >= ?
          AND metric IN ('sleep_deep_min','sleep_rem_min','sleep_light_min','sleep_awake_min')
        GROUP BY date, source`
    )
    .all(profileId, cutoff) as {
    date: string;
    source: string | null;
    deep: number;
    rem: number;
    light: number;
    awake: number;
  }[];
  return pickRowsOneSourcePerDay(
    rows,
    preferenceFor(profileId, "sleep_min"),
    (r) => r.date,
    (r) => r.source,
    (r) => r.deep + r.rem + r.light + r.awake
  )
    .map(({ date, deep, rem, light, awake }) => ({
      date,
      deep,
      rem,
      light,
      awake,
    }))
    .sort((a, b) => (a.date < b.date ? -1 : 1))
    .slice(-limitDays);
}

// Raw per-night sleep sessions (metric 'sleep_min') as absolute time windows,
// newest→oldest, capped at `limit` rows — the input to the Sleep Regularity Index
// (#160), which needs each session's start/end INSTANTS (not the derived per-day
// totals) to reconstruct the sleep/wake timeline in the profile timezone.
//
// Source handling (issue #14): the SRI math assumes ONE session stream — two
// sources reporting the same nights would interleave duplicate windows and wreck
// the timing statistics. When several sources have sessions, the profile's
// 'sleep_min' primary source wins; unset (or a chosen source with no sessions)
// falls back to the source of the most recent session (the most-recently-synced
// stream). A single-source profile is passthrough, as before.
export function getSleepSessions(
  profileId: number,
  limit = 800
): { start: string; end: string; source: string | null }[] {
  const sources = (
    db
      .prepare(
        `SELECT DISTINCT source FROM metric_samples
          WHERE profile_id = ? AND metric = 'sleep_min'`
      )
      .all(profileId) as { source: string | null }[]
  ).map((r) => r.source);
  let sourceFilter = "";
  let params: (number | string)[] = [profileId, limit];
  if (sources.length > 1) {
    const chosen = getMetricSourcePriority(profileId)["sleep_min"];
    let picked =
      chosen != null && sources.some((s) => sourceKey(s) === chosen)
        ? chosen
        : null;
    if (picked == null) {
      const newest = db
        .prepare(
          `SELECT source FROM metric_samples
            WHERE profile_id = ? AND metric = 'sleep_min'
            ORDER BY end_time DESC LIMIT 1`
        )
        .get(profileId) as { source: string | null } | undefined;
      picked = sourceKey(newest?.source);
    }
    sourceFilter = " AND source = ?";
    params = [profileId, picked, limit];
  }
  return db
    .prepare(
      `SELECT start_time AS start, end_time AS end, source
         FROM metric_samples
        WHERE profile_id = ? AND metric = 'sleep_min'${sourceFilter}
        ORDER BY end_time DESC LIMIT ?`
    )
    .all(...params) as {
    start: string;
    end: string;
    source: string | null;
  }[];
}

// Daily HR summary derived from the 1-minute buckets, oldest→newest. Since the
// hr_minutes key gained `source` (migration 013, issue #14) two sources can carry
// the same minutes, so each day keeps ONE source's buckets — the 'heart_rate'
// primary source when set, else the default preference, else the source with the
// most minutes that day — instead of blending overlapping streams.
export function getHrDailySummary(
  profileId: number,
  limitDays = 180
): { date: string; avg: number; min: number; max: number }[] {
  const rows = db
    .prepare(
      `SELECT substr(ts,1,10) AS date, source,
              AVG(bpm) AS avg, MIN(bpm_min) AS min, MAX(bpm_max) AS max,
              COUNT(*) AS n
         FROM hr_minutes
        WHERE profile_id = ?
        GROUP BY substr(ts,1,10), source`
    )
    .all(profileId) as {
    date: string;
    source: string | null;
    avg: number;
    min: number;
    max: number;
    n: number;
  }[];
  return pickRowsOneSourcePerDay(
    rows,
    preferenceFor(profileId, "heart_rate"),
    (r) => r.date,
    (r) => r.source,
    (r) => r.n
  )
    .sort((a, b) => (a.date < b.date ? -1 : 1))
    .slice(-limitDays)
    .map(({ date, avg, min, max }) => ({ date, avg, min, max }));
}

// The most recent day that has any HR buckets, or null.
export function getLatestHrDay(profileId: number): string | null {
  const row = db
    .prepare(
      "SELECT substr(ts,1,10) AS date FROM hr_minutes WHERE profile_id = ? ORDER BY ts DESC LIMIT 1"
    )
    .get(profileId) as { date: string } | undefined;
  return row?.date ?? null;
}

// A single day's 1-minute HR buckets, ordered by time. One source per day
// (issue #14) — same pick as getHrDailySummary — so an intraday chart never
// zig-zags between two devices' overlapping minutes.
export function getHrMinutes(profileId: number, date: string): HrMinute[] {
  const rows = db
    .prepare(
      "SELECT * FROM hr_minutes WHERE profile_id = ? AND substr(ts,1,10) = ? ORDER BY ts"
    )
    .all(profileId, date) as HrMinute[];
  return pickRowsOneSourcePerDay(
    rows,
    preferenceFor(profileId, "heart_rate"),
    () => date,
    (r) => r.source
  );
}

// Per-minute HR buckets (ts + bpm) within an inclusive [since, until] date range
// (until omitted = open-ended), one source per day — the shared read behind the
// training-zone aggregations (lib/queries/zones.ts), so zone minutes can't
// double-count a workout recorded by two HR sources at once (issue #14).
export function getHrMinutesInRange(
  profileId: number,
  since: string,
  until?: string
): { ts: string; bpm: number }[] {
  const rows = (
    until != null
      ? db
          .prepare(
            `SELECT ts, bpm, source FROM hr_minutes
              WHERE profile_id = ? AND substr(ts,1,10) >= ? AND substr(ts,1,10) <= ?`
          )
          .all(profileId, since, until)
      : db
          .prepare(
            `SELECT ts, bpm, source FROM hr_minutes
              WHERE profile_id = ? AND substr(ts,1,10) >= ?`
          )
          .all(profileId, since)
  ) as { ts: string; bpm: number; source: string | null }[];
  return pickRowsOneSourcePerDay(
    rows,
    preferenceFor(profileId, "heart_rate"),
    (r) => r.ts.slice(0, 10),
    (r) => r.source
  ).map(({ ts, bpm }) => ({ ts, bpm }));
}

function bodyMetricColumn(metric: BodyMetricKind): string {
  return metric === "weight"
    ? "weight_kg"
    : metric === "body_fat"
      ? "body_fat_pct"
      : "resting_hr";
}

// SQL condition matching a body_metrics row to a primary-source pick. 'manual'
// covers both NULL (quick-add) and the journal's literal 'manual'.
function bodySourceCondition(source: string): {
  sql: string;
  params: string[];
} {
  return source === "manual"
    ? { sql: "(source IS NULL OR source = 'manual')", params: [] }
    : { sql: "source = ?", params: [source] };
}

// The most recent (non-null) recorded value for a body metric with its measured
// date, or null. The passport shows the date next to each body stat.
// A configured primary source for the metric (issue #14) wins when it has any
// reading; otherwise (or when that source has none) the newest reading of any
// source is returned, as before.
export function getLatestBodyMetricDated(
  profileId: number,
  metric: BodyMetricKind
): { value: number; date: string } | null {
  const col = bodyMetricColumn(metric);
  const chosen = getMetricSourcePriority(profileId)[metric];
  if (chosen) {
    const cond = bodySourceCondition(chosen);
    const row = db
      .prepare(
        `SELECT ${col} AS value, date FROM body_metrics
          WHERE profile_id = ? AND ${col} IS NOT NULL AND ${cond.sql}
          ORDER BY date DESC, id DESC LIMIT 1`
      )
      .get(profileId, ...cond.params) as
      { value: number; date: string } | undefined;
    if (row) return row;
  }
  const row = db
    .prepare(
      `SELECT ${col} AS value, date FROM body_metrics WHERE profile_id = ? AND ${col} IS NOT NULL ORDER BY date DESC, id DESC LIMIT 1`
    )
    .get(profileId) as { value: number; date: string } | undefined;
  return row ?? null;
}

// The most recent (non-null) recorded value for a body metric, or null.
export function getLatestBodyMetric(
  profileId: number,
  metric: BodyMetricKind
): number | null {
  return getLatestBodyMetricDated(profileId, metric)?.value ?? null;
}

// One value per day for a body metric (canonical units), oldest→newest — the
// series behind the weight / body-fat / resting-HR trend charts. Two sources can
// report the same day (body_metrics keys on (profile_id, date, source)), so each
// day keeps ONE source's reading (primary source first — issue #14); several
// same-day rows from the kept source (possible for manual rows, whose NULL
// source is exempt from the unique key) are averaged.
export function getBodyMetricDailySeries(
  profileId: number,
  metric: BodyMetricKind,
  limit = 365
): { date: string; value: number }[] {
  const col = bodyMetricColumn(metric);
  const rows = db
    .prepare(
      `SELECT date, source, ${col} AS value FROM body_metrics
        WHERE profile_id = ? AND ${col} IS NOT NULL
        ORDER BY date DESC LIMIT ?`
    )
    .all(profileId, limit) as {
    date: string;
    source: string | null;
    value: number;
  }[];
  const picked = pickRowsOneSourcePerDay(
    rows,
    preferenceFor(profileId, metric),
    (r) => r.date,
    (r) => r.source
  );
  // Average any remaining same-day rows (same source), then emit oldest→newest.
  const byDate = new Map<string, { sum: number; n: number }>();
  for (const r of picked) {
    const acc = byDate.get(r.date) ?? { sum: 0, n: 0 };
    acc.sum += r.value;
    acc.n += 1;
    byDate.set(r.date, acc);
  }
  return [...byDate.entries()]
    .map(([date, { sum, n }]) => ({ date, value: sum / n }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
}

// ---- Per-source comparison series (issue #14) ----
// The raw material for the "Compare sources" overlay: the SAME daily rollup the
// single-series charts use, but grouped per source instead of collapsed to one.
// Sources are ordered by the default provider preference (then alphabetically) so
// series colors/legends are stable.

export interface MetricSourceSeries {
  source: string; // sourceKey — 'manual' covers NULL/manual provenance
  data: { date: string; value: number }[]; // oldest→newest
}

function orderSources(sources: string[]): string[] {
  return sources.sort((a, b) => {
    const ia = PROVIDER_PREFERENCE.indexOf(a);
    const ib = PROVIDER_PREFERENCE.indexOf(b);
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
// metric's aggregation), windowed to the limitDays most recent dates-with-data.
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
  const agg = metricAggregation(metric);
  const rows = db
    .prepare(
      `SELECT date, source, ${agg}(value) AS value
         FROM metric_samples WHERE profile_id = ? AND metric = ? AND date >= ?
        GROUP BY date, source`
    )
    .all(profileId, metric, cutoff) as {
    date: string;
    source: string | null;
    value: number;
  }[];
  return foldSourceSeries(rows);
}

// Per-source daily series for a body_metrics column (weight/body fat/resting HR),
// canonical units.
export function getBodyMetricSeriesBySource(
  profileId: number,
  metric: BodyMetricKind,
  limit = 365
): MetricSourceSeries[] {
  const col = bodyMetricColumn(metric);
  const rows = db
    .prepare(
      `SELECT date, source, AVG(${col}) AS value FROM body_metrics
        WHERE profile_id = ? AND ${col} IS NOT NULL
        GROUP BY date, source ORDER BY date DESC LIMIT ?`
    )
    .all(profileId, limit) as {
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
  const rows = db
    .prepare(
      `SELECT substr(ts,1,10) AS date, source, AVG(bpm) AS value
         FROM hr_minutes
        WHERE profile_id = ?
        GROUP BY substr(ts,1,10), source ORDER BY date DESC LIMIT ?`
    )
    .all(profileId, limitDays) as {
    date: string;
    source: string | null;
    value: number;
  }[];
  return foldSourceSeries(rows);
}
