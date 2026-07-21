// Server-side assembly for the Sleep Regularity Index (#160). The math is the
// pure lib/sleep-regularity; this layer only gathers the profile-scoped inputs
// (raw sleep sessions + the profile timezone + travel situations) and hands them
// to that single computation, so the Trends surface and the weekly recap render
// the SAME numbers ("one question, one computation"). No `.prepare` here — the
// session read goes through the already profile-scoped getSleepSessions — so the
// scoping guard is unaffected.

import { getSleepSessions, getSleepStageDailyTotals } from "./metrics";
import { getMoodLogs } from "./mood";
import { getTimezone, getSituationEvents } from "../settings";
import {
  computeSleepRegularity,
  sriTrend,
  regularityTravelInsight,
  mainSleepNights,
  typicalWakeTime as computeTypicalWakeTime,
  type SleepRegularity,
  type SleepRegularityOptions,
} from "../sleep-regularity";
import {
  lastNightSummary,
  consistencyNights,
  pairSleepMood,
  type LastNightSummary,
  type SleepStageMinutes,
  type ConsistencyNight,
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
  return getSleepSessions(profileId, 1).length > 0;
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
  return lastNightSummary(
    getSleepSessions(profileId),
    getTimezone(profileId),
    stagesByDay
  );
}

// The main-session bed/wake per night for the consistency strip (issue #1066),
// oldest→newest, capped at `limitDays` recent nights. Nap sessions are dropped by
// the shared classifier (mainSleepNights) before the clock-hour re-expression.
export function getSleepConsistency(
  profileId: number,
  limitDays = 42
): ConsistencyNight[] {
  const tz = getTimezone(profileId);
  const nights = mainSleepNights(getSleepSessions(profileId), tz).slice(
    -limitDays
  );
  return consistencyNights(nights, tz);
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

// The sleep↔mood pairing series (issue #992 observation, rendered inline on the
// Sleep page) — nights that have BOTH a main-session duration and a same-day mood
// check-in. Empty when either domain is absent, so the page hides the section.
export function getSleepMoodPairing(
  profileId: number,
  limitDays = 60
): SleepMoodPoint[] {
  const nights = getMainSleepNightlyMinutes(profileId, limitDays);
  if (nights.length === 0) return [];
  const since = nights[0].date;
  const moods = getMoodLogs(profileId, since).map((m) => ({
    date: m.date,
    valence: m.valence,
  }));
  if (moods.length === 0) return [];
  return pairSleepMood(nights, moods);
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
