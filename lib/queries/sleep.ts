// Server-side assembly for the Sleep Regularity Index (#160). The math is the
// pure lib/sleep-regularity; this layer only gathers the profile-scoped inputs
// (raw sleep sessions + the profile timezone + travel situations) and hands them
// to that single computation, so the Trends surface and the weekly recap render
// the SAME numbers ("one question, one computation"). No `.prepare` here — the
// session read goes through the already profile-scoped getSleepSessions — so the
// scoping guard is unaffected.

import {
  getSleepSessions,
  getSleepSessionsInRange,
  getSleepSessionsSince,
  getSleepStageDailyTotals,
  getLatestMetricSample,
  getMetricDailyTotals,
  getMetricSeriesBySource,
  getEditableManualSleepDurations,
} from "./metrics";
import {
  OURA_SLEEP_SCORE_METRIC,
  OURA_READINESS_SCORE_METRIC,
} from "../integrations/oura";
import { getMoodLogs } from "./mood";
import { getActivityDates } from "./training/activities";
import {
  getSupplementDosesForHistory,
  getSupplements,
} from "./intake/schedule";
import { getIntakeLogsInRange } from "./intake/adherence";
import { db, today } from "../db";
import { now } from "../clock";
import {
  daysBetweenDateStr,
  hhmmToMinutes,
  shiftDateStr,
  zonedDateParts,
} from "../date";
import {
  getActiveSituations,
  getTimezone,
  getSituationEvents,
  getFreeDays,
} from "../settings";
import { doseExistsSince, indexTakenByDose } from "../supplement-adherence";
import { doseBucketOn, doseDueOn } from "../supplement-schedule";
import { situationHistoryResolver } from "../trend-annotations";
import {
  bedtimeDoseDisposition,
  summarizeBedtimeSupplements,
  type BedtimeSupplementSummary,
} from "../sleep-bedtime-supplements";
import {
  computeSleepRegularity,
  sriTrend,
  regularityTravelInsight,
  mainSleepNights,
  typicalBedTime as computeTypicalBedTime,
  typicalWakeTime as computeTypicalWakeTime,
  type SleepRegularity,
  type SleepRegularityOptions,
} from "../sleep-regularity";
import {
  isSleepTracking,
  sleepWaitingState,
  MIN_ARRIVAL_SAMPLES,
  TRACKING_LOOKBACK_NIGHTS,
  type SleepWaitingState,
} from "../sleep-waiting";
import { getIntegrationAttention, getLatestSyncEvent } from "./integrations";
import {
  isLastNight,
  lastNightSummary,
  latestDailySleepSummary,
  consistencyNights,
  buildSleepMoodHistory,
  attachEditableManualSleep,
  sleepMoodPoints,
  type LastNightSummary,
  type SleepStageMinutes,
  type ConsistencyNight,
  type SleepMoodHistoryRow,
  type SleepMoodPoint,
} from "../sleep-summary";

// The per-night MAIN overnight sleep duration (minutes), oldest→newest, one row
// per wake-day — the overnight session picked by mainSleepSession() (#1118), naps
// dropped. This is the deprivation series the poor-sleep rest trigger reads instead
// of the raw daily `sleep_min` total (which SUMS a same-day nap into the night on
// Health Connect and would mask a deficient overnight). Capped at `limitDays` most-
// recent nights. Delegates the profile-scoped read to getSleepSessions, so no new
// `.prepare` and the scoping guard is unaffected.
export function getMainSleepNightlyMinutes(
  profileId: number,
  limitDays = 180
): { date: string; value: number }[] {
  const nights = mainSleepNights(
    getSleepSessions(profileId),
    getTimezone(profileId)
  );
  return nights
    .slice(-limitDays)
    .map((n) => ({ date: n.wakeDay, value: n.durationMin }));
}

// Nightly MAIN-sleep duration for charts, with duration-only manual rows folded
// in on dates where no usable session window exists. Imported wake-days keep the
// classifier's main session so a same-day nap never inflates the overnight line.
export function getSleepDurationTrend(
  profileId: number,
  limitDays = 90
): { date: string; value: number }[] {
  const mainByDay = new Map(
    getMainSleepNightlyMinutes(profileId, limitDays).map((r) => [
      r.date,
      r.value,
    ])
  );
  return getMetricDailyTotals(profileId, "sleep_min", limitDays).map((r) => ({
    date: r.date,
    value: mainByDay.get(r.date) ?? r.value,
  }));
}

