// Server-side assembly for the Sleep Regularity Index (#160). The math is the
// pure lib/sleep-regularity; this layer only gathers the profile-scoped inputs
// (raw sleep sessions + the profile timezone + travel situations) and hands them
// to that single computation, so the Trends surface and the weekly recap render
// the SAME numbers ("one question, one computation"). No `.prepare` here — the
// session read goes through the already profile-scoped getSleepSessions — so the
// scoping guard is unaffected.

import {
  getSleepSessions,
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
import { getSupplementLogsInRange } from "./intake/adherence";
import { today } from "../db";
import { shiftDateStr, zonedDateParts } from "../date";
import {
  getActiveSituations,
  getTimezone,
  getSituationEvents,
} from "../settings";
import { doseAdherenceSince } from "../adherence-patterns";
import { indexTakenByDose } from "../supplement-adherence";
import { isDueOn, timeBucket } from "../supplement-schedule";
import { situationHistoryResolver } from "../trend-annotations";
import {
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
    (item) => item.kind === "supplement" && item.as_needed !== 1
  );
  const supplementById = new Map(supplements.map((item) => [item.id, item]));
  const supplementDoses = getSupplementDosesForHistory(profileId).filter(
    (dose) => supplementById.has(dose.item_id)
  );
  if (supplementDoses.length === 0) return new Map();

  const statusByDose = indexTakenByDose(
    getSupplementLogsInRange(profileId, windowDays + 1)
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
      const isBedtimeDose = timeBucket(dose.time_of_day) === "Before sleep";
      const isCurrentBedtimeDose =
        item.active === 1 && dose.retired === 0 && isBedtimeDose;
      // Resolved logs preserve factual taken/skipped state for a paused or
      // retired bedtime dose. A later dose edit does not preserve the previous
      // slot, however, so either direction of a possible re-time is excluded
      // rather than attributing an old log to bedtime without evidence.
      const changedAfterNight =
        dose.updated_at != null && dose.updated_at.slice(0, 10) > sleepDate;
      const historicalResolved =
        resolved && isBedtimeDose && !changedAfterNight;
      if (resolved ? !historicalResolved : !isCurrentBedtimeDose) return [];

      const since = doseAdherenceSince(
        item.created_at,
        dose.created_at,
        dose.updated_at
      );
      if (!resolved && since != null && sleepDate < since) return [];
      if (
        !resolved &&
        !isDueOn(item, {
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
    opts
  );
}

// The rolling SRI trend series (oldest→newest) for the Trends sleep chart.
export function getSleepRegularityTrend(
  profileId: number,
  opts?: SleepRegularityOptions
): { date: string; sri: number }[] {
  return sriTrend(getSleepSessions(profileId), getTimezone(profileId), opts);
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
