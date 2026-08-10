// Workout-density intensity math + the active-days strip (issue #186). The
// full week-column workout calendar this module used to build was absorbed by
// the generalized day-history (lib/day-history.ts) on Trends → Fitness; what
// remains is what other surfaces still consume: the shared `intensityLevel`
// ladder and the compact trailing-N-day strip.
//
// CHOSEN INTENSITY METRIC: SESSION COUNT (not minutes). It is the boring, robust
// choice — every activity has a day, but `duration_min` is frequently null (a
// hand-logged strength session often carries no duration), so a minutes scale
// would read half the calendar as "empty" when it wasn't. Total minutes are still
// carried per day for the hover detail; only the color LEVEL is count-driven.
//
// All arithmetic is UTC-anchored calendar math, DST-immune and
// timezone-independent. Day bucketing itself already happened upstream:
// `activities.date` is stored as the profile-local calendar day at ingest
// (issue #94), so grouping by it buckets in the profile timezone.
import { lastNDates } from "./date";

// One profile-local day's workout totals (the grouped query's row shape).
export interface WorkoutDayDensity {
  date: string; // YYYY-MM-DD, profile-local
  count: number; // sessions logged that day
  minutes: number; // total training minutes that day (0 when all durations null)
}

// A single rendered strip cell. `future` is always false here (the strip ends
// on `end`); the field survives from the retired week-column heatmap's shape.
export interface HeatmapCell {
  date: string; // YYYY-MM-DD
  count: number;
  minutes: number;
  level: 0 | 1 | 2 | 3 | 4; // color bucket, by session count
  future: boolean;
}

export interface ActiveDaysStrip {
  days: HeatmapCell[]; // oldest→newest, ending on `end`
  totalSessions: number;
  activeDays: number;
  totalMinutes: number;
}

// Session count → color bucket (0 = none … 4 = 4+). Fixed thresholds, deliberately
// boring: real training days almost never exceed a handful of sessions, so a flat
// 1/2/3/4+ ladder reads cleanly without needing per-user normalization.
export function intensityLevel(count: number): 0 | 1 | 2 | 3 | 4 {
  if (count <= 0) return 0;
  if (count === 1) return 1;
  if (count === 2) return 2;
  if (count === 3) return 3;
  return 4;
}

// Compact companion to the full heatmap: a literal trailing-N-day window rather
// than week-aligned columns, so "14 days" always means today plus the previous
// 13 profile-local calendar days.
export function buildActiveDaysStrip(
  density: WorkoutDayDensity[],
  end: string,
  length = 14
): ActiveDaysStrip {
  const byDate = new Map(density.map((day) => [day.date, day]));
  const days = lastNDates(end, length).map((date) => {
    const day = byDate.get(date);
    const count = day?.count ?? 0;
    return {
      date,
      count,
      minutes: day?.minutes ?? 0,
      level: intensityLevel(count),
      future: false,
    } satisfies HeatmapCell;
  });

  return {
    days,
    totalSessions: days.reduce((sum, day) => sum + day.count, 0),
    activeDays: days.filter((day) => day.count > 0).length,
    totalMinutes: days.reduce((sum, day) => sum + day.minutes, 0),
  };
}
