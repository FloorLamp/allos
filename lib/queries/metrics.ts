import { db, today } from "../db";
import { ALL_ROWS } from "../trends";
import { cache } from "../request-cache";
import { snapshotCached } from "../read-snapshot";
import { clampPage, pageCount, pageOffset } from "../pagination";
import { tickCached } from "../tick-cache";
import {
  SOURCE_PREFERENCE,
  foldDaysBySourceMean,
  pickOneSourcePerDay,
  pickRowsOneOriginPerSourceDay,
  pickRowsOneSourcePerDay,
  pickRowsOneSourcePerWindow,
  type DailySourcePoint,
} from "../metric-sources";
import {
  DOCUMENTS_SOURCE_CLASS,
  resolveMetricSources,
  sourceKey,
  type MetricSourceChoice,
  type SourceResolution,
} from "../metric-source-priority";
import { getMetricSourcePriority, getTimezone } from "../settings";
import {
  localDayOf,
  localDayRange,
  localDaySpan,
  localMinuteProjector,
  offsetSegments,
} from "../local-day-window";
import { profileDayZone } from "../travel-excusal";
import type { ProfileDayZone } from "../travel-timezone";
import {
  hhmmToMinutes,
  isDstTransitionDay,
  parseUtcSql,
  zonedDateParts,
} from "../date";
import type { ArrivalNight } from "../notifications/digest-schedule";
import { metricAggregation } from "../metric-buckets";
import { DOCUMENT_SOURCE_PREFIX } from "../body-metric-extract";
import { getIntegration } from "../integrations/registry";
import { mainSleepPeriod } from "../sleep-regularity";
import type {
  BodyMetric,
  BodyMetricKind,
  BodyMetricWithSource,
  HrMinute,
  IntegrationId,
} from "../types";

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

// ---- Body metrics ----
export function getBodyMetrics(profileId: number, limit = 365): BodyMetric[] {
  return db
    .prepare(
      "SELECT * FROM body_metrics WHERE profile_id = ? ORDER BY date DESC LIMIT ?"
    )
    .all(profileId, limit) as BodyMetric[];
}

// The stated instant of a day's MANUAL body-metrics row (source NULL — the
// quick-add convention), or null when the day has none stated. Seeds the
// measurements form's Time control (#2235 decision 5): re-opening the form for a
// day whose sitting already stated a time shows that time back, so a resubmission
// preserves it unless the user clears the field. The same `source IS NULL` +
// lowest-id pick the manual find-then-write targets, so the seed and the write can
// never disagree about which row "the day's manual reading" is.
export function getManualBodyMetricStatedAt(
  profileId: number,
  date: string
): string | null {
  const row = db
    .prepare(
      `SELECT occurred_at FROM body_metrics
        WHERE profile_id = ? AND date = ? AND source IS NULL
        ORDER BY id LIMIT 1`
    )
    .get(profileId, date) as { occurred_at: string | null } | undefined;
  return row?.occurred_at ?? null;
}

// Weight series (rows that actually carry a weight), newest first. body_metrics
// interleaves weightless HR/body-fat rows, so a weight consumer MUST filter
// in SQL: a JS filter after a LIMIT would let a run of weightless days starve the
// window (e.g. a daily-HR syncer with weekly weigh-ins). weight_kg is non-null on
// every returned row. Backs the dashboard + weight-page weight/BMI charts.
//
// REQUEST-CACHED because one dashboard render asks for the same window five times
// (#3369 item 2): the nutrition bodyweight reads, the training-detail series and the
// per-day source election all want the profile's weight history, and none of them can
// see that another already read it. Keyed on the arguments, so the 60-day window and
// the 365-day one stay separate reads. NO WRITER CAN INTERVENE (lib/queries/AGENTS.md):
// nothing that writes `body_metrics` reads this within one request — the fitness and
// goal actions read the latest value BEFORE their insert and never re-read after it.
// Callers may not mutate what they get back; today every one of them maps or filters
// first, which is what makes a shared array safe to hand out.
//
// The default lives on the EXPORTED wrapper rather than inside the memo. React's
// `cache()` keys on positional arguments, so `getWeights(p)` and `getWeights(p, 365)`
// would be two entries for one question; normalizing the arity here means the callers
// that pass the default explicitly and the ones that omit it share a read.
const getWeightsCached = cache(function getWeights(
  profileId: number,
  limit: number
): (BodyMetric & { weight_kg: number })[] {
  return db
    .prepare(
      "SELECT * FROM body_metrics WHERE profile_id = ? AND weight_kg IS NOT NULL ORDER BY date DESC LIMIT ?"
    )
    .all(profileId, limit) as (BodyMetric & { weight_kg: number })[];
});
export function getWeights(
  profileId: number,
  limit = 365
): (BodyMetric & { weight_kg: number })[] {
  return getWeightsCached(profileId, limit);
}

