// Server-side assembly for the Sleep Regularity Index (#160). The math is the
// pure lib/sleep-regularity; this layer only gathers the profile-scoped inputs
// (raw sleep sessions + the profile timezone + travel situations) and hands them
// to that single computation, so the Trends surface and the weekly recap render
// the SAME numbers ("one question, one computation"). No `.prepare` here — the
// session read goes through the already profile-scoped getSleepSessions — so the
// scoping guard is unaffected.

import { cache } from "../request-cache";
import {
  getDailySleepSessionsSince,
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
import { HEALTH_CONNECT_ID } from "../integrations/health-connect";
import { restampedTwinPairs } from "../integrations/sleep-overlap-db";
import { sleepOverlapPairs, type SleepSessionRow } from "../sleep-overlap";
import { getMoodLogs } from "./mood";
import { getSuspectSleepSessions } from "./sleep-clock-skew";
import { getActivityDates } from "./training/activities";
import { getIntakeDosesForHistory, getIntakeItems } from "./intake/schedule";
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
import { doseWindowSince, indexTakenByDose } from "../intake-adherence";
import { profileDayZone } from "../travel-excusal";
import { zoneOf } from "../travel-timezone";
import { doseBucketOn, doseDueOn } from "../intake-schedule";
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
  napSessions,
  typicalBedTime as computeTypicalBedTime,
  typicalWakeTime as computeTypicalWakeTime,
  type SleepRegularity,
  type SleepRegularityOptions,
} from "../sleep-regularity";
import { sleepWaitingState, type SleepWaitingState } from "../sleep-waiting";
import {
  getArrivalLagMinutes,
  getIntegrationAttention,
  getLatestSyncEvent,
} from "./integrations";
import {
  isLastNight,
  isSleepTracking,
  SLEEP_TRACKING_WINDOW_NIGHTS,
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
    profileDayZone(profileId)
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
    profileDayZone(profileId),
    opts
  );
}

// The profile's typical BED time as a clock minute-of-day, or null below the same
// minimum-nights gate. Exactly `typicalWakeTime`'s twin — same sessions read, same pure
// classifier, same options — so the "usual band" a surface shows is the SAME pair the
// notification schedule already keys on (#3253's rider). No new derivation and no new
// `.prepare`.
export function typicalBedTime(
  profileId: number,
  opts?: SleepRegularityOptions
): number | null {
  return computeTypicalBedTime(
    getSleepSessions(profileId),
    profileDayZone(profileId),
    opts
  );
}

// Whether the profile has ANY recorded sleep session — the data gate for the
// /sleep nav entry (issue #1066). Cheap: one bounded session read (delegates to
// the already profile-scoped getSleepSessions, so no new `.prepare`).
export function hasSleepData(profileId: number): boolean {
  return getMetricDailyTotals(profileId, "sleep_min", 1).length > 0;
}

// The stage window "last night" needs (#2551). `lastNightSummary` reads exactly ONE
// key out of the map below — the latest wake-day — so the read that fills it was
// answering about one night by attributing half a year of stage rows, on the two
// most-visited pages in the app (the dashboard sleep presentation and /sleep hero), uncached,
// on every render. This is the fifth instance of #2520's class and takes its fix:
// the window reaches the READ, as the stage-day scan's SQL LIMIT.
//
// A WEEK, not a day, and the reason is the one getSleepStageComposition already
// states: the newest STAGE day is not necessarily the newest MAIN night. A nap-only
// day carries stage rows too, and a stage day whose elected main session is missing
// contributes no row at all — so a one-day read can answer "no stages" for a night
// that has them. A week is ~28 rows on a Health Connect profile against the 180-day
// default's thousands, and it covers any run of those days a night is realistically
// sitting behind.
export const LAST_NIGHT_STAGE_DAYS = 7;

