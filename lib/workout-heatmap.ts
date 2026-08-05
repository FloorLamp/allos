// Workout-density heatmap — pure grid + intensity math (issue #186). The
// GitHub-style contribution calendar of workouts: one cell per day, colored by how
// many sessions were logged that day. The companion to the HR zone work (#159) —
// this answers "how OFTEN", zones answer "how HARD".
//
// CHOSEN INTENSITY METRIC: SESSION COUNT (not minutes). It is the boring, robust
// choice — every activity has a day, but `duration_min` is frequently null (a
// hand-logged strength session often carries no duration), so a minutes scale
// would read half the calendar as "empty" when it wasn't. Total minutes are still
// carried per day for the hover detail; only the color LEVEL is count-driven.
//
// All arithmetic is UTC-anchored calendar math (shiftDateStr / startOfWeekStr), so
// it is DST-immune and timezone-independent. Day bucketing itself already happened
// upstream: `activities.date` is stored as the profile-local calendar day at
// ingest (issue #94), so grouping by it buckets in the profile timezone.
import { lastNDates, weekdayOrder } from "./date";
import { dayGrid, dayGridMonthLabels, gridStartFor } from "./day-grid";

// One profile-local day's workout totals (the grouped query's row shape).
export interface WorkoutDayDensity {
  date: string; // YYYY-MM-DD, profile-local
  count: number; // sessions logged that day
  minutes: number; // total training minutes that day (0 when all durations null)
}

// A single rendered cell. `future` marks trailing padding days after `end` (the
// current week runs past today) — they hold no data and render blank.
export interface HeatmapCell {
  date: string; // YYYY-MM-DD
  count: number;
  minutes: number;
  level: 0 | 1 | 2 | 3 | 4; // color bucket, by session count
  future: boolean;
}

export interface WorkoutHeatmap {
  columns: HeatmapCell[][]; // week columns oldest→newest, each 7 cells top→bottom
  weekdayOrder: number[]; // 0=Sun … 6=Sat, in row order (respects week start)
  monthLabels: { col: number; label: string }[]; // short month name per new-month column
  start: string; // first (top-left) cell date
  end: string; // last real day = "today" in the profile timezone
  totalSessions: number; // sessions across the window
  activeDays: number; // days with ≥1 session
  totalMinutes: number; // training minutes across the window
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

// The top-left cell date of a `weeks`-column heatmap whose LAST column is the week
// containing `end`, given the profile's first weekday. Every column is a full week
// starting on `weekStart`, so the grid always reads as clean week columns.
export function heatmapStart(
  end: string,
  weeks: number,
  weekStart = 0
): string {
  return gridStartFor(end, weeks, weekStart);
}

// Assemble the heatmap grid from the per-day density rows. `weeks` columns
// (default 53 — a hair over a full year, so a trailing 12 months is always fully
// visible) ending on the week of `end`. Pure: no DB, no clock.
//
// An ADAPTER over the shared `dayGrid` (#2042): the grid decides which day sits in
// which cell, this decides what a day means (sessions, minutes, intensity level).
// `future` is the grid's `after` padding under this domain's older name — the
// window starts exactly on a week boundary, so a workout heatmap has no `before`.
export function buildWorkoutHeatmap(
  density: WorkoutDayDensity[],
  end: string,
  weeks = 53,
  weekStart = 0
): WorkoutHeatmap {
  const byDate = new Map(density.map((d) => [d.date, d]));
  const start = heatmapStart(end, weeks, weekStart);
  const grid = dayGrid({ start, end, weekStart, orientation: "week-columns" });

  let totalSessions = 0;
  let activeDays = 0;
  let totalMinutes = 0;

  const columns: HeatmapCell[][] = grid.weeks.map((cells) =>
    cells.map((cell) => {
      const future = cell.position === "after";
      const d = future ? undefined : byDate.get(cell.date);
      const count = d?.count ?? 0;
      const minutes = d?.minutes ?? 0;
      if (count > 0) {
        totalSessions += count;
        activeDays += 1;
        totalMinutes += minutes;
      }
      return {
        date: cell.date,
        count,
        minutes,
        level: intensityLevel(count),
        future,
      } satisfies HeatmapCell;
    })
  );

  return {
    columns,
    weekdayOrder: weekdayOrder(weekStart),
    monthLabels: dayGridMonthLabels(grid),
    start,
    end,
    totalSessions,
    activeDays,
    totalMinutes,
  };
}