// The profile's typical wake time as a clock minute-of-day (0..1439, profile
// timezone), or null below the minimum-nights gate (issue #1117). Delegates the
// profile-scoped read to getSleepSessions and the math to the pure
// typicalWakeTime, so it stays the ONE derivation the wake-aware morning hour and
// the digest both key on. No new `.prepare`, so the scoping guard is unaffected.
export function typicalWakeTime(
  profileId: number,
  opts?: SleepRegularityOptions
): number | null {
  return computeTypicalWakeTime(
    getSleepSessions(profileId),
    getTimezone(profileId),
    opts
  );
}

// Whether the profile has ANY recorded sleep session — the data gate for the
// /sleep nav entry (issue #1066). Cheap: one bounded session read (delegates to
// the already profile-scoped getSleepSessions, so no new `.prepare`).
export function hasSleepData(profileId: number): boolean {
  return getMetricDailyTotals(profileId, "sleep_min", 1).length > 0;
}

// The "last night" summary — the MAIN overnight session (#1118) reduced to the
// hero/tile facts, over the trailing-30-night baseline. The /sleep hero AND the
// dashboard tile read THIS, so the two surfaces agree ("one question, one
// computation", #221). Stages come from the same daily-totals read the Trends
// stage chart uses, keyed by wake-day.
export function getLastNightSummary(
  profileId: number
): LastNightSummary | null {
  const stagesByDay = new Map<string, SleepStageMinutes>();
  for (const r of getSleepStageDailyTotals(profileId)) {
    stagesByDay.set(r.date, {
      deep: r.deep,
      rem: r.rem,
      light: r.light,
      awake: r.awake,
    });
  }
  const sessions = getSleepSessions(profileId);
  const windowSummary = lastNightSummary(
    sessions,
    getTimezone(profileId),
    stagesByDay
  );
  const durationTrend = getSleepDurationTrend(profileId, 180);
  const latestTotal = durationTrend.at(-1);
  // A later duration-only row (normally manual quick-add) should not disappear
  // behind the older imported session merely because it has no fabricated clock.
  if (
    latestTotal &&
    (windowSummary == null || latestTotal.date > windowSummary.wakeDay)
  ) {
    const sourceSeries = getMetricSeriesBySource(
      profileId,
      "sleep_min",
      180
    ).filter((series) =>
      series.data.some((row) => row.date === latestTotal.date)
    );
    const source =
      sourceSeries.find((series) => series.source === "manual")?.source ??
      sourceSeries[0]?.source ??
      null;
    return latestDailySleepSummary(durationTrend, source);
  }
  return windowSummary ?? latestDailySleepSummary(durationTrend);
}

export interface SleepDateRange {
  from?: string;
  to?: string;
}

// The latest sleep summary inside a selected Trends window. This is a distinct
// question from "last night": newer sessions outside the window cannot decide
// whether an older window has sleep, nor can they supply its headline value.
// Timed sessions use the canonical main-vs-nap classifier; duration-only manual
// rows remain available without inventing bed/wake clocks.
export function getSleepSummaryInRange(
  profileId: number,
  range: SleepDateRange
): LastNightSummary | null {
  const inRange = (date: string) =>
    (!range.from || date >= range.from) && (!range.to || date <= range.to);
  const timezone = getTimezone(profileId);
  const sessions = getSleepSessionsInRange(
    profileId,
    range.from,
    range.to
  ).filter((session) => inRange(session.date));
  const stagesByDay = new Map<string, SleepStageMinutes>();
  for (const row of getSleepStageDailyTotals(profileId).filter((stage) =>
    inRange(stage.date)
  )) {
    stagesByDay.set(row.date, {
      deep: row.deep,
      rem: row.rem,
      light: row.light,
      awake: row.awake,
    });
  }
  const sessionSummary = lastNightSummary(sessions, timezone, stagesByDay);

  const mainDurations = mainSleepNights(sessions, timezone).map((night) => ({
    date: night.wakeDay,
    value: night.durationMin,
  }));
  const durationByDay = new Map(
    mainDurations.map((row) => [row.date, row.value])
  );
  const manualRows = getEditableManualSleepDurations(
    profileId,
    range.from ?? "0000-01-01",
    range.to ?? "9999-12-31"
  );
  for (const row of manualRows) {
    if (!durationByDay.has(row.date)) durationByDay.set(row.date, row.value);
  }
  const durationTrend = [...durationByDay]
    .map(([date, value]) => ({ date, value }))
    .sort((left, right) => (left.date < right.date ? -1 : 1));
  const latestDuration = durationTrend.at(-1);
  if (
    latestDuration &&
    (sessionSummary == null || latestDuration.date > sessionSummary.wakeDay)
  ) {
    return latestDailySleepSummary(durationTrend, "manual");
  }
  return sessionSummary;
}