// Weight rows collapsed to ONE source per day (the profile's primary source first,
// #14), row id preserved, newest first — the day-over-day anomaly detector's input
// (#634). getWeights returns every source's row interleaved, so two scales
// reporting the same/adjacent day (body_metrics keys on (profile_id, date, source))
// feed the detector a false cross-source "jump"; collapsing per day mirrors the
// Trends → Overview → body census chart's getBodyMetricDailySeries so the finding and the chart it
// links to can't disagree. Unlike that series this keeps the id (the anomaly finding
// links to the exact offending row) and doesn't average — it hands whole rows to the
// pure detector.
export function getWeightsOneSourcePerDay(
  profileId: number,
  limit = 365
): (BodyMetric & { weight_kg: number })[] {
  return pickRowsOneSourcePerDay(
    getWeights(profileId, limit),
    resolutionFor(profileId, "weight"),
    (r) => r.date,
    (r) => r.source
  );
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
// manual rows (source NULL, or the training log's 'manual') label as "Manual".
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
        ${BODY_METRICS_ORDER}
        LIMIT ?`
    )
    .all(profileId, limit) as BodyMetricSourceRow[];
  return rows.map(withSourceLabel);
}

// Newest first, with `id` breaking a same-day tie. The tiebreak is what makes the
// order TOTAL, and a paged read needs that: with `date DESC` alone, two rows on one
// day may sort either way between two queries, so a row could show on both pages of
// a page boundary or on neither (#2530).
const BODY_METRICS_ORDER = "ORDER BY w.date DESC, w.id DESC";

type BodyMetricSourceRow = BodyMetric & {
  document_id: number | null;
  doc_source: string | null;
  doc_type: string | null;
  doc_filename: string | null;
};

function withSourceLabel({
  doc_source,
  doc_type,
  doc_filename,
  ...w
}: BodyMetricSourceRow): BodyMetricWithSource {
  return {
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
  };
}

export interface BodyMetricsPage {
  rows: BodyMetricWithSource[];
  total: number;
  page: number;
  pageSize: number;
}

// ONE page of the body-metrics history, newest first, plus the total the pager needs
// to say how much history there is (the audit viewer's `queryAuditEvents` shape).
//
// The history table on Trends is deliberately ALL-TIME — it is the record editor, and
// a stray row you want to delete is usually outside whatever window the charts above
// are showing — so the bound cannot come from the hub's date range; it has to be a
// page (#2530). A daily weigh-in over two years is ~700 rows, each carrying notes, a
// possible edit-lock badge and a client delete button, and before this the whole
// ledger was read and serialized into every render of the Body census.
// The inclusive upper day bound when a caller has none — later than any real
// `body_metrics.date`, so the predicate is a no-op rather than a second statement.
// ONE statement either way is deliberate: the scoping scanner reads the literal SQL
// text, and a pair of near-identical SELECTs is one more place for `profile_id` to go
// missing from only one of them.
const NO_DAY_BOUND = "9999-12-31";

export function getBodyMetricsPage(
  profileId: number,
  page: number,
  pageSize: number,
  // The newest day to include (inclusive). `/history` passes the subject's today:
  // the record ENDS AT NOW, and a bound applied after the read let future-dated rows
  // — which lib/ingest-bounds.ts deliberately admits up to 24h ahead for device clock
  // skew — consume slots the page had already counted against its limit (#3958).
  untilDate: string = NO_DAY_BOUND
): BodyMetricsPage {
  const size = Math.max(1, Math.trunc(pageSize));
  const total = (
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM body_metrics WHERE profile_id = ? AND date <= ?"
      )
      .get(profileId, untilDate) as { n: number }
  ).n;
  const clamped = Math.min(clampPage(page), pageCount(total, size));
  const rows = db
    .prepare(
      `SELECT w.*, d.id AS document_id, d.source AS doc_source,
              d.doc_type AS doc_type, d.filename AS doc_filename
         FROM body_metrics w
         LEFT JOIN medical_documents d
           ON w.source = '${DOCUMENT_SOURCE_PREFIX}' || d.id
          AND d.profile_id = w.profile_id
        WHERE w.profile_id = ? AND w.date <= ?
        ${BODY_METRICS_ORDER}
        LIMIT ? OFFSET ?`
    )
    .all(
      profileId,
      untilDate,
      size,
      pageOffset(clamped, size)
    ) as BodyMetricSourceRow[];
  return {
    rows: rows.map(withSourceLabel),
    total,
    page: clamped,
    pageSize: size,
  };
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

// The body-metrics rows recorded FOR one day. A different question from a page of
// history: the Body census asks it to decide whether a day's composition number is
// one physical reading (and may therefore print that reading's clock) or a blend of
// several, and that answer must not depend on which page of the table is open.
export function getBodyMetricsOnDate(
  profileId: number,
  date: string
): BodyMetricWithSource[] {
  // THE SAME LABELLED SHAPE THE PAGE READ RETURNS. Both are read by `/history` — the
  // day view asks this one — and a row that printed its raw `source` token here while
  // the page above printed the integration's name would be one surface disagreeing
  // with itself about the same row (#3958).
  return (
    db
      .prepare(
        `SELECT w.*, d.id AS document_id, d.source AS doc_source,
                d.doc_type AS doc_type, d.filename AS doc_filename
           FROM body_metrics w
           LEFT JOIN medical_documents d
             ON w.source = '${DOCUMENT_SOURCE_PREFIX}' || d.id
            AND d.profile_id = w.profile_id
          WHERE w.profile_id = ? AND w.date = ?
          ORDER BY w.id`
      )
      .all(profileId, date) as BodyMetricSourceRow[]
  ).map(withSourceLabel);
}

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

// Per-night MAIN-sleep stage totals (minutes), oldest→newest, pivoted from the four
// sleep_*_min metrics. Stage rows are stored as timestamped observations but carry
// no session id, so attribution is by overlap with the SAME mainSleepPeriod that
// owns the duration/bed/wake summary. A same-wake-day nap therefore stays out of
// the overnight stage chart instead of making its stack out-sum the duration point.
//
// Source/origin selection follows the sleep_min session read first, then stage rows
// must match that elected stream. This preserves issue #14's one-source-per-night
// contract while avoiding an independent stage-only election that could choose a
// different wearable from the session whose duration is shown.
//
// `limitDays` is a READ bound, not a post-slice (#2520): it is the SQL LIMIT on the
// stage-day scan, and the cutoff it yields bounds every other statement here. So a
// caller asking for 14 nights reads 14 nights' rows — Health Connect stores one row
// per stage per night, so the difference between the caller's window and this
// function's default is thousands of rows on a daily wearable user. The returned
// series can be SHORTER than `limitDays`: a stage day whose elected main session is
// missing contributes no row, and that is the honest answer for "the last N days
// that have stage data" rather than a silent look-back past the window.
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
      `SELECT date, metric, started_at AS start, ended_at AS end,
              source, origin, value
         FROM metric_samples
        WHERE profile_id = ? AND date >= ?
          AND metric IN ('sleep_deep_min','sleep_rem_min','sleep_light_min','sleep_awake_min')`
    )
    .all(profileId, cutoff) as {
    date: string;
    metric: string;
    start: string;
    end: string;
    source: string | null;
    origin: string | null;
    value: number;
  }[];

  // Elect the sleep_min source/origin with the SAME resolution the additive
  // duration chart uses. The SRI session read has a different, stream-wide fallback
  // (the newest source), so routing this chart through it could make the duration
  // point Health Connect while its stages came from Oura.
  //
  // Per overlapping WINDOW, not per day (#2552): a manual nap on the same wake-day
  // used to win the whole day, leaving `mainSleepPeriod` to elect that nap as the
  // night — and no stage row matches a manual session's source, so the night's
  // entire stage stack disappeared from the chart.
  const rawSessions = db
    .prepare(
      `SELECT date, started_at AS start, ended_at AS end, source, origin, value
         FROM metric_samples
        WHERE profile_id = ? AND metric = 'sleep_min' AND date >= ?
          AND julianday(ended_at) > julianday(started_at)`
    )
    .all(profileId, cutoff) as SelectedSleepSessionRow[];
  const sessions = pickRowsOneSourcePerWindow(
    pickRowsOneOriginPerSourceDay(
      rawSessions,
      (row) => row.date,
      (row) => row.source,
      (row) => row.origin,
      (row) => row.value
    ),
    resolutionFor(profileId, "sleep_min"),
    (row) => row.start,
    (row) => row.end,
    (row) => row.source,
    (row) => row.value
  );
  const sessionsByDay = new Map<string, SelectedSleepSessionRow[]>();
  for (const session of sessions) {
    const day = sessionsByDay.get(session.date);
    if (day) day.push(session);
    else sessionsByDay.set(session.date, [session]);
  }
  // Bucket the stage rows by date ONCE. The attribution below is per day, and
  // rescanning the whole array inside that loop made the cost days × rows — a few
  // thousand stage rows over a half-year window is ~10^6 iterations to answer about
  // a handful of nights (#2520). The attribution itself is unchanged; only its
  // access pattern was quadratic.
  const rowsByDay = new Map<string, typeof rows>();
  for (const row of rows) {
    const day = rowsByDay.get(row.date);
    if (day) day.push(row);
    else rowsByDay.set(row.date, [row]);
  }

  const out: {
    date: string;
    deep: number;
    rem: number;
    light: number;
    awake: number;
  }[] = [];
  for (const [date, daySessions] of sessionsByDay) {
    const period = mainSleepPeriod(daySessions);
    if (!period) continue;
    const windows = period.members.map((member) => ({
      start: new Date(member.start).getTime(),
      end: new Date(member.end).getTime(),
    }));
    const totals = { deep: 0, rem: 0, light: 0, awake: 0 };
    let found = false;
    for (const row of rowsByDay.get(date) ?? []) {
      if (row.source !== period.main.source) continue;
      if (row.origin !== period.main.origin) continue;
      // Fitbit Takeout aggregate-stage rows append `#deep` / `#rem` / ... to
      // the session start as part of their natural storage key. The prefix is
      // still the real session boundary used for overlap attribution.
      const keySuffix = row.start.indexOf("#");
      const stageStart =
        keySuffix < 0 ? row.start : row.start.slice(0, keySuffix);
      const start = new Date(stageStart).getTime();
      const end = new Date(row.end).getTime();
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start)
        continue;
      if (!windows.some((window) => end > window.start && start < window.end))
        continue;
      const key = row.metric.slice("sleep_".length, -"_min".length) as
        "deep" | "rem" | "light" | "awake";
      totals[key] += row.value;
      found = true;
    }
    if (!found) continue;
    // Round ONCE, after the chosen main session's rows have been summed. Health
    // Connect stores sub-minute stage observations, so per-row rounding would
    // accumulate error across a night full of 30-second micro-arousals.
    out.push({
      date,
      deep: Math.round(totals.deep),
      rem: Math.round(totals.rem),
      light: Math.round(totals.light),
      awake: Math.round(totals.awake),
    });
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : 1)).slice(-limitDays);
}

