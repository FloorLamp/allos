// Pure formatters behind the Trends → Nutrition OVER-TIME view (issue #1166). DB-free
// so they're unit-tested (lib/__tests__). Each is a formatter over an EXISTING gather —
// no second engine (#221):
//   - buildMacroFiberSeries: merges the tracked macro/fiber daily totals
//     (getMetricDailyTotals for protein_g/carbs_g/fat_g/fiber_g) into one dated series
//     for the stacked chart the tab inherits from Trends → Body (Part 1).
//   - aggregateFoodAdherenceByWeek: rolls the per-habit #954 consistency cells
//     (getFoodHabitTrends) up into an OVERALL weekly hit-rate — "am I consistently
//     hitting my food-group goals," the trend the point-in-time AdherenceFindings on
//     /nutrition doesn't show (Part 2).
//   - NUTRITION_HISTORY_WEEK_CAPS: the lens week caps for the intake history
//     (Part 3), which is the generalized day-history calendar + matrix
//     (lib/day-history.ts) over food servings + confirmed doses — each day
//     linking INTO the Timeline. Nutrition-scoped, never a chronological
//     all-domain feed.

import type { HabitWeekCell } from "./food-habit-trend";
import type { LensWeekCaps } from "./trends";

// ---- Part 1: macros + fiber daily series ----------------------------------

// One day's tracked macronutrient totals (whole grams). The stacked chart draws the
// four series; fiber is the previously-uncharted signal (#976 computes it, this surfaces
// its daily total alongside the macros).
export interface MacroFiberDay {
  date: string; // full YYYY-MM-DD (the chart slices to MM-DD for the axis)
  protein: number;
  carbs: number;
  fat: number;
  fiber: number;
  // Index signature so the row is assignable to StackedBarCard's
  // `Record<string, string | number>[]` data prop (a named interface, unlike an inline
  // object literal, gets no implicit index signature).
  [key: string]: string | number;
}

type DatedValue = { date: string; value: number };

function byDate(rows: DatedValue[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of rows) m.set(r.date, r.value);
  return m;
}

const g = (n: number): number => Math.round(n);

// Merge the four tracked daily series into one dated row per day that carries ANY of
// them (a day with only protein logged still renders, its carbs/fat/fiber 0). Sorted
// ascending by date so the chart reads left-to-right oldest→newest.
export function buildMacroFiberSeries(inputs: {
  protein: DatedValue[];
  carbs: DatedValue[];
  fat: DatedValue[];
  fiber: DatedValue[];
}): MacroFiberDay[] {
  const protein = byDate(inputs.protein);
  const carbs = byDate(inputs.carbs);
  const fat = byDate(inputs.fat);
  const fiber = byDate(inputs.fiber);
  const dates = [
    ...new Set([
      ...protein.keys(),
      ...carbs.keys(),
      ...fat.keys(),
      ...fiber.keys(),
    ]),
  ].sort();
  return dates.map((date) => ({
    date,
    protein: g(protein.get(date) ?? 0),
    carbs: g(carbs.get(date) ?? 0),
    fat: g(fat.get(date) ?? 0),
    fiber: g(fiber.get(date) ?? 0),
  }));
}

// ---- Part 2: food-goal adherence trend (weekly hit-rate) ------------------

// One week's overall food-goal hit-rate — how many of the applicable food-group targets
// were MET that week. `applicable` counts targets that already existed and are a settled
// past week (met/short/empty); the in-progress current week counts a target ONLY once it
// has hit its goal (never as a mid-week miss — the #954 "current is never a failure"
// rule), and a week before a target existed is not counted at all.
export interface AdherenceWeek {
  weekStart: string;
  weekEnd: string;
  // The date-range label ("Jun 30 – Jul 6"), taken from the shared per-week cell label
  // so it honors the caller's date-format prefs without this module needing a formatter.
  label: string;
  met: number;
  applicable: number;
  // met / applicable in [0,1], or null when no target was applicable that week (an honest
  // gap, rendered distinctly — never a 0% miss).
  rate: number | null;
}

// Roll the per-habit consistency cells (getFoodHabitTrends → Map<targetId, cells[]>) up
// into a per-week overall hit-rate. Every target shares the SAME trailing-weeks skeleton
// (one weeks array in the gather), so cells align by week start. Weeks are returned
// oldest-first (the gather's order). Empty map → empty array (the profile tracks no food
// habits, so there's no adherence trend to draw).
export function aggregateFoodAdherenceByWeek(
  trends: Map<number, HabitWeekCell[]>
): AdherenceWeek[] {
  const byWeek = new Map<
    string,
    { end: string; label: string; met: number; applicable: number }
  >();
  for (const cells of trends.values()) {
    for (const c of cells) {
      // The applicable set: settled past weeks (met/short/empty) plus a current week that
      // already hit its goal (verdict "met"). "current" (in-progress, not yet met) and
      // "na" (before the target existed) are excluded.
      const counts = c.verdict !== "current" && c.verdict !== "na";
      if (!counts) continue;
      const entry = byWeek.get(c.start) ?? {
        end: c.end,
        // The date range is the cell label up to the " · N of M" tail.
        label: c.label.split(" · ")[0],
        met: 0,
        applicable: 0,
      };
      entry.applicable += 1;
      if (c.verdict === "met") entry.met += 1;
      byWeek.set(c.start, entry);
    }
  }
  return [...byWeek.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([weekStart, v]) => ({
      weekStart,
      weekEnd: v.end,
      label: v.label,
      met: v.met,
      applicable: v.applicable,
      rate: v.applicable > 0 ? v.met / v.applicable : null,
    }));
}

// ---- Part 3: intake history (day-history calendar + matrix) ---------------

// The Nutrition lens's week caps for the intake history — the generalized
// day-history's window is the hub's shared range clamped through these (the
// FITNESS_WEEK_CAPS pattern). Max 13 weeks: a quarter of daily cells stays
// scannable; a wider range keeps its most recent quarter.
export const NUTRITION_HISTORY_WEEK_CAPS: LensWeekCaps = {
  minWeeks: 4,
  maxWeeks: 13,
};
