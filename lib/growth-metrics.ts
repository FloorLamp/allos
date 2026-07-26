// Pure, age-aware MEMBERSHIP for the Trends → Body tab (no DB, no React) —
// unit-tested in lib/__tests__/growth-metrics.test.ts. For a growth-tracked profile,
// HEIGHT is the priority datapoint and body fat % is not tracked, so the Body tab
// charts height (and head circumference for the very young) and drops the body-fat
// chart/tile. Adults keep weight + body fat. Keeping this a pure decision function
// lets both the Body section and the Overview metric tiles (which body measures to
// show) share one age rule.
//
// #1490 took the ORDER half away: the growth-percentile card leading the stack for a
// child is now the life-stage signal of the tab's one card ranker
// (lib/trends-card-rank.ts), not a `growthCardFirst` flag here. This module answers
// "which charts exist", never "in what sequence".
//
// The line is `isGrowthTracked` from lib/life-stage — the WHO/CDC growth-chart data
// ceiling (< 20 y / 240 mo). This converges the Body tab's two former ceilings — the
// fixed-18 "minor" layout line and the 240-month chart-data ceiling — onto the single
// line the charts actually span (#492), so an 18–19-year-old keeps the growth-led view
// instead of an adult layout with a demoted trailing growth card. The adult-population
// STATISTICAL surfaces (fitness norms, bio-age, eGFR) keep their own 18 floor
// (ADULT_MIN_AGE) — those are validated-in-adults numbers, a distinct named member.

import { isGrowthTracked } from "./life-stage";

// Re-export so Body-tab consumers and tests read the one shared predicate. The
// growth-led presentation (layout order, body-fat drop, growth card, quick-add) all
// key on this single line.
export { isGrowthTracked, GROWTH_CHART_MAX_AGE } from "./life-stage";

// Head circumference is a pediatric-only measure. The WHO head-circ-for-age chart
// runs 0–24 mo; we surface manual ENTRY a little past that (through 35 mo) so a
// parent measuring a ~2-year-old can still log it — an out-of-chart-range value
// simply ages out of the percentile curve gracefully (chartForAge returns null),
// exactly like any over-age point.
export const HEAD_CIRC_ENTRY_MAX_AGE_MONTHS = 36;

// Whether the head-circumference entry field should appear: a known age under
// ~3 years (in months). Adults / unknown-age never see it.
export function showHeadCircEntry(
  ageMonths: number | null | undefined
): boolean {
  return (
    ageMonths != null &&
    ageMonths >= 0 &&
    ageMonths < HEAD_CIRC_ENTRY_MAX_AGE_MONTHS
  );
}

// The manual growth quick-add (height + optionally head circ) is a growth-tracked
// affordance. Adults keep the Body tab byte-identical to before.
export function showGrowthQuickAdd(
  ageYears: number | null | undefined
): boolean {
  return isGrowthTracked(ageYears);
}

// Body fat % is a body-composition measure we don't surface for a growing profile —
// for a growth-tracked age it's de-prioritized out of the Body charts, Overview
// tiles, AND (issue #493) the entry field and history column, so "not tracked" is
// consistent across every interactive surface. The raw data export keeps the column
// (a complete-record contract, distinct from the app's display choice).
export function showBodyFat(ageYears: number | null | undefined): boolean {
  return !isGrowthTracked(ageYears);
}

// The body-composition trend charts that the Body section should render for a
// profile. Keys map to concrete chart specs in the section.
export type BodyChartKey =
  "height" | "head_circumference" | "weight" | "bodyfat" | "resting_hr";

export interface BodyChartPlan {
  // Which charts exist for this age. MEMBERSHIP only — the SEQUENCE is decided by
  // the tab's one card ranker (lib/trends-card-rank.ts, #1490), which took over the
  // "growth card first for a child" fork this plan used to carry as a
  // `growthCardFirst` flag. Two forks deciding one page's order is exactly the
  // duplication #1490 retired, so this array's order is not load-bearing.
  keys: BodyChartKey[];
}

// Decide WHICH body-composition charts a profile gets from its age. For a
// growth-tracked profile, height is charted (with head circ for the very young) and
// body fat is dropped entirely; an adult / unknown age keeps weight + body fat.
export function planBodyCharts(input: {
  ageYears: number | null | undefined;
  ageMonths: number | null | undefined;
}): BodyChartPlan {
  if (!isGrowthTracked(input.ageYears)) {
    return { keys: ["weight", "bodyfat", "resting_hr"] };
  }
  const keys: BodyChartKey[] = ["height"];
  if (showHeadCircEntry(input.ageMonths)) keys.push("head_circumference");
  keys.push("weight", "resting_hr");
  return { keys };
}