// Raw per-night sleep sessions (metric 'sleep_min') as absolute time windows,
// newest→oldest, capped at `limit` rows — the input to the Sleep Regularity Index
// (#160), which needs each session's start/end INSTANTS (not the derived per-day
// totals) to reconstruct the sleep/wake timeline in the profile timezone.
//
// SOURCE HANDLING IS PER NIGHT (#1851), and this memo used to say the opposite.
//
// It read: the SRI math assumes ONE session stream, so when several sources have
// sessions the profile's primary source wins and everything else is filtered out,
// falling back to the most-recently-synced stream (#14, reprobed by #2603). That
// rule answered the wrong question the moment a person could type a night the
// wearable missed. A stream-wide election has only two moves — keep the device and
// throw the typed nights away, or keep the typed nights and throw a wearable's whole
// history away — and it made the second one: ONE hand-typed window elected `manual`
// for the profile and returned 1 session where 30 Oura overnights had been, taking
// the SRI to null. The ring's own sync for that same night did not win it back,
// because a person types when they got up while a ring records sleep offset.
//
// So the bucket is the NIGHT. Rows are resolved by `pickRowsOneSourcePerWindow` —
// the same election, over the same profile resolution, that `getDailySleepSessionsSince`
// has used for date-keyed display history since #2552 — and the two reads now
// differ only in their bounding, which is the difference that was ever real.
//
// WHAT THAT COSTS AND WHY IT IS AFFORDABLE. The stream rule existed to stop two
// sources reporting the SAME nights from interleaving duplicate windows into one
// timeline; that hazard is real and it is exactly what an overlap cluster catches,
// because a duplicate account of one night covers the same clock time. What the day
// grain could not tell apart, and the window grain can, is a duplicate from a second
// EVENT: a wearable's overnight plus a hand-logged nap are two things that happened.
// A typed night the device never recorded overlaps nothing, so it fills its own gap
// and displaces nobody — which is the whole of what this change buys.
//
// IT ALSO RETIRES THE #2603 PROBE rather than working around it. That probe existed
// because a nap synced by a phone was the newest session most afternoons and elected
// the phone for the entire profile, blanking a ring's history. Under a per-night
// election the nap is its own cluster: it never reaches the ring's nights, so there
// is nothing for a recency heuristic to get wrong. Recency as a profile-wide rule is
// gone with it — a new wearable takes over the nights it actually records, on the
// nights it records them, which is what "taking over" meant.
//
// WHAT WOULD SHOW IT WORKING: a profile with 30 device overnights and one typed
// night the device missed returns 31 sessions, the device's 30 unchanged. WHAT WOULD
// SHOW IT WRONG: two sources reporting the SAME night both surviving into the list,
// which is the interleave #14 forbids and the reason the resolution is per window
// rather than per row. THE DECEPTIVE SUCCESS is unchanged from #2603 — "sessions
// returned per read went up" also goes up when duplicates interleave — so the honest
// measure is still each source's own night count.
//
// A STRICT choice (#1642) still applies unconditionally, now per night: a night the
// chosen selector did not cover keeps no rows at all, rather than being answered by
// whoever did record it. `pickRowsOneSourcePerWindow` is where that holds.
export interface SleepSessionRow {
  date: string;
  start: string;
  end: string;
  value: number;
  source: string | null;
}