// The main-session bed/wake per night for the consistency strip (issue #1066),
// oldest→newest, capped at `limitDays` recent nights. Nap sessions are dropped by
// the shared classifier (mainSleepNights) before the clock-hour re-expression.
export function getSleepConsistency(
  profileId: number,
  limitDays = 42
): ConsistencyNight[] {
  const tz = getTimezone(profileId);
  const sessions = getSleepSessions(profileId);
  const nights = mainSleepNights(sessions, tz).slice(-limitDays);
  return consistencyNights(nights, tz, {
    typicalBedMinute: computeTypicalBedTime(sessions, tz),
    typicalWakeMinute: computeTypicalWakeTime(sessions, tz),
  });
}

// The per-night stage composition over time (stacked-area input) — the SAME
// getSleepStageDailyTotals read the Trends stage chart uses, re-exposed for the
// Sleep page so both render identical stage series.
export function getSleepStageComposition(
  profileId: number,
  limitDays = 42
): { date: string; deep: number; rem: number; light: number; awake: number }[] {
  return getSleepStageDailyTotals(profileId).slice(-limitDays);
}

export const SLEEP_MOOD_HISTORY_DAYS = 60;

export interface SleepMoodData {
  points: SleepMoodPoint[];
  history: SleepMoodHistoryRow[];
  windowDays: number;
}

