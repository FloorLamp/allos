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
  type SleepRegularity,
  type SleepRegularityOptions,
} from "../sleep-regularity";

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