interface SelectedSleepSessionRow extends SleepSessionRow {
  origin: string | null;
}

// A sleep sample is an OVERNIGHT rather than a nap at/above this duration. The
// provenance ledger carries no session label, so the sample is bounded by duration
// instead: a three-hour window is short for a night and long for a nap.
//
// TWO askers, one number, because it is one question. The arrival statistic (#2214)
// asks it to keep a nap's sync latency out of "when does last night normally land?";
// the stream election above asks it to keep a nap from electing a whole source
// (#2603). Migration 166 froze its own COPY of this floor under the constant's former
// name — a shipped migration must keep converting as it did on the day it ran, so
// retuning this number deliberately does not reach back into it.
const SLEEP_OVERNIGHT_MIN_MINUTES = 180;

function readSleepSessions(
  profileId: number,
  opts: { limit?: number; since?: string; through?: string }
): SleepSessionRow[] {
  const validWindow = " AND julianday(ended_at) > julianday(started_at)";
  let cutoff = opts.since;
  if (cutoff == null) {
    // Bound the read by recent wake dates before origin and source selection.
    // Applying LIMIT to raw rows would let duplicate origins consume the cap and
    // drop valid older nights; the final slice happens only after one origin and
    // one source remain per night.
    const recentDates = db
      .prepare(
        `SELECT date FROM metric_samples
          WHERE profile_id = ? AND metric = 'sleep_min'
            ${validWindow}
          GROUP BY date ORDER BY date DESC LIMIT ?`
      )
      .all(profileId, opts.limit ?? 800) as { date: string }[];
    if (recentDates.length === 0) return [];
    cutoff = recentDates[recentDates.length - 1].date;
  }

  const rowParams: (number | string)[] = [profileId, cutoff];
  const throughFilter = opts.through ? " AND date <= ?" : "";
  if (opts.through) rowParams.push(opts.through);
  const rows = db
    .prepare(
      `SELECT date, started_at AS start, ended_at AS end, source, origin, value
       FROM metric_samples
        WHERE profile_id = ? AND metric = 'sleep_min'
          ${validWindow}
          AND date >= ?
          ${throughFilter}
        ORDER BY ended_at DESC`
    )
    .all(...rowParams) as {
    date: string;
    start: string;
    end: string;
    source: string | null;
    origin: string | null;
    value: number;
  }[];
  const picked = pickRowsOneSourcePerWindow(
    pickRowsOneOriginPerSourceDay(
      rows,
      (r) => r.date,
      (r) => r.source,
      (r) => r.origin,
      (r) => r.value
    ),
    resolutionFor(profileId, "sleep_min"),
    (r) => r.start,
    (r) => r.end,
    (r) => r.source,
    (r) => r.value
  );
  const limited =
    opts.limit == null ? picked : picked.slice(0, Math.max(0, opts.limit));
  return limited.map(({ date, start, end, value, source }) => ({
    date,
    start,
    end,
    value,
    source,
  }));
}

// The profile's recent session windows, row-capped. THE sleep-session read: the SRI,
// the consistency strip, the typical wake time, the digest's Sleep section and the
// digest's own send decision all start here.
//
// MEMOIZED ON BOTH LIFETIMES (#2283). This is a two-statement read — the
// recent-wake-day window, then every session row in it — followed by per-source/day
// origin selection and per-night source resolution, both in JS. The DISTINCT source
// scan that used to open it went with the profile-wide election (#1851), and the memo
// is worth no less without it: the two statements left are the expensive pair, and ONE
// digest tick still asks for them TWICE for the same profile:
// `digestSleepPendingTrace` asks "has last night landed?" to reach the decision, and
// `gatherDigestSleep` asks again to build the section that decision sends.
// `cache()` is identity in a tick (lib/request-cache.ts says so deliberately), so the
// collapse that matters here is `tickCached`; the `cache()` beside it collapses
// the Sleep page's own repeated reads (the SRI, the consistency strip and the wake-time
// derivation each start from this list) into one per request.
//
// Nothing inside a tick writes these rows AFTER the first read: `syncIntegrations` is
// the first statement of `tickProfile`, so the pull pass has finished writing
// `metric_samples` before anything in the scope reads them, and every other writer of
// that table (lib/reading-writes.ts, lib/offline/writes.ts, lib/ttc-store.ts,
// lib/bulk-correction-db.ts) is reached from a Server Action or a route handler — the
// web request or the sidecar's separate `poll` mode, never from inside the scope. The
// scope closes with the profile — see lib/tick-cache.ts for the rule this depends on.
//
// The returned array is treated as read-only by every caller (the pure sleep cores
// copy before sorting), which is what makes one array safe to hand to all of them.
export const getSleepSessions = cache(
  tickCached(
    "getSleepSessions",
    (profileId: number, limit = 800) => `${profileId}:${limit}`,
    getSleepSessionsUncached
  )
);

function getSleepSessionsUncached(
  profileId: number,
  limit = 800
): SleepSessionRow[] {
  return readSleepSessions(profileId, { limit });
}

// All valid session windows on or after a calendar cutoff. Unlike the row-capped
// SRI reader, this cannot lose older wake-days when one day contains several naps.
export function getSleepSessionsSince(
  profileId: number,
  since: string
): SleepSessionRow[] {
  return readSleepSessions(profileId, { since });
}