// Bedtime supplements belong to the profile-local day on which the MAIN sleep
// session began, while the Sleep log is keyed to its wake-day. Resolve that seam
// from the actual session window, then reuse the intake domain's existing bedtime,
// due-state, lifetime, and taken/skipped computations. Duration-only sleep has no
// start instant, so it deliberately gets no inferred supplement status.
function bedtimeSupplementsByWakeDay(
  profileId: number,
  wakeDays: readonly string[],
  windowDays: number
): Map<string, BedtimeSupplementSummary> {
  const wanted = new Set(wakeDays);
  if (wanted.size === 0) return new Map();

  const timezone = getTimezone(profileId);
  const earliestWakeDay = [...wanted].sort()[0];
  const sleepDateByWakeDay = new Map(
    mainSleepNights(
      getSleepSessionsSince(profileId, shiftDateStr(earliestWakeDay, -1)),
      timezone
    )
      .filter((night) => wanted.has(night.wakeDay))
      .map((night) => [
        night.wakeDay,
        zonedDateParts(timezone, new Date(night.start)).date,
      ])
  );
  if (sleepDateByWakeDay.size === 0) return new Map();

  const supplements = getSupplements(profileId).filter(
    (item) => item.kind === "supplement" && item.obligation !== "may"
  );
  const supplementById = new Map(supplements.map((item) => [item.id, item]));
  const supplementDoses = getSupplementDosesForHistory(profileId).filter(
    (dose) => supplementById.has(dose.item_id)
  );
  if (supplementDoses.length === 0) return new Map();

  const statusByDose = indexTakenByDose(
    getIntakeLogsInRange(profileId, windowDays + 1)
  );
  const workoutDays = new Set(getActivityDates(profileId));
  const situationsOn = situationHistoryResolver(
    getActiveSituations(profileId),
    getSituationEvents(profileId)
  );
  const summaries = new Map<string, BedtimeSupplementSummary>();

  for (const [wakeDay, sleepDate] of sleepDateByWakeDay) {
    const dueDoses = supplementDoses.flatMap((dose) => {
      const item = supplementById.get(dose.item_id)!;
      const status = statusByDose.get(dose.id);
      const taken = status?.taken.has(sleepDate) ?? false;
      const skipped = status?.skipped.has(sleepDate) ?? false;
      const resolved = taken || skipped;
      // The fact/judgment split lives in the pure bedtimeDoseDisposition: a night
      // with a taken/skipped log renders on the strength of that log alone (so a
      // paused, retired, or later-edited dose keeps its history — #1972), while an
      // unlogged night is still judged by the dose's lifetime and schedule below.
      //
      // Both inputs to that judgment are now effective-dated (#1973):
      //
      //   • `isBedtimeDose` asks which slot the dose held ON THAT NIGHT, not which one
      //     it holds today. This closes the residual #1972 named and could not fix on
      //     its own: nothing recorded a past slot, so a dose re-timed INTO the bedtime
      //     slot retroactively claimed every earlier log as a bedtime log. Versions are
      //     that record, so both directions now resolve — a dose moved OUT of bedtime
      //     keeps the nights it really was a bedtime dose (the #1972 fix, intact), and
      //     one moved IN stops claiming nights it was an evening dose.
      //
      //   • `adherenceSince` is the dose's EXISTENCE bound and nothing else. It used to
      //     be doseAdherenceSince(), which folded `updated_at` in and so voided every
      //     night before any schedule edit — the erase-the-history reading of the
      //     invariant that #1973 replaced. A night before the dose existed still carries
      //     no expectation; a night before it was merely EDITED is judged by the version
      //     in force then, via doseDueOn below.
      const disposition = bedtimeDoseDisposition({
        sleepDate,
        logged: resolved,
        isBedtimeDose: doseBucketOn(dose, sleepDate) === "Before sleep",
        isCurrentDose: item.active === 1 && dose.retired === 0,
        adherenceSince: doseExistsSince(
          item.created_at,
          dose.created_at,
          timezone
        ),
      });
      if (disposition === "excluded") return [];
      if (
        disposition === "scheduled" &&
        !doseDueOn(item, dose, {
          date: sleepDate,
          isWorkoutDay: workoutDays.has(sleepDate),
          activeSituations: situationsOn(sleepDate),
        })
      ) {
        return [];
      }
      return [
        {
          itemId: item.id,
          name: item.name,
          status: taken
            ? ("taken" as const)
            : skipped
              ? ("skipped" as const)
              : null,
        },
      ];
    });
    const summary = summarizeBedtimeSupplements(sleepDate, dueDoses);
    if (summary) summaries.set(wakeDay, summary);
  }
  return summaries;
}

// Sleep, stage, and mood observations inside one calendar window. History is the
// UNION of dates from all three reads, while points retain only paired sleep and
// mood dates for the relationship plot. Sleep duration comes from the canonical
// trend read so a manual duration-only record appears alongside imported main
// sleep sessions; stages reuse the same daily totals as the stage chart.
export function getSleepMoodData(
  profileId: number,
  windowDays = SLEEP_MOOD_HISTORY_DAYS
): SleepMoodData {
  const boundedDays = Math.max(1, Math.floor(windowDays));
  const end = today(profileId);
  const since = shiftDateStr(end, -(boundedDays - 1));
  const nights = getSleepDurationTrend(profileId, boundedDays).filter(
    (night) => night.date >= since && night.date <= end
  );
  const moods = getMoodLogs(profileId, since).filter(
    (mood) => mood.date <= end
  );
  const stageRows = getSleepStageComposition(profileId, boundedDays).filter(
    (row) => row.date >= since && row.date <= end
  );
  const baseHistory = buildSleepMoodHistory(nights, moods, stageRows);
  const manualRows = getEditableManualSleepDurations(profileId, since, end);
  const editableHistory = attachEditableManualSleep(baseHistory, manualRows);
  const bedtimeByWakeDay = bedtimeSupplementsByWakeDay(
    profileId,
    editableHistory.map((row) => row.date),
    boundedDays
  );
  const history = editableHistory.map((row) => ({
    ...row,
    bedtimeSupplements: bedtimeByWakeDay.get(row.date) ?? null,
  }));
  return {
    points: sleepMoodPoints(history),
    history,
    windowDays: boundedDays,
  };
}

// Compatibility read for consumers that only need paired plot points.
export function getSleepMoodPairing(
  profileId: number,
  limitDays = 60
): SleepMoodPoint[] {
  return getSleepMoodData(profileId, limitDays).points;
}

