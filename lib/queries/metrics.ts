import { db } from "../db";
import { cache } from "../request-cache";
import { tickCached } from "../tick-cache";
import {
  PROVIDER_PREFERENCE,
  pickOneProviderPerDay,
  pickRowsOneOriginPerSourceDay,
  pickRowsOneSourcePerDay,
  type SourceSelection,
} from "../metric-providers";
import {
  DOCUMENTS_SOURCE_CLASS,
  resolveMetricSources,
  sourceKey,
  sourceMatchesSelector,
  type MetricSourceChoice,
  type SourceResolution,
} from "../metric-source-priority";
import { getMetricSourcePriority, getTimezone } from "../settings";
import {
  localDayOf,
  localDayRange,
  localDaySpan,
  offsetSegments,
} from "../local-day-window";
import {
  hhmmToMinutes,
  isDstTransitionDay,
  parseUtcSql,
  zonedDateParts,
  zonedMinuteStr,
} from "../date";
import type { ArrivalNight } from "../notifications/digest-schedule";
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

// The profile's resolved source selection for a metric (issues #14/#1640/#1642):
// its explicit primary source or class first (when set), then the instance
// defaults — or, in strict mode, that one selector ALONE. Consumed by the
// one-source-per-day pickers so additive metrics never sum across sources; for a
// single-source profile this degrades to passthrough.
function resolutionFor(profileId: number, metric: string): SourceResolution {
  return resolveMetricSources(
    metric,
    getMetricSourcePriority(profileId),
    PROVIDER_PREFERENCE
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
//
// Strict mode (#1642) removes both fallbacks: only the chosen source's rows are
// read, and an empty result stays empty rather than reverting to all sources.
export function getMetricDailyTotals(
  profileId: number,
  metric: string,
  limitDays = 180
): { date: string; value: number }[] {
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
      `SELECT date, source, origin, SUM(value) AS value
         FROM metric_samples WHERE profile_id = ? AND metric = ? AND date >= ?
        GROUP BY date, source, origin`
    )
    .all(profileId, metric, cutoff) as {
    date: string;
    source: string | null;
    origin: string | null;
    value: number;
  }[];
  return (
    pickOneProviderPerDay(
      pickRowsOneOriginPerSourceDay(
        rows,
        (r) => r.date,
        (r) => r.source,
        (r) => r.origin,
        (r) => r.value
      ),
      resolveMetricSources(metric, priority, PROVIDER_PREFERENCE)
    )
      .sort((a, b) => (a.date < b.date ? 1 : -1))
      // ALL_ROWS is -1 ("no limit" — that is what SQLite's `LIMIT -1` means, and the
      // recentDates query above already reads it that way). Passing it straight to
      // slice meant `slice(0, -1)`, which drops the LAST element of a newest-first
      // array — i.e. every unbounded additive series silently lost its OLDEST day.
      // Found via #1541: the metric detail page reads its full series with ALL_ROWS,
      // so a 3-day steps history rendered as 2 readings.
      .slice(0, limitDays < 0 ? undefined : limitDays)
      .reverse()
  );
}

// The most recent value for a point metric (e.g. 'height_cm'), or null.
// The most recent metric_samples reading with its measured date (the end_time's
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
        `SELECT value, substr(end_time, 1, 10) AS date FROM metric_samples
          WHERE profile_id = ? AND metric = ? AND ${cond.sql}
          ORDER BY end_time DESC LIMIT 1`
      )
      .get(profileId, metric, ...cond.params) as
      { value: number; date: string } | undefined;
    if (row) return row;
    if (chosen.strict) return null;
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
      `SELECT date, source, origin,
              SUM(CASE WHEN metric = 'sleep_deep_min'  THEN value ELSE 0 END) AS deep,
              SUM(CASE WHEN metric = 'sleep_rem_min'   THEN value ELSE 0 END) AS rem,
              SUM(CASE WHEN metric = 'sleep_light_min' THEN value ELSE 0 END) AS light,
              SUM(CASE WHEN metric = 'sleep_awake_min' THEN value ELSE 0 END) AS awake
         FROM metric_samples
        WHERE profile_id = ? AND date >= ?
          AND metric IN ('sleep_deep_min','sleep_rem_min','sleep_light_min','sleep_awake_min')
        GROUP BY date, source, origin`
    )
    .all(profileId, cutoff) as {
    date: string;
    source: string | null;
    origin: string | null;
    deep: number;
    rem: number;
    light: number;
    awake: number;
  }[];
  const oneOrigin = pickRowsOneOriginPerSourceDay(
    rows,
    (r) => r.date,
    (r) => r.source,
    (r) => r.origin,
    (r) => r.deep + r.rem + r.light + r.awake
  );
  return (
    pickRowsOneSourcePerDay(
      oneOrigin,
      resolutionFor(profileId, "sleep_min"),
      (r) => r.date,
      (r) => r.source,
      (r) => r.deep + r.rem + r.light + r.awake
    )
      // Round ONCE, here, on the summed day total. Health Connect stores one row per
      // sleep stage at sub-minute precision (a night is dozens of rows, many of them
      // 30-second micro-arousals), so whole minutes have to be taken after the SUM —
      // rounding per stage at ingest made the breakdown out-sum its own session total
      // by ~14 min a night (the Fitbit-exporter payload audit). Oura/Withings report whole minutes per stage
      // already and are unaffected by rounding a value that is already integral.
      .map(({ date, deep, rem, light, awake }) => ({
        date,
        deep: Math.round(deep),
        rem: Math.round(rem),
        light: Math.round(light),
        awake: Math.round(awake),
      }))
      .sort((a, b) => (a.date < b.date ? -1 : 1))
      .slice(-limitDays)
  );
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
//
// A STRICT choice (#1642) applies its filter unconditionally — even to a
// single-source profile, whose lone stream is simply not the elected one — so an
// uncovered night is absent rather than answered by whoever did record it.
export interface SleepSessionRow {
  date: string;
  start: string;
  end: string;
  value: number;
  source: string | null;
}