// Valid sleep windows on or after a calendar cutoff, for the Sleep log's date-keyed
// display history.
//
// IT IS NOW THE SAME READ as getSleepSessionsSince, and the duplicate SQL and
// election this carried have gone (#1851). It existed because the two answered
// different questions: display history resolved PER OVERLAPPING WINDOW (#2552) so a
// hand-logged nap could not take a wearable's overnight down with it, while the SRI
// reader elected one stream for the whole profile. The owner's per-night ruling made
// that second rule the first one, so keeping two spellings of one election is how
// they drift apart again. The name stays because the Sleep log's call site means
// "the days", not "the stream".
export function getDailySleepSessionsSince(
  profileId: number,
  since: string
): SleepSessionRow[] {
  return readSleepSessions(profileId, { since });
}

// Every valid sleep session whose stored wake-day is inside the selected calendar
// range. This is intentionally date-bounded rather than row-capped: a historical
// Trends window must not disappear merely because newer nights consumed the
// regular SRI reader's 800-row safety cap.
export function getSleepSessionsInRange(
  profileId: number,
  from?: string,
  to?: string
): SleepSessionRow[] {
  return readSleepSessions(profileId, {
    since: from ?? "0000-01-01",
    through: to,
  });
}

// WHEN each recent night's row actually landed — the GATHER behind the arrival
// statistic (#2214). The decision itself is `arrivalStatistics`
// (lib/notifications/digest-schedule.ts); this side reads rows and converts
// timestamps, and takes no percentile of its own.
//
// THREE CONVENTIONS CROSSED IN ONE READ, all through shared helpers (#2205):
//   • `ms.ended_at` is a canonical instant carrying `Z`;
//   • `r.created_at` was moved onto the same canonical instant by migration 163,
//     so `MIN(...)` over it is a chronological minimum rather than a lexical
//     accident, and both sides parse through `parseUtcSql`;
//   • the ARRIVAL MINUTE is profile-local, resolved through `zonedDateParts` — the
//     one place an absolute instant becomes a local day and wall clock (#94).
// No offset is hand-rolled here, and no instant is hand-built.
//
// `MIN(created_at)` per sample is the FIRST time the row appeared: a later re-sync
// updates the same row and must not be mistaken for a slower arrival.
//
// Rows with no provenance are silently absent, which is the correct answer — a
// manually logged night has no arrival to measure, and the statistic's sample gate
// turns "too few measurable nights" into a stated no-answer rather than a guess.
//
// MEMOIZED ON BOTH LIFETIMES (#2249). This is a 30-night join over
// `metric_samples × integration_sync_rows` with a `MIN(created_at)` group-by, and a
// DYNAMIC digest tick asks it TWICE for the same profile: once through
// `digestDeadline` for the deadline, and again in `logDigestTick`, which quotes the
// same statistic in its evidence line (#2209/#2220) — same gather, same tick, same
// profile, on every re-check tick. `cache()` is identity in
// a tick (lib/request-cache.ts says so deliberately), so the collapse that matters
// here is `tickCached`; the `cache()` beside it is what collapses the Settings page's
// own two reads (the Dynamic caption's `arrivalStats` and the #2217 suggestion's
// resolver) into one per request.
//
// Nothing inside a tick writes these rows AFTER the first read: `syncIntegrations` is
// the first statement of `tickProfile`, so the pull pass has finished writing
// `metric_samples` and `integration_sync_rows` before anything in the scope reads
// them, and no later tick step writes either table. The scope closes with the profile
// — see lib/tick-cache.ts for the rule this depends on.
export const getSleepArrivals = cache(
  tickCached(
    "getSleepArrivals",
    (profileId: number, limitNights = 30) => `${profileId}:${limitNights}`,
    getSleepArrivalsUncached
  )
);

function getSleepArrivalsUncached(
  profileId: number,
  limitNights = 30
): ArrivalNight[] {
  const tz = getTimezone(profileId);
  const rows = db
    .prepare(
      `SELECT ms.ended_at AS endTime, MIN(r.created_at) AS arrivedAt
         FROM metric_samples ms
         JOIN integration_sync_rows r
           ON r.target_table = 'metric_samples' AND r.target_id = ms.id
        WHERE ms.profile_id = ?
          AND ms.metric = 'sleep_min'
          AND ms.started_at IS NOT NULL
          AND ms.ended_at IS NOT NULL
          AND julianday(ms.ended_at) > julianday(ms.started_at)
          AND ms.value >= ?
        GROUP BY ms.id
        ORDER BY ms.date DESC
        LIMIT ?`
    )
    .all(profileId, SLEEP_OVERNIGHT_MIN_MINUTES, limitNights) as {
    endTime: string | null;
    arrivedAt: string | null;
  }[];
  return rows.flatMap((r) => {
    const ended = parseUtcSql(r.endTime);
    const arrived = parseUtcSql(r.arrivedAt);
    if (!ended || !arrived) return [];
    const { date, hhmm } = zonedDateParts(tz, arrived);
    return [
      {
        date,
        arrivalMinute: hhmmToMinutes(hhmm),
        lagMin: Math.round((arrived.getTime() - ended.getTime()) / 60000),
        dstTransition: isDstTransitionDay(tz, date),
      },
    ];
  });
}

// The profile's OWN manual sleep entries — the rows the Sleep log's inline editor
// may update. Imported and synced sessions remain read-only.
//
// PROVENANCE IS THE TEST, not the natural key (#1851). This used to additionally
// require the row's exact midnight start/end, which was the same question only while
// every windowed row was somebody else's: the moment the measurements form could
// state a bed/wake pair, a night the person typed themselves answered "Synced sleep
// entries cannot be edited here." A window is not what makes a row untouchable.
interface ManualSleepEditabilityRow {
  date: string;
  /** The manual sample's own row id — what a per-reading delete has to name (#2556). */
  id: number | null;
  value: number | null;
  editable: number;
}

function getManualSleepEditability(
  profileId: number,
  since: string,
  through: string
): ManualSleepEditabilityRow[] {
  return db
    .prepare(
      `SELECT date,
              MAX(CASE WHEN source = 'manual' AND origin IS NULL
                       THEN value END) AS value,
              -- Safe as a MAX: the editable flag below only holds when the day
              -- has EXACTLY ONE sample and that one is the profile's own manual
              -- row, so there is never a second id for this to pick between.
              MAX(CASE WHEN source = 'manual' AND origin IS NULL
                       THEN id END) AS id,
              CASE WHEN COUNT(*) = 1
                         AND SUM(CASE WHEN source = 'manual' AND origin IS NULL
                                      THEN 1 ELSE 0 END) = 1
                   THEN 1 ELSE 0 END AS editable
         FROM metric_samples
        WHERE profile_id = ? AND metric = 'sleep_min'
          AND date >= ? AND date <= ?
        GROUP BY date ORDER BY date`
    )
    .all(profileId, since, through) as ManualSleepEditabilityRow[];
}

