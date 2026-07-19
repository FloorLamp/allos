// Pure N-week consistency trend for a tracked food habit (issue #954) — DB-free so
// it's unit-tested (lib/__tests__). The tracked-habits card asks the long-range
// question a habit tracker exists to answer: "is this habit actually STICKING?" Each
// food-group target gains a small trailing-N-week strip of met/short/empty cells so a
// target that's been missed three weeks running looks different from one green for two
// months.
//
// DECIDED (#954): tracked habits ONLY — reflection on commitments the user made, NOT
// a browsable food diary (no calendar heatmap, no date picker). This module classifies
// per-week outcomes over the SAME weekly rollup the this-week progress uses (extended
// over N weeks), so the current-week cell can never disagree with the this-week
// progress (one computation, #221). The past weeks render OUTCOMES; frequencyPace keeps
// owning the current week's projection — the two share the week definition, not code.

import {
  DEFAULT_FORMAT_PREFS,
  formatMonthDay,
  type DisplayFormatPrefs,
} from "./format-date";
import type { TrailingWeek } from "./week-window";

// How many trailing weeks the strip shows (~two months of daily-habit history).
export const HABIT_TREND_WEEKS = 8;

// One week's verdict:
//   met      — a past (or current) week that hit the target.
//   short    — a past week with some servings but below target.
//   empty    — a past week with zero servings.
//   current  — the in-progress current week, not yet met (rendered in-progress, NEVER
//              "failed" — you still have days left).
//   na       — a week entirely BEFORE the target existed: not-applicable, an honest
//              cold start (never a miss). A habit created two weeks ago shows a short
//              history, not six failures.
export type HabitWeekVerdict = "met" | "short" | "empty" | "current" | "na";

export interface HabitWeekCell {
  start: string;
  end: string;
  count: number;
  target: number;
  verdict: HabitWeekVerdict;
  // Tooltip/label per cell (#954 §2.4): "Jun 30 – Jul 6 · 1 of 2", or a cold-start
  // note for a not-applicable week.
  label: string;
}

// Classify each trailing week for one habit target. `countForWeek` returns the group's
// servings summed over a week's window (the #579 rollup extended over N weeks — the
// caller supplies it from the same food_log SUM the this-week progress uses).
// `createdDate` is the target's creation day (YYYY-MM-DD); a week whose whole window
// precedes it is not-applicable. Pure: no clock, no DB.
export function foodHabitTrendCells(
  weeks: TrailingWeek[],
  countForWeek: (week: TrailingWeek) => number,
  perWeek: number,
  createdDate: string,
  prefs: DisplayFormatPrefs = DEFAULT_FORMAT_PREFS
): HabitWeekCell[] {
  return weeks.map((week) => {
    const count = countForWeek(week);
    const range = `${formatMonthDay(week.start, prefs)} – ${formatMonthDay(
      week.end,
      prefs
    )}`;
    // A week is applicable once the target existed for ANY part of it (its window
    // overlaps [createdDate, ∞)). Weeks entirely before creation are N/A.
    const applicable = week.end >= createdDate;
    let verdict: HabitWeekVerdict;
    if (!applicable) verdict = "na";
    else if (week.isCurrent) verdict = count >= perWeek ? "met" : "current";
    else if (count >= perWeek) verdict = "met";
    else if (count > 0) verdict = "short";
    else verdict = "empty";
    const label =
      verdict === "na"
        ? `${range} · not tracked yet`
        : `${range} · ${count} of ${perWeek}`;
    return {
      start: week.start,
      end: week.end,
      count,
      target: perWeek,
      verdict,
      label,
    };
  });
}
