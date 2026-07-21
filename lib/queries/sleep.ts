// Server-side assembly for the Sleep Regularity Index (#160). The math is the
// pure lib/sleep-regularity; this layer only gathers the profile-scoped inputs
// (raw sleep sessions + the profile timezone + travel situations) and hands them
// to that single computation, so the Trends surface and the weekly recap render
// the SAME numbers ("one question, one computation"). No `.prepare` here — the
// session read goes through the already profile-scoped getSleepSessions — so the
// scoping guard is unaffected.

import { getSleepSessions } from "./metrics";
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