export function getEditableManualSleepDurations(
  profileId: number,
  since: string,
  through = "9999-12-31"
): { id: number | null; date: string; value: number }[] {
  return getManualSleepEditability(profileId, since, through).flatMap((row) =>
    row.editable === 1 && row.value != null
      ? [{ id: row.id, date: row.date, value: row.value }]
      : []
  );
}

// Re-check the Sleep log's edit invariant at the write boundary. A missing day
// may receive a duration-only manual row; an existing day is editable only when
// its sole sleep sample is the profile's OWN manual row (#1851 widened that from
// the exact midnight key — see above). `upsertManualSleep` keeps an existing window
// when a duration-only correction lands on it, so editing the hours here does not
// discard the clocks either, unless the new hours no longer fit inside them.
// Reading this inside the caller's IMMEDIATE transaction closes the render→save
// race with an integration sync and prevents a crafted action request from
// layering manual sleep over imported or windowed data.
export function canEditManualSleepOnDate(
  profileId: number,
  date: string
): boolean {
  const row = getManualSleepEditability(profileId, date, date)[0];
  return row == null || row.editable === 1;
}

// ---- hr_minutes: profile-local days over a UTC instant column (#2205) --------
//
// `hr_minutes.ts` is an absolute instant since migration 164; every reader below asks
// a profile-LOCAL day question. The translation is lib/local-day-window.ts, and it is
// used two ways:
//
//   • a day (or span of days) becomes a half-open UTC RANGE, which the primary key's
//     own index on (profile_id, ts, source) serves as a plain range scan — this is
//     why 164 dropped idx_hr_minutes_day rather than replacing it;
//   • a GROUP BY day stays in SQL as `date(ts, '±HH:MM')`, run once per offset-constant
//     SEGMENT of the window, so DST is exact and the row work never leaves SQLite
//     (the #387 bound).
//
// A day that CONTAINS a DST transition is the only one that appears in two segments;
// `mergeHrDayRows` folds those halves back into one row with a count-weighted average.

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

// Daily HR summary derived from the 1-minute buckets, oldest→newest. Since the
// hr_minutes key gained `source` (migration 013, issue #14) two sources can carry
// the same minutes, so each day keeps ONE source's buckets — the 'heart_rate'
// primary source when set, else the default preference, else the source with the
// most minutes that day — instead of blending overlapping streams.
export function getHrDailySummary(
  profileId: number,
  limitDays = 180
): { date: string; avg: number; min: number; max: number; partial?: true }[] {
  // Bound the GROUP BY to the limitDays most-recent days-with-data (issue #387).
  // The JS slice below still picks one source per day over exactly this window.
  const cutoff = recentHrCutoff(profileId, limitDays);
  if (cutoff === null) return [];
  const zone = profileDayZone(profileId);
  const bounds = hrInstantBounds(profileId);
  if (!bounds) return [];
  const lastDay = localDayOf(zone, bounds.last);
  if (!lastDay) return [];
  const { startUtc, endUtc } = localDaySpan(zone, cutoff, lastDay);
  const rows = hrDayAggregates(profileId, zone, startUtc, endUtc);
  const picked = pickRowsOneSourcePerDay(
    rows,
    resolutionFor(profileId, "heart_rate"),
    (r) => r.date,
    (r) => r.source,
    (r) => r.n
  ).sort((a, b) => (a.date < b.date ? -1 : 1));
  // Match SQLite LIMIT semantics used by the other Trends queries: a negative
  // limit is the ALL_ROWS sentinel, not Array.slice(1).
  return markPartialToday(
    profileId,
    (limitDays < 0 ? picked : picked.slice(-limitDays)).map(
      ({ date, avg, min, max }) => ({ date, avg, min, max })
    )
  );
}

// Daily HR summary inside an explicit calendar window. Unlike the recent-days
// reader above, this bounds the high-volume GROUP BY by the dates the caller is
// actually rendering. A historical custom range therefore does not need to read
// every newer day first, and the ordinary 90-day Trends view never aggregates a
// profile's lifetime hr_minutes table. No bounds deliberately means all time.
export function getHrDailySummaryInRange(
  profileId: number,
  from?: string,
  to?: string
): { date: string; avg: number; min: number; max: number; partial?: true }[] {
  if (!from && !to) return getHrDailySummary(profileId, -1);

  // One window whichever end is open: an absent bound is resolved to the profile's
  // own first/last day-with-data, so the UTC range is always concrete and the
  // aggregate is always the same shape.
  const zone = profileDayZone(profileId);
  const bounds = hrInstantBounds(profileId);
  if (!bounds) return [];
  const fromDay = from ?? localDayOf(zone, bounds.first);
  const toDay = to ?? localDayOf(zone, bounds.last);
  if (!fromDay || !toDay || fromDay > toDay) return [];
  const { startUtc, endUtc } = localDaySpan(zone, fromDay, toDay);
  const rows = hrDayAggregates(profileId, zone, startUtc, endUtc);

  return markPartialToday(
    profileId,
    pickRowsOneSourcePerDay(
      rows,
      resolutionFor(profileId, "heart_rate"),
      (row) => row.date,
      (row) => row.source,
      (row) => row.n
    )
      .sort((left, right) => (left.date < right.date ? -1 : 1))
      .map(({ date, avg, min, max }) => ({ date, avg, min, max }))
  );
}

// The most recent day that has any HR buckets, or null.
export function getLatestHrDay(profileId: number): string | null {
  const row = db
    .prepare(
      "SELECT ts FROM hr_minutes WHERE profile_id = ? ORDER BY ts DESC LIMIT 1"
    )
    .get(profileId) as { ts: string } | undefined;
  return row ? localDayOf(getTimezone(profileId), row.ts) : null;
}

