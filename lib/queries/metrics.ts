import { db } from "../db";
import {
  MULTI_PROVIDER_METRICS,
  PROVIDER_PREFERENCE,
  pickOneProviderPerDay,
} from "../metric-providers";
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
export function getMetricDailyTotals(
  profileId: number,
  metric: string,
  limitDays = 180
): { date: string; value: number }[] {
  // Additive metrics that multiple providers report get one provider per day so
  // overlapping sources don't double-count. pickOneProviderPerDay must run in JS,
  // so we can't just LIMIT the aggregate; instead find the cutoff date of the
  // limitDays most-recent dates-with-data first, then aggregate only from there.
  // This is exact (the output is those same dates), while bounding both the SUM
  // scan and the JS work to the window instead of all history.
  if (MULTI_PROVIDER_METRICS.has(metric)) {
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
    return pickOneProviderPerDay(rows, PROVIDER_PREFERENCE)
      .sort((a, b) => (a.date < b.date ? 1 : -1))
      .slice(0, limitDays)
      .reverse();
  }
  const agg = metricAggregation(metric);
  const rows = db
    .prepare(
      `SELECT date, ${agg}(value) AS value
         FROM metric_samples WHERE profile_id = ? AND metric = ?
        GROUP BY date ORDER BY date DESC LIMIT ?`
    )
    .all(profileId, metric, limitDays) as { date: string; value: number }[];
  return rows.reverse();
}

// The most recent value for a point metric (e.g. 'height_cm'), or null.
// The most recent metric_samples reading with its measured date (the end_time's
// calendar day), or null. The passport surfaces the date next to each stat.
export function getLatestMetricSample(
  profileId: number,
  metric: string
): { value: number; date: string } | null {
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
// its wake day — set by the parser).
export function getSleepStageDailyTotals(
  profileId: number,
  limitDays = 180
): { date: string; deep: number; rem: number; light: number; awake: number }[] {
  const rows = db
    .prepare(
      `SELECT date,
              SUM(CASE WHEN metric = 'sleep_deep_min'  THEN value ELSE 0 END) AS deep,
              SUM(CASE WHEN metric = 'sleep_rem_min'   THEN value ELSE 0 END) AS rem,
              SUM(CASE WHEN metric = 'sleep_light_min' THEN value ELSE 0 END) AS light,
              SUM(CASE WHEN metric = 'sleep_awake_min' THEN value ELSE 0 END) AS awake
         FROM metric_samples
        WHERE profile_id = ?
          AND metric IN ('sleep_deep_min','sleep_rem_min','sleep_light_min','sleep_awake_min')
        GROUP BY date ORDER BY date DESC LIMIT ?`
    )
    .all(profileId, limitDays) as {
    date: string;
    deep: number;
    rem: number;
    light: number;
    awake: number;
  }[];
  return rows.reverse();
}

// Raw per-night sleep sessions (metric 'sleep_min') as absolute time windows,
// newest→oldest, capped at `limit` rows — the input to the Sleep Regularity Index
// (#160), which needs each session's start/end INSTANTS (not the derived per-day
// totals) to reconstruct the sleep/wake timeline in the profile timezone. `source`
// is carried for future source-aware handling (Oura, #140 / #14).
export function getSleepSessions(
  profileId: number,
  limit = 800
): { start: string; end: string; source: string | null }[] {
  return db
    .prepare(
      `SELECT start_time AS start, end_time AS end, source
         FROM metric_samples
        WHERE profile_id = ? AND metric = 'sleep_min'
        ORDER BY end_time DESC LIMIT ?`
    )
    .all(profileId, limit) as {
    start: string;
    end: string;
    source: string | null;
  }[];
}

// Daily HR summary derived from the 1-minute buckets, oldest→newest.
export function getHrDailySummary(
  profileId: number,
  limitDays = 180
): { date: string; avg: number; min: number; max: number }[] {
  const rows = db
    .prepare(
      `SELECT substr(ts,1,10) AS date,
              AVG(bpm) AS avg, MIN(bpm_min) AS min, MAX(bpm_max) AS max
         FROM hr_minutes
        WHERE profile_id = ?
        GROUP BY substr(ts,1,10) ORDER BY date DESC LIMIT ?`
    )
    .all(profileId, limitDays) as {
    date: string;
    avg: number;
    min: number;
    max: number;
  }[];
  return rows.reverse();
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

// A single day's 1-minute HR buckets, ordered by time.
export function getHrMinutes(profileId: number, date: string): HrMinute[] {
  return db
    .prepare(
      "SELECT * FROM hr_minutes WHERE profile_id = ? AND substr(ts,1,10) = ? ORDER BY ts"
    )
    .all(profileId, date) as HrMinute[];
}

// The most recent (non-null) recorded value for a body metric with its measured
// date, or null. The passport shows the date next to each body stat.
export function getLatestBodyMetricDated(
  profileId: number,
  metric: BodyMetricKind
): { value: number; date: string } | null {
  const col =
    metric === "weight"
      ? "weight_kg"
      : metric === "body_fat"
        ? "body_fat_pct"
        : "resting_hr";
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