// The "last night" summary — the MAIN overnight session (#1118) reduced to the
// hero/tile facts, over the trailing-30-night baseline. The /sleep hero AND the
// dashboard sleep presentation read THIS, so the two surfaces agree ("one question, one
// computation", #221). Stages come from the same daily-totals read the Trends
// stage chart uses, keyed by wake-day.
export function getLastNightSummary(
  profileId: number
): LastNightSummary | null {
  const stagesByDay = new Map<string, SleepStageMinutes>();
  for (const r of getSleepStageDailyTotals(profileId, LAST_NIGHT_STAGE_DAYS)) {
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
    profileDayZone(profileId),
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
  const dayZone = profileDayZone(profileId);
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
  const sessionSummary = lastNightSummary(sessions, dayZone, stagesByDay);

  const mainDurations = mainSleepNights(sessions, dayZone).map((night) => ({
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
  const dayZone = profileDayZone(profileId);
  const sessions = getSleepSessions(profileId);
  const nights = mainSleepNights(sessions, dayZone).slice(-limitDays);
  return consistencyNights(nights, dayZone, {
    typicalBedMinute: computeTypicalBedTime(sessions, dayZone),
    typicalWakeMinute: computeTypicalWakeTime(sessions, dayZone),
  });
}

// The per-night MAIN-sleep stage composition over time (stacked-area input) — the
// SAME getSleepStageDailyTotals read the hero uses. Timestamp attribution keeps a
// same-wake-day nap out, so each stage stack describes the overnight duration point.
//
// `limitDays` reaches the READ (#2520). It used to be a `.slice(-limitDays)` over the
// underlying function's OWN 180-day default, so the digest's 14-night ask computed
// half a year of stage attribution to read one night. Every caller wants a recent
// window (the /sleep chart's 90, the sleep↔mood pairing's 60, the digest's 14) and
// none of them aggregates over anything its window excludes, so narrowing the scan
// changes cost, not answers.
//
// Not a single-date accessor for the digest, deliberately: the newest stage day is
// not necessarily the newest MAIN night (a nap-only day carries stage rows too), so a
// one-day read could answer "no stages" for a night that has them. The window read is
// what makes the wake-day lookup safe.
export function getSleepStageComposition(
  profileId: number,
  limitDays = 42
): { date: string; deep: number; rem: number; light: number; awake: number }[] {
  return getSleepStageDailyTotals(profileId, limitDays);
}

export const NAP_HISTORY_DAYS = 60;

export interface NapHistoryRow {
  date: string;
  startMinutes: number;
  endMinutes: number;
  durationMin: number;
  source: string | null;
}

export interface NapHistory {
  today: NapHistoryRow[];
  history: NapHistoryRow[];
  windowDays: number;
}

// The dedicated nap read for both visible surfaces. Classification is the exact
// inverse of the shared mainSleepPeriod decision: a fragmented night's members
// remain main sleep and every other session on its wake-day is a nap. Clock values
// cross the timezone boundary here so client formatters receive plain minute-of-day
// facts rather than reinterpreting UTC in the browser's zone.
export function getNapHistory(
  profileId: number,
  windowDays = NAP_HISTORY_DAYS
): NapHistory {
  const boundedDays = Math.max(1, Math.floor(windowDays));
  const end = today(profileId);
  const since = shiftDateStr(end, -(boundedDays - 1));
  const dayZone = profileDayZone(profileId);
  const history = napSessions(
    getDailySleepSessionsSince(profileId, since),
    dayZone
  )
    .filter((nap) => nap.wakeDay >= since && nap.wakeDay <= end)
    .map((nap) => ({
      date: nap.wakeDay,
      startMinutes: hhmmToMinutes(
        zonedDateParts(
          zoneOf(dayZone, new Date(nap.start)),
          new Date(nap.start)
        ).hhmm
      ),
      endMinutes: hhmmToMinutes(
        zonedDateParts(zoneOf(dayZone, new Date(nap.end)), new Date(nap.end))
          .hhmm
      ),
      durationMin: nap.durationMin,
      source: nap.session.source ?? null,
    }));
  return {
    today: history.filter((nap) => nap.date === end),
    history,
    windowDays: boundedDays,
  };
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

  const dayZone = profileDayZone(profileId);
  const earliestWakeDay = [...wanted].sort()[0];
  const sleepDateByWakeDay = new Map(
    mainSleepNights(
      getSleepSessionsSince(profileId, shiftDateStr(earliestWakeDay, -1)),
      dayZone
    )
      .filter((night) => wanted.has(night.wakeDay))
      .map((night) => {
        const start = new Date(night.start);
        return [
          night.wakeDay,
          zonedDateParts(zoneOf(dayZone, start), start).date,
        ];
      })
  );
  if (sleepDateByWakeDay.size === 0) return new Map();

  const supplements = getIntakeItems(profileId).filter(
    (item) => item.kind === "supplement" && item.obligation !== "may"
  );
  const supplementById = new Map(supplements.map((item) => [item.id, item]));
  const supplementDoses = getIntakeDosesForHistory(profileId).filter((dose) =>
    supplementById.has(dose.item_id)
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
      //     no expectation; a backfilled log is proof it existed before `created_at`,
      //     matching every other adherence surface (#4023). A night before it was merely
      //     EDITED is judged by the version in force then, via doseDueOn below.
      const disposition = bedtimeDoseDisposition({
        sleepDate,
        logged: resolved,
        isBedtimeDose: doseBucketOn(dose, sleepDate) === "Before sleep",
        isCurrentDose: item.active === 1 && dose.retired === 0,
        adherenceSince: doseWindowSince(
          item.created_at,
          dose.created_at,
          status,
          dayZone
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
  // The clock-skew mark (#4299), folded in AFTER the manual-editability pass so the two
  // cannot fight over `sleepSampleId`: a night is either the duration-only manual row
  // that pass identified, or a synced session the detector contradicted — never both, and
  // a suspect night stays UNeditable either way (`sleepEditable` is untouched here).
  const suspectSampleByWakeDay = new Map(
    getSuspectSleepSessions(profileId, since).map((s) => [
      s.wakeDay,
      s.sampleId,
    ])
  );
  const history = editableHistory.map((row) => {
    const suspectSampleId = suspectSampleByWakeDay.get(row.date) ?? null;
    return {
      ...row,
      bedtimeSupplements: bedtimeByWakeDay.get(row.date) ?? null,
      sleepSuspect: suspectSampleId != null,
      sleepSampleId: row.sleepSampleId ?? suspectSampleId,
    };
  });
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
    profileDayZone(profileId),
    // Resolve the profile's free-day set for the social-jetlag split (#1241) — an
    // explicit opts.freeDays (tests) wins; otherwise the stored setting (Sat/Sun
    // default) drives it. The pure core stays auth-blind: the setting is data.
    { freeDays: getFreeDays(profileId), ...opts }
  );
}

// The rolling SRI as it stood when the selected main sleep ENDED. The morning
// digest uses this boundary so an afternoon nap can contribute to the live Sleep
// page's SRI without silently rewriting the report delivered that morning. Past
// naps remain in the computation; only sessions that happened after this morning's
// wake are withheld. The pure SRI engine and all of its policy stay shared.
export function getSleepRegularityThrough(
  profileId: number,
  throughInstant: string,
  opts?: SleepRegularityOptions
): SleepRegularity | null {
  const through = new Date(throughInstant).getTime();
  if (!Number.isFinite(through)) return null;
  return computeSleepRegularity(
    getSleepSessions(profileId).filter((session) => {
      const end = new Date(session.end).getTime();
      return Number.isFinite(end) && end <= through;
    }),
    profileDayZone(profileId),
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
    profileDayZone(profileId),
    {
      asOf: end,
      windowDays,
      freeDays: getFreeDays(profileId),
    }
  );
}

// The rolling SRI trend series (oldest→newest) for the Trends sleep chart.
//
// REQUEST-CACHED because several surfaces on one render ask for the same series
// (#5010): the dashboard reaches it through `sriTrendArrow`, the protocol samples ask
// again, and `getSleepRegularityInsight` below re-reads it — each a full pass over the
// profile's sleep history. `cache()` is identity outside a Next request
// (lib/request-cache.ts says so deliberately), so the notify tick and the DB tier
// behave exactly as before. Keyed on the arguments, so a caller narrowing the window
// with its own `opts` still gets its own computation.
//
// THE KEY IS ARGUMENT IDENTITY, so a second argument silently costs a full recompute.
// React memoizes on the positional arguments BY IDENTITY: every call site today passes
// `profileId` alone, which is why they collapse. A caller that adds an options literal
// — even `{}`, even one structurally equal to another caller's — misses, and gets its
// own pass over the whole sleep history with nothing to report that it did. If you are
// adding a call site and you need `opts`, hoist the object so the callers that share a
// window share the object too.
export const getSleepRegularityTrend = cache(function getSleepRegularityTrend(
  profileId: number,
  opts?: SleepRegularityOptions
): { date: string; sri: number }[] {
  return sriTrend(getSleepSessions(profileId), profileDayZone(profileId), {
    freeDays: getFreeDays(profileId),
    ...opts,
  });
});

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
  lookbackNights = SLEEP_TRACKING_WINDOW_NIGHTS
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

// WHICH SOURCES are recording this profile's sleep, over the same lookback and the
// same rows as the wake-days above (#2192). "Is the sleep source healthy?" is a
// question about a SOURCE, and the only honest answer to which source that is comes
// from the data: this is the same resolution `latestSleepSyncAt` already makes when
// it names the source whose sync time the "hasn't synced" line quotes, one step
// wider so a two-source profile is fully covered.
//
// Deliberately NOT a registry capability list. A hard-coded "sleep-capable" set
// (Oura / Health Connect / Fitbit) would be a second declaration to keep in step
// with lib/integrations/registry.ts, and it would still answer wrong for the case
// that matters — a ring the profile connected but does not wear to bed is
// sleep-capable and is not the source anyone is waiting for.
export function getSyncedSleepSources(
  profileId: number,
  todayStr: string,
  lookbackNights = SLEEP_TRACKING_WINDOW_NIGHTS
): string[] {
  const since = shiftDateStr(todayStr, -lookbackNights);
  return (
    db
      .prepare(
        `SELECT DISTINCT source FROM metric_samples
          WHERE profile_id = ? AND metric = 'sleep_min' AND source <> 'manual'
            AND date >= ? AND date <= ?
          ORDER BY source`
      )
      .all(profileId, since, todayStr) as { source: string }[]
  ).map((r) => r.source);
}

// How long after a night ENDS its `sleep_min` row actually lands, in minutes.
//
// The MEASUREMENT moved (#5001): it was never about sleep — join an inserted row to
// the sync provenance that wrote it and take the median — so it is
// `getArrivalLagMinutes` now, and the practice bound and the recap's provisional line
// read the same one. What stays here is the sleep CALL: `metric_samples` filtered to
// `sleep_min`, every source, exactly as before.
export { ARRIVAL_LAG_MAX_MIN } from "@/lib/arrival-wait";

export function getSleepArrivalLagMinutes(
  profileId: number,
  limit = 28
): number | null {
  return getArrivalLagMinutes(profileId, {
    targetTable: "metric_samples",
    metric: "sleep_min",
    limit,
  });
}

// The profile's morning waiting state, or null when the ordinary surfaces have
// something true to say. Gathers; the decision itself is the pure sleepWaitingState
// so the dashboard sleep presentation, /sleep hero and Now strip cannot disagree (#221).
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
  // Only THIS profile's sleep sources decide the health gate (#2192). The attention
  // list is account-wide — every connected source's failing/stale standing — so an
  // expired Strava token used to suppress "Waiting for last night's sleep" on a
  // profile whose ring was syncing perfectly, dropping it back to the stale
  // old-night headline #2097 exists to remove. Match the way `integrationToItem`
  // identifies a row's source: the registry id, or the raw source id for a source
  // the registry does not know.
  const sleepSources = new Set(getSyncedSleepSources(profileId, todayStr));
  const attention = getIntegrationAttention(profileId).filter((entry) =>
    sleepSources.has(entry.id ?? entry.sourceName)
  );
  return sleepWaitingState({
    hasLastNight,
    minutesOfDay,
    wakeMinutes: typicalWakeTime(profileId),
    tracking,
    arrivalLagMin: getSleepArrivalLagMinutes(profileId),
    sourceHealthy: attention.length === 0,
    lastCheckedAt: latestSleepSyncAt(profileId),
  });
}

// The most recent sync ATTEMPT of whichever source last wrote this profile's
// sleep — "last checked 6:33 AM". Reuses the grid's own per-source event read
// rather than introducing a second notion of when a source was last contacted.
export function latestSleepSyncAt(profileId: number): string | null {
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

// ── OVERLAPPING SLEEP SESSIONS STILL IN THE STORE (#3628) ──
//
// The pairs the ingest collapse (lib/integrations/sleep-overlap-db.ts) did NOT resolve:
// no heart rate inside one of the windows, heart rate reading as sleep inside BOTH, or
// the #133 lock holding a row. Nothing was deleted, so both nights are stored and one of
// the two days is showing a night that did not happen — which is exactly the thing a
// person can settle in one look and this app cannot.
//
// A DERIVED READ, WITH NOTHING STORED BEHIND IT. There is no decision table and no
// dismissal: the pair is listed while both rows exist and stops being listed the moment
// either is deleted, which is the #3321 shape (an unreadable dose is listed until it is
// retyped). That also means a pair that predates the collapse is listed too — the rule
// only ever runs on a push, and nothing replays it over history.
export const SLEEP_OVERLAP_REVIEW_DAYS = 90;

export interface OverlappingSleepSession {
  id: number;
  date: string;
  started_at: string;
  minutes: number;
}

export interface OverlappingSleepPair {
  origin: string;
  sessions: [OverlappingSleepSession, OverlappingSleepSession];
}

export function getOverlappingSleepSessions(
  profileId: number
): OverlappingSleepPair[] {
  const rows = db
    .prepare(
      `SELECT id, date, metric, origin, started_at, ended_at, edited, value
         FROM metric_samples
        WHERE profile_id = ? AND metric = 'sleep_min' AND source = ?
          AND date >= ?
        ORDER BY started_at`
    )
    .all(
      profileId,
      HEALTH_CONNECT_ID,
      shiftDateStr(today(profileId), -SLEEP_OVERLAP_REVIEW_DAYS)
    ) as (SleepSessionRow & { date: string; value: number })[];
  // The twin rule needs the stage read, so it lives with the store half; Review lists
  // what the collapse pairs, or a pair it left undecided would never reach the person
  // (#5020).
  return [
    ...sleepOverlapPairs(rows),
    ...restampedTwinPairs(profileId, HEALTH_CONNECT_ID, rows),
  ].map(({ a, b }) => ({
    // `sleepOverlapPairs` only pairs rows of one non-null origin, so either side names it.
    origin: a.origin as string,
    sessions: [a, b].map((s) => ({
      id: s.id,
      date: s.date,
      started_at: s.started_at,
      minutes: Math.round(s.value),
    })) as [OverlappingSleepSession, OverlappingSleepSession],
  }));
}