// The latest ingested Oura vendor scores + their recent trends (issue #1069) —
// DISPLAY-ONLY, ATTRIBUTED, engine-inert. These are STORE-WHAT-THE-SOURCE-SAID
// numbers (a fact about what Oura reported), never a synthesis input: this is the
// SOLE read path, and the reverse-allowlist guard
// (lib/__tests__/oura-score-engine-inert.test.ts) fails CI if any engine references
// the kinds. Delegates to the generic profile-scoped sample readers (no new
// `.prepare`, so the scoping guard is unaffected); an absent score renders nothing.
export interface OuraScore {
  latest: number;
  date: string;
  trend: { date: string; value: number }[];
}

export interface OuraScores {
  sleep: OuraScore | null;
  readiness: OuraScore | null;
}

function readOuraScore(
  profileId: number,
  metric: string,
  limitDays: number
): OuraScore | null {
  const latest = getLatestMetricSample(profileId, metric);
  if (!latest) return null;
  return {
    latest: latest.value,
    date: latest.date,
    trend: getMetricDailyTotals(profileId, metric, limitDays),
  };
}

export function getOuraScores(profileId: number, limitDays = 60): OuraScores {
  return {
    sleep: readOuraScore(profileId, OURA_SLEEP_SCORE_METRIC, limitDays),
    readiness: readOuraScore(profileId, OURA_READINESS_SCORE_METRIC, limitDays),
  };
}

// The current rolling-window SRI + companions for a profile, or null when there
// isn't enough sleep data (below the minimum-nights gate).
export function getSleepRegularity(
  profileId: number,
  opts?: SleepRegularityOptions
): SleepRegularity | null {
  return computeSleepRegularity(
    getSleepSessions(profileId),
    getTimezone(profileId),
    // Resolve the profile's free-day set for the social-jetlag split (#1241) — an
    // explicit opts.freeDays (tests) wins; otherwise the stored setting (Sat/Sun
    // default) drives it. The pure core stays auth-blind: the setting is data.
    { freeDays: getFreeDays(profileId), ...opts }
  );
}

// SRI for the selected Trends window. The range supplies both the input sessions
// and the rolling-window anchor, so a historical view cannot display today's SRI.
export function getSleepRegularityInRange(
  profileId: number,
  range: SleepDateRange
): SleepRegularity | null {
  const end = range.to ?? today(profileId);
  const start = range.from ?? shiftDateStr(end, -27);
  const span = daysBetweenDateStr(start, end);
  const windowDays = span == null ? 28 : Math.max(1, span + 1);
  return computeSleepRegularity(
    getSleepSessionsInRange(profileId, start, end),
    getTimezone(profileId),
    {
      asOf: end,
      windowDays,
      freeDays: getFreeDays(profileId),
    }
  );
}

// The rolling SRI trend series (oldest→newest) for the Trends sleep chart.
export function getSleepRegularityTrend(
  profileId: number,
  opts?: SleepRegularityOptions
): { date: string; sri: number }[] {
  return sriTrend(getSleepSessions(profileId), getTimezone(profileId), {
    freeDays: getFreeDays(profileId),
    ...opts,
  });
}

// The "regularity dropped since travel" insight note, or null. Reuses the trend
// above and the profile's dated situation change-log (which already tracks
// travel), so no new state is introduced.
export function getSleepRegularityInsight(
  profileId: number,
  opts?: SleepRegularityOptions
): string | null {
  const trend = getSleepRegularityTrend(profileId, opts);
  return regularityTravelInsight(trend, getSituationEvents(profileId));
}

// ── the morning waiting window (#2097) ───────────────────────────────────────

// The wake-days a SYNCING source recorded, over the tracking lookback. Manual rows
// are excluded on purpose: the waiting state promises something is arriving, and a
// hand-logged night is not something anybody is sending. Bounded to the lookback
// plus last night, so this is a short indexed range read, not a history scan.
export function getSyncedSleepWakeDays(
  profileId: number,
  todayStr: string,
  lookbackNights = TRACKING_LOOKBACK_NIGHTS
): string[] {
  const since = shiftDateStr(todayStr, -lookbackNights);
  return (
    db
      .prepare(
        `SELECT DISTINCT date FROM metric_samples
          WHERE profile_id = ? AND metric = 'sleep_min' AND source <> 'manual'
            AND date >= ? AND date <= ?
          ORDER BY date`
      )
      .all(profileId, since, todayStr) as { date: string }[]
  ).map((r) => r.date);
}

