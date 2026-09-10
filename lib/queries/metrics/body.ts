// BODY METRICS — one of the five submodules behind lib/queries/metrics.ts (issue
// #5171): the body_metrics rows and weight series, the provenance-labelled history
// page and one-day read, and the latest/dated body reads with the per-day
// source-elected series behind the weight / body-fat / resting-HR charts. Every read
// is profile-scoped.

import { db } from "../../db";
import { cache } from "../../request-cache";
import { snapshotCached } from "../../read-snapshot";
import { clampPage, pageCount, pageOffset } from "../../pagination";
import {
  foldDaysBySourceMean,
  pickRowsOneSourcePerDay,
  type DailySourcePoint,
} from "../../metric-sources";
import { DOCUMENT_SOURCE_PREFIX } from "../../body-metric-extract";
import { getIntegration } from "../../integrations/registry";
import type {
  BodyMetric,
  BodyMetricKind,
  BodyMetricWithSource,
  IntegrationId,
} from "../../types";
import {
  bodyMetricColumn,
  choiceFor,
  resolutionFor,
  sourceMatchSql,
} from "./common";

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