// A single day's 1-minute HR buckets, ordered by time. One source per day
// (issue #14) — same pick as getHrDailySummary — so an intraday chart never
// zig-zags between two devices' overlapping minutes.
export function getHrMinutes(profileId: number, date: string): HrMinute[] {
  // The local day as a half-open UTC range — 23, 24 or 25 hours wide depending on
  // DST, which is precisely what a `substr` day could not express.
  const tz = getTimezone(profileId);
  const { startUtc, endUtc } = localDayRange(tz, date);
  const rows = db
    .prepare(
      `SELECT * FROM hr_minutes
        WHERE profile_id = ? AND ts >= ? AND ts < ?
        ORDER BY ts`
    )
    .all(profileId, startUtc, endUtc) as HrMinute[];
  // PROJECT to the profile-local minute on the way out (#2205). The column stores an
  // absolute instant; every consumer of this shape — the intraday chart, the
  // training-zone windows, the ride series — compares it against activity times that
  // are profile-local wall clocks. Storage is UTC, presentation is local, and the
  // conversion happens HERE, once, instead of each surface guessing.
  const toLocalMinute = localMinuteProjector(tz, startUtc, endUtc);
  const local = rows.map((r) => ({ ...r, ts: toLocalMinute(r.ts) ?? r.ts }));
  return pickRowsOneSourcePerDay(
    local,
    resolutionFor(profileId, "heart_rate"),
    () => date,
    (r) => r.source
  );
}

// Per-minute HR buckets (ts + bpm) within an inclusive [since, until] date range, one
// source per day — the shared read behind the training-zone aggregations
// (lib/queries/zones.ts), so zone minutes can't double-count a workout recorded by two
// HR sources at once (issue #14). Both bounds are profile-local days.
//
// `until` IS REQUIRED (#5069). It used to default to the day of the profile's LAST
// STORED instant, which reads as "to now" only while the last row is roughly now — a
// coincidence, not a bound. A device stamping ahead (#5035) widened this scan with
// nothing saying so: #5069 records a snapshot whose rows ran into the future, where the
// zone reads materialised 144,000 minutes and kept 86. Every caller already knew the
// window it meant, so the open-ended form is DELETED rather than guarded — the
// parameter is the bound, and a caller that forgets one no longer compiles.
//
// REQUEST-CACHED because a dashboard asks for the SAME window more than once (#5010):
// `getDayLoadInputs` and `getIntensitySignal` read the same 42 days on one render, and
// each read is a wide materialisation. `cache()` is identity outside a Next request
// (lib/request-cache.ts says so deliberately), so a notify tick and the DB tier behave
// exactly as before. Keyed on the arguments, so two spellings of one span would stay
// separate reads — with `until` required, the trailing window has one spelling.
export const getHrMinutesInRange = cache(function getHrMinutesInRange(
  profileId: number,
  since: string,
  until: string
): { ts: string; bpm: number }[] {
  const tz = getTimezone(profileId);
  if (!hrInstantBounds(profileId)) return [];
  if (until < since) return [];
  const { startUtc, endUtc } = localDaySpan(tz, since, until);
  const rows = db
    .prepare(
      `SELECT ts, bpm, source FROM hr_minutes
        WHERE profile_id = ? AND ts >= ? AND ts < ?`
    )
    .all(profileId, startUtc, endUtc) as {
    ts: string;
    bpm: number;
    source: string | null;
  }[];
  // Projected to the profile-local minute before anything groups or compares it —
  // same boundary rule as getHrMinutes above. Once projected, the day is the stamp's
  // own prefix again and the training-zone windows line up as they always did.
  //
  // Through the window's OFFSET SEGMENTS rather than through `Intl` per row (#5010).
  // The zone's offset is constant inside a segment, so the local minute is the stored
  // instant plus that constant; the segments cost ~90 `Intl` probes for a 90-day
  // window against the 125,000 `formatToParts` calls this line used to make. Identical
  // output, including on the transition instant itself — pinned minute by minute
  // against `zonedMinuteStr` in lib/__tests__/local-day-window.test.ts.
  const toLocalMinute = localMinuteProjector(tz, startUtc, endUtc);
  const local = rows.map((r) => ({ ...r, ts: toLocalMinute(r.ts) ?? r.ts }));
  return pickRowsOneSourcePerDay(
    local,
    resolutionFor(profileId, "heart_rate"),
    (r) => r.ts.slice(0, 10),
    (r) => r.source
  ).map(({ ts, bpm }) => ({ ts, bpm }));
});

// THE SAME WINDOW AND THE SAME ONE-SOURCE-PER-DAY PICK, ANSWERED IN INSTANTS (#5212
// falsifying pass, F3). The projection above is the right answer for everything that
// groups or renders BY DAY — but it is lossy, and exactly once a year it loses the
// thing a duration reader needs. In a fall-back hour two stored instants project to
// the SAME local minute, so a caller that resolves the local string back through the
// zone gets the first of the two for both: an hour of a person's readings collapses
// onto the hour before it, the newest measured minute moves an hour into the past, and
// a quiet stretch appears where there was effort.
//
// A caller measuring real elapsed spans therefore reads the stored instant, which
// `hr_minutes.ts` has been since #2205. The local day is still what decides which
// source wins a day (#14), so the projection is still computed — it is used for
// GROUPING and thrown away, rather than returned as if it were the fact.
export const getHrInstantsInRange = cache(function getHrInstantsInRange(
  profileId: number,
  since: string,
  until: string
): { at: number; bpm: number }[] {
  const tz = getTimezone(profileId);
  if (!hrInstantBounds(profileId)) return [];
  if (until < since) return [];
  const { startUtc, endUtc } = localDaySpan(tz, since, until);
  const rows = db
    .prepare(
      `SELECT ts, bpm, source FROM hr_minutes
        WHERE profile_id = ? AND ts >= ? AND ts < ?
        ORDER BY ts ASC`
    )
    .all(profileId, startUtc, endUtc) as {
    ts: string;
    bpm: number;
    source: string | null;
  }[];
  const toLocalMinute = localMinuteProjector(tz, startUtc, endUtc);
  return (
    pickRowsOneSourcePerDay(
      rows,
      resolutionFor(profileId, "heart_rate"),
      (r) => (toLocalMinute(r.ts) ?? r.ts).slice(0, 10),
      (r) => r.source
    )
      // `parseUtcSql`, NEVER `Date.parse` (#5338, found by the fourth falsifying pass on
      // #5212). `hr_minutes.ts` is a stored stamp and a zoneless date-TIME string is
      // SERVER-LOCAL by specification, so `Date.parse` reads it through whatever `TZ` the
      // host has — every db fixture in the repo, migration 164's unconverted rows and any
      // `seedTimezoneFromEnv` self-host emit one without a `Z`. Under
      // `TZ=America/New_York` that moved a whole trace by the offset and stamped a
      // completed workout onto a window with no heart rate in it, which is a WRITE and
      // reaches the safety-tier post-workout dispatch. The projection above is thrown away
      // precisely so this line reads the stored instant; parsing it in the host's zone
      // gives back the loss that seam exists to prevent.
      .map(({ ts, bpm }) => ({ at: parseUtcSql(ts)?.getTime() ?? NaN, bpm }))
      .filter((r) => Number.isFinite(r.at))
      .sort((left, right) => left.at - right.at)
  );
});

