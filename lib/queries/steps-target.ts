// The daily step target's DB assembly (#1723 part 2). Auth-blind, profileId-first.
//
// Every decision (verdict phrasing, the behind-by-afternoon gate, the stale-data
// silence) lives in the pure lib/steps-target.ts. This module only resolves the
// declared target, the day's step sums, and how fresh the data is — then hands over.
//
// The step series is the SAME getMetricDailyTotals(profileId, "steps") the Body chart
// and the #1221 dashboard card read (one computation), and the trailing average is
// the SAME summarizeStepsToday result the card renders — never a second average.

import { db } from "../db";
import { getMetricDailyTotals } from "./metrics";
import { getStepsDailyTarget } from "../settings";
import { getTimezone } from "../settings";
import { summarizeStepsToday, STEPS_TRAILING_DAYS } from "../steps-today";
import {
  stepsBehindByAfternoon,
  stepsBehindDetail,
  stepsTodayTargetLine,
  stepsVerdictLine,
} from "../steps-target";
import { hourInTz, shiftDateStr } from "../date";

// Enough history for the trailing average plus the day itself.
const STEPS_LOOKBACK_DAYS = STEPS_TRAILING_DAYS + 2;

function stepsOn(
  points: readonly { date: string; value: number }[],
  date: string
): number | null {
  const row = points.find((p) => p.date === date);
  return row ? Math.round(row.value) : null;
}

export interface StepsDigestLines {
  // The Yesterday verdict line, or null (no target / no reading).
  yesterday: string | null;
  // The Today target line, or null (no target / the trailing average already clears
  // it — restating a target the reader meets is not news).
  today: string | null;
}

// The two digest lines for `date` (the profile-local today). Both null on a profile
// with no declared target, which is the resting state.
export function getStepsDigestLines(
  profileId: number,
  date: string
): StepsDigestLines {
  const target = getStepsDailyTarget(profileId);
  if (target == null) return { yesterday: null, today: null };
  const points = getMetricDailyTotals(profileId, "steps", STEPS_LOOKBACK_DAYS);
  const summary = summarizeStepsToday(points, date);
  return {
    yesterday: stepsVerdictLine(
      stepsOn(points, shiftDateStr(date, -1)),
      target
    ),
    today: stepsTodayTargetLine({
      target,
      average7: summary?.average7 ?? null,
    }),
  };
}

export interface StepsPaceObservation {
  date: string;
  stepsSoFar: number;
  target: number;
  detail: string;
}

// Today's afternoon observation, or null. Null is the overwhelmingly common answer:
// no declared target, before the evaluation hour, no data, STALE data (a late Health
// Connect batch must never manufacture a "behind"), or a day that is simply on track.
//
// It creates NO SEND. The caller turns this into a calm Upcoming item that rides the
// aggregation every existing surface already formats.
export function getStepsPaceObservation(
  profileId: number,
  date: string,
  now: Date = new Date()
): StepsPaceObservation | null {
  const target = getStepsDailyTarget(profileId);
  if (target == null) return null;

  const tz = getTimezone(profileId);
  const hourLocal = hourInTz(tz, now);

  const points = getMetricDailyTotals(profileId, "steps", 2);
  const stepsSoFar = stepsOn(points, date);

  // Freshness from the newest step SAMPLE's absolute end instant — the zone-
  // independent natural-key anchor — not from the derived calendar day, so a
  // timezone edge can't read as fresh data.
  const latest = db
    .prepare(
      `SELECT end_time FROM metric_samples
        WHERE profile_id = ? AND metric = 'steps'
        ORDER BY end_time DESC LIMIT 1`
    )
    .get(profileId) as { end_time: string } | undefined;
  const endMs = latest ? Date.parse(latest.end_time) : NaN;
  const dataAgeMin = Number.isFinite(endMs)
    ? Math.max(0, Math.round((now.getTime() - endMs) / 60000))
    : null;

  if (!stepsBehindByAfternoon({ hourLocal, stepsSoFar, target, dataAgeMin })) {
    return null;
  }
  const soFar = stepsSoFar as number;
  return {
    date,
    stepsSoFar: soFar,
    target,
    detail: stepsBehindDetail(soFar, target),
  };
}
