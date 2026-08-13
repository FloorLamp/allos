// The GATHERING half of the paired-observations registry (#2177). The decision is pure
// and lives in lib/paired-observations.ts; nothing here re-derives it.
//
// This module does three things and nothing else:
//   (a) binds each declared PairedFactorSource to a reader over the user's own LOGS,
//   (b) binds each declared PairedOutcomeStream to the SAME day-grained series the
//       Trends surfaces already render (one question, one computation — a paired
//       observation must never disagree with the chart it points the reader at), and
//   (c) applies the entry's declared day offset and control rule to produce the
//       PairedNight[] the engine judges.
//
// No `.prepare` here: every read goes through an already profile-scoped query, so the
// scoping guard is unaffected and no new SQL exists to scope. The reader bindings are
// exhaustive switches over closed unions, which is what makes the compiler name this
// file when the registry grows a member — the registry itself never assembles SQL.
//
// COST. This runs inside collectCoachingFindings, i.e. on every dashboard render. The
// gather is therefore lazy and short-circuiting: the factor side is read first, and an
// entry whose with-arm cannot possibly reach PAIRED_MIN_NIGHTS_PER_ARM is dropped
// before its outcome series is touched. Outcome series are memoized per call, so two
// entries sharing a stream read it once.

import { ALCOHOL_FOOD_GROUP } from "../substance-use";
import { HRV_METRIC } from "../vitals-input";
import { shiftDateStr } from "../date";
import {
  PAIRED_MIN_NIGHTS_PER_ARM,
  PAIRED_WINDOW_DAYS,
  type PairedFactorSource,
  type PairedNight,
  type PairedObservationEntry,
  type PairedOutcomeStream,
} from "../paired-observations";
import { getFoodDailyServingTotalsInRange } from "./nutrition";
import { getActivityDates } from "./training/activities";
import { getBodyMetricDailySeries, getMetricDailyTotals } from "./metrics";
import { getSleepDurationTrend } from "./sleep";

// What the factor side of one entry knows about the window: the days the factor was
// LOGGED on, and the days that can legitimately join the control arm.
interface FactorDays {
  present: Set<string>;
  // Days eligible for the without-arm. For `absence-is-a-state` this is null, meaning
  // "every day with an outcome reading qualifies".
  observed: Set<string> | null;
}

function alcoholFactorDays(
  profileId: number,
  from: string,
  to: string
): FactorDays {
  // ONE read serves both halves: the drink days, and the days the food log was in use
  // at all. The second is the control rule — a day with no food logged is evidence
  // about logging, not about drinking (the food-regularity discipline), so it must not
  // silently pad the dry arm with the user's untracked evenings.
  const rows = getFoodDailyServingTotalsInRange(profileId, from, to);
  const present = new Set<string>();
  const observed = new Set<string>();
  for (const row of rows) {
    observed.add(row.date);
    if (row.group_key === ALCOHOL_FOOD_GROUP && row.servings > 0)
      present.add(row.date);
  }
  return { present, observed };
}

function activityFactorDays(
  profileId: number,
  from: string,
  to: string
): FactorDays {
  const present = new Set(
    getActivityDates(profileId).filter((d) => d >= from && d <= to)
  );
  // `absence-is-a-state`: a day with no activity row is a rest day everywhere else in
  // Allos (streaks, rest-day coaching, the weekly rhythm), so the control arm needs no
  // separate evidence that the training log was "in use".
  return { present, observed: null };
}

function factorDays(
  source: PairedFactorSource,
  profileId: number,
  from: string,
  to: string
): FactorDays {
  switch (source) {
    case "alcohol-servings":
      return alcoholFactorDays(profileId, from, to);
    case "logged-activity":
      return activityFactorDays(profileId, from, to);
  }
}

// The outcome series, oldest→newest, one value per day, in the outcome's own unit.
// Each is the SAME read its Trends surface uses.
function outcomeSeries(
  stream: PairedOutcomeStream,
  profileId: number,
  limitDays: number
): { date: string; value: number }[] {
  switch (stream) {
    case "overnight-hrv":
      // Averaged per day by the shared bucket rule — HRV is a point measure.
      return getMetricDailyTotals(profileId, HRV_METRIC, limitDays);
    case "next-morning-resting-hr":
      // body_metrics keys on (profile_id, date, source), so this goes through the
      // shared daily fold rather than raw rows (#1615).
      return getBodyMetricDailySeries(profileId, "resting_hr", limitDays);
    case "main-sleep-minutes":
      // MAIN overnight sleep per wake-day (#1118) — never the raw `sleep_min` total,
      // which sums a same-day nap into the night and would double-count it.
      return getSleepDurationTrend(profileId, limitDays);
  }
}

// The paired nights for one entry, or [] when the pair cannot reach its gates.
// `today` is the profile-local day the window ends on.
export function gatherPairedNights(
  profileId: number,
  entry: PairedObservationEntry,
  today: string,
  series: (stream: PairedOutcomeStream) => { date: string; value: number }[]
): PairedNight[] {
  // Factor days span the window; the outcome day is `offsetDays` later, so the last
  // factor day that can pair with a same-window outcome is `today - offsetDays`.
  const factorTo = shiftDateStr(today, -entry.outcome.offsetDays);
  const factorFrom = shiftDateStr(factorTo, -(PAIRED_WINDOW_DAYS - 1));
  const days = factorDays(entry.factor.source, profileId, factorFrom, factorTo);
  // Short-circuit before touching the outcome stream: the with-arm can only shrink
  // from here (a factor day whose outcome is missing drops out), so a factor that is
  // already below the minimum can never produce a verdict.
  if (days.present.size < PAIRED_MIN_NIGHTS_PER_ARM) return [];

  // `absence-is-a-state` still requires the factor's log to have been IN USE: the days
  // before the window's first logged occurrence are days we know nothing about, and
  // counting them as rest days would load the control arm with the stretch before the
  // user started logging workouts at all. So the control arm starts at the first
  // logged day. (`logging-evidence` needs no such bound — its observed set already
  // answers day by day.)
  const controlFrom =
    days.observed === null ? [...days.present].sort()[0] : factorFrom;

  const byDate = new Map(
    series(entry.outcome.stream).map((p) => [p.date, p.value])
  );
  const nights: PairedNight[] = [];
  for (let day = factorFrom; day <= factorTo; day = shiftDateStr(day, 1)) {
    const outcomeDate = shiftDateStr(day, entry.outcome.offsetDays);
    const value = byDate.get(outcomeDate);
    if (value == null) continue;
    const present = days.present.has(day);
    // A day the control rule cannot vouch for joins NEITHER arm.
    if (!present) {
      if (days.observed !== null && !days.observed.has(day)) continue;
      if (days.observed === null && day < controlFrom) continue;
    }
    nights.push({ date: outcomeDate, factor: present, value });
  }
  return nights;
}

// A per-call memo over the outcome readers, so two entries on one stream read it once.
export function outcomeSeriesReader(
  profileId: number
): (stream: PairedOutcomeStream) => { date: string; value: number }[] {
  const cache = new Map<
    PairedOutcomeStream,
    { date: string; value: number }[]
  >();
  return (stream) => {
    const hit = cache.get(stream);
    if (hit) return hit;
    // The window plus the largest declared offset, with slack for days the series
    // skips — these readers cap by ROWS WITH DATA, not by calendar days.
    const rows = outcomeSeries(stream, profileId, PAIRED_WINDOW_DAYS + 30);
    cache.set(stream, rows);
    return rows;
  };
}