function readSleepSessions(
  profileId: number,
  opts: { limit?: number; since?: string; through?: string }
): SleepSessionRow[] {
  const validWindow = " AND julianday(end_time) > julianday(start_time)";
  const sources = (
    db
      .prepare(
        `SELECT DISTINCT source FROM metric_samples
          WHERE profile_id = ? AND metric = 'sleep_min'${validWindow}`
      )
      .all(profileId) as { source: string | null }[]
  ).map((r) => r.source);
  const chosen = choiceFor(profileId, "sleep_min");
  let sourceFilter = "";
  let sourceParams: string[] = [];
  const applyFilter = (selector: string) => {
    const cond = sourceMatchSql(selector);
    sourceFilter = ` AND ${cond.sql}`;
    sourceParams = cond.params;
  };
  if (chosen?.strict) {
    applyFilter(chosen.source);
  } else if (sources.length > 1) {
    const picked =
      chosen != null &&
      sources.some((s) => sourceMatchesSelector(chosen.source, s))
        ? chosen.source
        : null;
    if (picked != null) applyFilter(picked);
    else {
      const newest = db
        .prepare(
          `SELECT source FROM metric_samples
            WHERE profile_id = ? AND metric = 'sleep_min'
              ${validWindow}
            ORDER BY end_time DESC LIMIT 1`
        )
        .get(profileId) as { source: string | null } | undefined;
      applyFilter(sourceKey(newest?.source));
    }
  }
  let cutoff = opts.since;
  if (cutoff == null) {
    // Bound the read by recent wake dates before origin selection. Applying LIMIT
    // to raw rows would let duplicate origins consume the cap and drop valid older
    // nights; the final slice happens only after one origin remains per source/day.
    const dateParams: (number | string)[] = [
      profileId,
      ...sourceParams,
      opts.limit ?? 800,
    ];
    const recentDates = db
      .prepare(
        `SELECT date FROM metric_samples
          WHERE profile_id = ? AND metric = 'sleep_min'${sourceFilter}
            ${validWindow}
          GROUP BY date ORDER BY date DESC LIMIT ?`
      )
      .all(...dateParams) as { date: string }[];
    if (recentDates.length === 0) return [];
    cutoff = recentDates[recentDates.length - 1].date;
  }

  const rowParams: (number | string)[] = [profileId, ...sourceParams, cutoff];
  const throughFilter = opts.through ? " AND date <= ?" : "";
  if (opts.through) rowParams.push(opts.through);
  const rows = db
    .prepare(
      `SELECT date, start_time AS start, end_time AS end, source, origin, value
       FROM metric_samples
        WHERE profile_id = ? AND metric = 'sleep_min'${sourceFilter}
          ${validWindow}
          AND date >= ?
          ${throughFilter}
        ORDER BY end_time DESC`
    )
    .all(...rowParams) as {
    date: string;
    start: string;
    end: string;
    source: string | null;
    origin: string | null;
    value: number;
  }[];
  const picked = pickRowsOneOriginPerSourceDay(
    rows,
    (r) => r.date,
    (r) => r.source,
    (r) => r.origin,
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
// MEMOIZED ON BOTH LIFETIMES (#2283). This is a three-statement read — the DISTINCT
// source scan, the recent-wake-day window, then every session row in it — followed by
// per-source/day origin selection in JS, and ONE digest tick asks it TWICE for the
// same profile: `digestSleepPendingTrace` asks "has last night landed?" to reach the
// decision, and `gatherDigestSleep` asks again to build the section that decision
// sends. `cache()` is identity in a tick (lib/request-cache.ts says so deliberately),
// so the collapse that matters here is `tickCached`; the `cache()` beside it collapses
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

// A night is an overnight (rather than a nap) for arrival purposes at this
// duration. The provenance ledger carries no session label, so the sample is
// bounded by duration instead: a three-hour window is short for a night and long
// for a nap, and an afternoon nap's sync latency is not the quantity being asked
// about ("when does last night normally land?").
const ARRIVAL_LAG_MIN_OVERNIGHT_MIN = 180;

// WHEN each recent night's row actually landed — the GATHER behind the arrival
// statistic (#2214). The decision itself is `arrivalStatistics`
// (lib/notifications/digest-schedule.ts); this side reads rows and converts
// timestamps, and takes no percentile of its own.
//
// THREE CONVENTIONS CROSSED IN ONE READ, all through shared helpers (#2205):
//   • `ms.end_time` is a canonical instant carrying `Z`;
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
      `SELECT ms.end_time AS endTime, MIN(r.created_at) AS arrivedAt
         FROM metric_samples ms
         JOIN integration_sync_rows r
           ON r.target_table = 'metric_samples' AND r.target_id = ms.id
        WHERE ms.profile_id = ?
          AND ms.metric = 'sleep_min'
          AND ms.start_time IS NOT NULL
          AND ms.end_time IS NOT NULL
          AND julianday(ms.end_time) > julianday(ms.start_time)
          AND ms.value >= ?
        GROUP BY ms.id
        ORDER BY ms.date DESC
        LIMIT ?`
    )
    .all(profileId, ARRIVAL_LAG_MIN_OVERNIGHT_MIN, limitNights) as {
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

// Duration-only manual sleep entries written by the measurements quick-add. Their equal
// start/end midnight timestamps are the stable natural key upsertManualSample
// uses, so these (and only these) are safe for the Sleep log's inline editor to
// update. Windowed/imported sessions remain read-only.
interface ManualSleepEditabilityRow {
  date: string;
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
                            AND start_time = date || 'T00:00:00'
                            AND end_time = date || 'T00:00:00'
                       THEN value END) AS value,
              CASE WHEN COUNT(*) = 1
                         AND SUM(CASE WHEN source = 'manual' AND origin IS NULL
                                           AND start_time = date || 'T00:00:00'
                                           AND end_time = date || 'T00:00:00'
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
): { date: string; value: number }[] {
  return getManualSleepEditability(profileId, since, through).flatMap((row) =>
    row.editable === 1 && row.value != null
      ? [{ date: row.date, value: row.value }]
      : []
  );
}

// Re-check the Sleep log's edit invariant at the write boundary. A missing day
// may receive a duration-only manual row; an existing day is editable only when
// its sole sleep sample is the exact natural key written by upsertManualSample.
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
  tz: string,
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
  for (const seg of offsetSegments(tz, startUtc, endUtc)) {
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

// A stored instant as the profile-local minute stamp ('YYYY-MM-DDTHH:MM') the pure
// consumers compare against. The read-time twin of what ingest used to STORE — which
// is the whole #94 correction: the projection is recomputed from the absolute instant
// on every read, so changing the profile timezone re-reads history correctly instead
// of silently re-meaning it. Falls back to the raw stamp if it will not parse, so a
// surprise row is visible rather than dropped.
function localMinuteStamp(tz: string, ts: string): string {
  const d = parseUtcSql(ts);
  return d ? zonedMinuteStr(tz, d) : ts;
}

// The profile's newest and oldest stored instants, or null when it has no HR at all.
// Two indexed seeks — the open-ended readers need real data bounds to build a window
// from, and scanning to find them would undo the point.
function hrInstantBounds(
  profileId: number
): { first: string; last: string } | null {
  const row = db
    .prepare(
      "SELECT MIN(ts) AS first, MAX(ts) AS last FROM hr_minutes WHERE profile_id = ?"
    )
    .get(profileId) as { first: string | null; last: string | null };
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
  const tz = getTimezone(profileId);
  let day = localDayOf(tz, bounds.last);
  if (!day) return null;
  if (limitDays < 0) return localDayOf(tz, bounds.first);
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
    const row = prev.get(profileId, localDayRange(tz, day).startUtc) as
      { ts: string } | undefined;
    if (!row) break;
    const earlier = localDayOf(tz, row.ts);
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
): { date: string; avg: number; min: number; max: number }[] {
  // Bound the GROUP BY to the limitDays most-recent days-with-data (issue #387).
  // The JS slice below still picks one source per day over exactly this window.
  const cutoff = recentHrCutoff(profileId, limitDays);
  if (cutoff === null) return [];
  const tz = getTimezone(profileId);
  const bounds = hrInstantBounds(profileId);
  if (!bounds) return [];
  const lastDay = localDayOf(tz, bounds.last);
  if (!lastDay) return [];
  const { startUtc, endUtc } = localDaySpan(tz, cutoff, lastDay);
  const rows = hrDayAggregates(profileId, tz, startUtc, endUtc);
  const picked = pickRowsOneSourcePerDay(
    rows,
    resolutionFor(profileId, "heart_rate"),
    (r) => r.date,
    (r) => r.source,
    (r) => r.n
  ).sort((a, b) => (a.date < b.date ? -1 : 1));
  // Match SQLite LIMIT semantics used by the other Trends queries: a negative
  // limit is the ALL_ROWS sentinel, not Array.slice(1).
  return (limitDays < 0 ? picked : picked.slice(-limitDays)).map(
    ({ date, avg, min, max }) => ({ date, avg, min, max })
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
): { date: string; avg: number; min: number; max: number }[] {
  if (!from && !to) return getHrDailySummary(profileId, -1);

  // One window whichever end is open: an absent bound is resolved to the profile's
  // own first/last day-with-data, so the UTC range is always concrete and the
  // aggregate is always the same shape.
  const tz = getTimezone(profileId);
  const bounds = hrInstantBounds(profileId);
  if (!bounds) return [];
  const fromDay = from ?? localDayOf(tz, bounds.first);
  const toDay = to ?? localDayOf(tz, bounds.last);
  if (!fromDay || !toDay || fromDay > toDay) return [];
  const { startUtc, endUtc } = localDaySpan(tz, fromDay, toDay);
  const rows = hrDayAggregates(profileId, tz, startUtc, endUtc);

  return pickRowsOneSourcePerDay(
    rows,
    resolutionFor(profileId, "heart_rate"),
    (row) => row.date,
    (row) => row.source,
    (row) => row.n
  )
    .sort((left, right) => (left.date < right.date ? -1 : 1))
    .map(({ date, avg, min, max }) => ({ date, avg, min, max }));
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
  const { startUtc, endUtc } = localDayRange(getTimezone(profileId), date);
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
  const tz = getTimezone(profileId);
  const local = rows.map((r) => ({ ...r, ts: localMinuteStamp(tz, r.ts) }));
  return pickRowsOneSourcePerDay(
    local,
    resolutionFor(profileId, "heart_rate"),
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
  const tz = getTimezone(profileId);
  const bounds = hrInstantBounds(profileId);
  if (!bounds) return [];
  const lastDay = until ?? localDayOf(tz, bounds.last);
  if (!lastDay || lastDay < since) return [];
  const { startUtc, endUtc } = localDaySpan(tz, since, lastDay);
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
  const local = rows.map((r) => ({ ...r, ts: localMinuteStamp(tz, r.ts) }));
  return pickRowsOneSourcePerDay(
    local,
    resolutionFor(profileId, "heart_rate"),
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

// The most recent (non-null) recorded value for a body metric with its measured
// date, or null. The passport shows the date next to each body stat.
// A configured primary source for the metric (issue #14) wins when it has any
// reading; otherwise (or when that source has none) the newest reading of any
// source is returned, as before. With the 'documents' class (#1640) this is
// "the newest scan, whichever report it came from". A STRICT choice (#1642)
// keeps the honest empty state instead of falling back to another source.
export function getLatestBodyMetricDated(
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
    .all(profileId, limit) as BodyMetricRow[];
  return foldBodyMetricDaily(rows, resolutionFor(profileId, metric));
}

interface BodyMetricRow {
  date: string;
  source: string | null;
  value: number;
}

// Collapse raw body_metrics rows to one value per day (oldest→newest): keep ONE
// source's reading per day (primary source first — #14), then average any remaining
// same-day rows from the kept source. Shared by the full-series read and the
// latest-two trend read (#1367) so both compute the daily rollup ONE way.
function foldBodyMetricDaily(
  rows: BodyMetricRow[],
  selection: SourceSelection
): { date: string; value: number }[] {
  const picked = pickRowsOneSourcePerDay(
    rows,
    selection,
    (r) => r.date,
    (r) => r.source
  );
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
): { date: string; value: number }[] {
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
  return foldBodyMetricDaily(rows, resolutionFor(profileId, metric));
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