function bodyMetricColumn(metric: BodyMetricKind): string {
  return metric === "weight"
    ? "weight_kg"
    : metric === "body_fat"
      ? "body_fat_pct"
      : "resting_hr";
}

// The most recent (non-null) recorded value for a body metric with its measured
// date, or null. The passport shows the date next to each body stat.
// A configured primary source for the metric (issue #14) wins when it has any
// reading; otherwise (or when that source has none) the newest reading of any
// source is returned, as before. With the 'documents' class (#1640) this is
// "the newest scan, whichever report it came from". A STRICT choice (#1642)
// keeps the honest empty state instead of falling back to another source.
//
// REQUEST-CACHED (#3369 item 2): three of the profile's body stats are asked for by
// the passport, the weight-band dosing context and the dashboard's own summary within
// one render, each unaware of the others, and a `chosen` primary source makes it two
// statements rather than one. Keyed on (profileId, metric), so a household render
// still pays one read per profile per metric — the fan-out is real work and stays.
// NO WRITER CAN INTERVENE (lib/queries/AGENTS.md): the two actions that read this
// (a fitness entry's VO2 estimate, a measured goal's baseline) read it before their
// own insert and never again.
export const getLatestBodyMetricDated = cache(function getLatestBodyMetricDated(
  profileId: number,
  metric: BodyMetricKind
): { value: number; date: string } | null {
  const col = bodyMetricColumn(metric);
  const chosen = choiceFor(profileId, metric);
  if (chosen) {
    const cond = sourceMatchSql(chosen.source);
    const row = db
      .prepare(
        `SELECT ${col} AS value, date FROM body_metrics
          WHERE profile_id = ? AND ${col} IS NOT NULL AND ${cond.sql}
          ORDER BY date DESC, id DESC LIMIT 1`
      )
      .get(profileId, ...cond.params) as
      { value: number; date: string } | undefined;
    if (row) return row;
    if (chosen.strict) return null;
  }
  const row = db
    .prepare(
      `SELECT ${col} AS value, date FROM body_metrics WHERE profile_id = ? AND ${col} IS NOT NULL ORDER BY date DESC, id DESC LIMIT 1`
    )
    .get(profileId) as { value: number; date: string } | undefined;
  return row ?? null;
});

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
// source is exempt from the unique key) are averaged. A day another source ALSO
// reported carries `sources` — who won and what the others said (#2653 state 6).
function getBodyMetricDailySeriesUncached(
  profileId: number,
  metric: BodyMetricKind,
  limit = 365
): DailySourcePoint[] {
  const col = bodyMetricColumn(metric);
  const rows = db
    .prepare(
      `SELECT date, source, ${col} AS value FROM body_metrics
        WHERE profile_id = ? AND ${col} IS NOT NULL
        ORDER BY date DESC LIMIT ?`
    )
    .all(profileId, limit) as BodyMetricRow[];
  return foldDaysBySourceMean(rows, resolutionFor(profileId, metric));
}
export const getBodyMetricDailySeries = snapshotCached(
  "metrics.body-daily-series",
  (profileId: number, metric: BodyMetricKind, limit = 365) =>
    `${profileId}:${metric}:${limit}`,
  getBodyMetricDailySeriesUncached
);

// The raw shape both body-metric day reads hand to `foldDaysBySourceMean`, which
// keeps ONE source's reading per day (primary source first — #14), averages any
// remaining same-day rows from the kept source, and reports the sources the election
// set aside (#2653 state 6) rather than discarding them. The full-series read and the
// latest-two trend read (#1367) call the same fold, so the rollup cannot drift.
interface BodyMetricRow {
  date: string;
  source: string | null;
  value: number;
}

// The latest `dateLimit` DAILY points for a body metric, oldest→newest — the exact
// tail getBodyMetricDailySeries yields, but bounded to the most recent
// DATES-with-data so a caller computes its trend delta (#1367) or recovery baseline
// (#1615) without materializing years of synced resting-HR readings. Bounding by
// DISTINCT date (not a raw-row LIMIT) is what keeps this behavior-identical: a day
// with several same-day rows — two sources reporting one date is the normal #14
// shape — still collapses to ONE source-prioritized point through the shared fold,
// so these are the same points the full series would yield. Profile-scoped in both
// the date subquery and the outer select.
export function getLatestBodyMetricDailyPoints(
  profileId: number,
  metric: BodyMetricKind,
  dateLimit = 2
): DailySourcePoint[] {
  const col = bodyMetricColumn(metric);
  const rows = db
    .prepare(
      `SELECT date, source, ${col} AS value FROM body_metrics
        WHERE profile_id = ? AND ${col} IS NOT NULL
          AND date IN (
            SELECT date FROM body_metrics
             WHERE profile_id = ? AND ${col} IS NOT NULL
             GROUP BY date ORDER BY date DESC LIMIT ?
          )`
    )
    .all(profileId, profileId, dateLimit) as BodyMetricRow[];
  return foldDaysBySourceMean(rows, resolutionFor(profileId, metric));
}

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
  if (agg === "SUM") {
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