// How long after a night ENDS its row actually lands, in minutes — the one genuinely
// new measurement this feature needs. Joins each inserted `sleep_min` row to the
// sync-row provenance that wrote it (#1333) and takes the median.
//
// `inserted` only, and lags outside a plausible same-morning band are dropped: an
// ARCHIVE import (a Fitbit Takeout zip) inserts hundreds of nights at once, whose
// "lag" is months, and letting those into the sample would quote an ETA measured on
// a one-off backfill instead of the daily rhythm this state is about.
//
// Returns null under MIN_ARRIVAL_SAMPLES — `integration_sync_rows` retention reaches
// back ~12 days, so the sample is often thin, and a median built on three mornings
// is not something to put on screen as a promise.
export const ARRIVAL_LAG_MAX_MIN = 12 * 60;

export function getSleepArrivalLagMinutes(
  profileId: number,
  limit = 28
): number | null {
  const rows = db
    .prepare(
      `SELECT (julianday(r.created_at) - julianday(s.end_time)) * 1440 AS lag
         FROM integration_sync_rows r
         JOIN integration_sync_events e ON e.id = r.event_id
         JOIN metric_samples s ON s.id = r.target_id
        WHERE e.profile_id = ? AND s.profile_id = ?
          AND r.target_table = 'metric_samples'
          AND r.disposition = 'inserted'
          AND s.metric = 'sleep_min'
        ORDER BY r.created_at DESC, r.id DESC
        LIMIT ?`
    )
    .all(profileId, profileId, limit * 4) as { lag: number | null }[];
  const lags = rows
    .map((r) => r.lag)
    .filter(
      (v): v is number => v != null && v >= 0 && v <= ARRIVAL_LAG_MAX_MIN
    )
    .slice(0, limit)
    .sort((a, b) => a - b);
  if (lags.length < MIN_ARRIVAL_SAMPLES) return null;
  const mid = Math.floor(lags.length / 2);
  const median =
    lags.length % 2 ? lags[mid] : (lags[mid - 1] + lags[mid]) / 2;
  return Math.round(median);
}

// The profile's morning waiting state, or null when the ordinary surfaces have
// something true to say. Gathers; the decision itself is the pure sleepWaitingState
// so the dashboard tile, the /sleep hero and the Now strip cannot disagree (#221).
export function getSleepWaitingState(
  profileId: number,
  summaryWakeDay: string | null
): SleepWaitingState | null {
  const todayStr = today(profileId);
  const hasLastNight =
    summaryWakeDay != null && isLastNight(summaryWakeDay, todayStr);
  // The cheapest exit first: with last night in hand nothing else is worth reading.
  if (hasLastNight) return null;
  const tz = getTimezone(profileId);
  const minutesOfDay = hhmmToMinutes(zonedDateParts(tz, now()).hhmm);
  const tracking = isSleepTracking(
    getSyncedSleepWakeDays(profileId, todayStr),
    todayStr
  );
  if (!tracking) return null;
  const attention = getIntegrationAttention(profileId);
  return sleepWaitingState({
    hasLastNight,
    minutesOfDay,
    wakeMinutes: typicalWakeTime(profileId),
    tracking,
    arrivalLagMin: getSleepArrivalLagMinutes(profileId),
    providerHealthy: attention.length === 0,
    lastCheckedAt: latestSleepSyncAt(profileId),
  });
}

// The most recent sync ATTEMPT of whichever provider last wrote this profile's
// sleep — "last checked 6:33 AM". Reuses the grid's own per-provider event read
// rather than introducing a second notion of when a source was last contacted.
function latestSleepSyncAt(profileId: number): string | null {
  const row = db
    .prepare(
      `SELECT source FROM metric_samples
        WHERE profile_id = ? AND metric = 'sleep_min' AND source <> 'manual'
        ORDER BY date DESC LIMIT 1`
    )
    .get(profileId) as { source: string } | undefined;
  if (!row) return null;
  return getLatestSyncEvent(profileId, row.source)?.at ?? null;
}
