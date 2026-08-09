// The DB gather seam for the paired-observations registry (#2177). The registry, the
// measure and every sentence are pure (lib/paired-observations.ts); this module only
// resolves each declared pair's two profile-scoped series and hands them over.
//
// NO `.prepare` HERE. Every read delegates to an already profile-scoped reader — the
// substance ledgers (getSubstanceHistory, which owns the food_log / substance_log
// dispatch), getActivityDates, getMetricDailyTotals, getBodyMetricDailySeries and
// getMainSleepNightlyMinutes — so the profile-scoping guard is unaffected and no pair
// re-derives a series some surface already owns (#221).
//
// The two `switch`es are EXHAUSTIVE over the declared source unions, which is the
// registry's compile-time tooth: a new pair naming a factor or outcome nobody can read
// fails `tsc` rather than silently producing no days.

import { getActivityDates } from "./training/activities";
import { getLatestBodyMetricDailyPoints, getMetricDailyTotals } from "./metrics";
import { getMainSleepNightlyMinutes } from "./sleep";
import { getSubstanceHistory } from "./substance";
import {
  decidePairedObservation,
  pairedDays,
  pairedWindowStart,
  PAIRED_OBSERVATION_LIST,
  type PairedComparison,
  type PairedFactorSource,
  type PairedObservationSpec,
  type PairedOutcomeStream,
} from "../paired-observations";

// The days the FACTOR was logged, as a set. A substance day counts when the day's
// logged amount is positive (a zero-amount correction row is not a use); an activity
// day counts when any session is filed on it.
function factorDaysFor(
  profileId: number,
  factor: PairedFactorSource,
  from: string
): Set<string> {
  switch (factor.kind) {
    case "substance": {
      const days = new Set<string>();
      for (const row of getSubstanceHistory(profileId, factor.substance)) {
        if (row.date >= from && row.amount > 0) days.add(row.date);
      }
      return days;
    }
    case "activity":
      return new Set(getActivityDates(profileId).filter((d) => d >= from));
  }
}

// The measured OUTCOME series, one value per day. Each branch is the SAME series its
// own surface renders, never a second realization of it.
function outcomeSeriesFor(
  profileId: number,
  outcome: PairedOutcomeStream,
  windowDays: number
): { date: string; value: number }[] {
  switch (outcome.kind) {
    case "metric-sample":
      return getMetricDailyTotals(profileId, outcome.metric, windowDays + 1);
    case "body-metric":
      // Bounded by DISTINCT DATE, not by raw rows: two sources reporting one day is
      // the normal #14 shape, and a row limit would silently shorten the window.
      return getLatestBodyMetricDailyPoints(
        profileId,
        outcome.metric,
        windowDays + 1
      );
    case "main-sleep":
      return getMainSleepNightlyMinutes(profileId, windowDays + 1);
  }
}

/** One pair's comparison, or null when it stays silent. Profile-scoped throughout. */
export function getPairedObservation(
  profileId: number,
  spec: PairedObservationSpec,
  today: string
): PairedComparison | null {
  const from = pairedWindowStart(spec, today);
  const days = pairedDays(
    spec,
    factorDaysFor(profileId, spec.factor, from),
    outcomeSeriesFor(profileId, spec.outcome, spec.windowDays),
    today
  );
  return decidePairedObservation(spec, days, today);
}

/**
 * Every registered pair that clears its gates, in registry order. A pair below its
 * per-arm minimum, below its effect floor, un-interleaved, or reading a stream that
 * has gone quiet contributes nothing at all.
 *
 * `includeAdultOnly: false` drops the rows the registry declares adult-only — the
 * substance pairs, whose whole surface is age-gated (#1174/#1279). The decision is a
 * registry FIELD, not a factor-kind pattern match here.
 */
export function getPairedObservations(
  profileId: number,
  today: string,
  opts?: { includeAdultOnly?: boolean }
): PairedComparison[] {
  const includeAdultOnly = opts?.includeAdultOnly ?? true;
  const out: PairedComparison[] = [];
  for (const spec of PAIRED_OBSERVATION_LIST) {
    if (spec.adultOnly && !includeAdultOnly) continue;
    const cmp = getPairedObservation(profileId, spec, today);
    if (cmp) out.push(cmp);
  }
  return out;
}
