// Pure MEMBERSHIP for the Trends → Overview → body census (no DB, no React) —
// unit-tested in lib/__tests__/growth-metrics.test.ts. For a growth-tracked profile,
// HEIGHT is the priority datapoint, so the body census charts height (and head
// circumference for the very young). Body composition is governed by the two rules
// below — entry by life stage, display by data presence (#4147). Keeping these pure
// lets the Body section, the Overview tiles and every entry surface share one answer.
//
// #1490 took the ORDER half away: the growth-percentile card leading the stack for a
// child is now the life-stage signal of the tab's one card ranker
// (lib/trends-card-rank.ts), not a `growthCardFirst` flag here. This module answers
// "which charts exist", never "in what sequence".
//
// The line is `isGrowthTracked` from lib/life-stage — the WHO/CDC growth-chart data
// ceiling (< 20 y / 240 mo). This converges the body census two former ceilings — the
// fixed-18 "minor" layout line and the 240-month chart-data ceiling — onto the single
// line the charts actually span (#492), so an 18–19-year-old keeps the growth-led view
// instead of an adult layout with a demoted trailing growth card. The adult-population
// STATISTICAL surfaces (fitness norms, bio-age, eGFR) keep their own 18 floor
// (ADULT_MIN_AGE) — those are validated-in-adults numbers, a distinct named member.

import { isGrowthTracked } from "./life-stage";

// Re-export so body-census consumers and tests read the one shared predicate. The
// growth-led presentation (layout order, composition entry, growth card, quick-add)
// all key on this single line.
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
// affordance. Adults keep the body census byte-identical to before.
export function showGrowthQuickAdd(
  ageYears: number | null | undefined
): boolean {
  return isGrowthTracked(ageYears);
}

// ── Body composition for a growing profile: two rules, not one (#4147) ───────
//
// #493 hid body fat % from a growth-tracked profile everywhere at once — charts,
// tiles, entry field, history column — which was one rule doing two jobs. #4132
// exposed it by adding lean and bone mass ungated, so a child's form offered two
// numbers off a DEXA report while the third was deliberately absent.
//
// ENTRY is a life-stage question. Manual composition entry — body fat %, lean mass,
// bone mass — is closed for a growth-tracked profile as a CLASS: the app never
// prompts a child's profile for a composition figure. A caregiver holding a real
// report uploads it instead; document import already extracts every composition
// number on the page (lib/medical-extract/prompt.ts). Adults are untouched.
export function showCompositionEntry(
  ageYears: number | null | undefined
): boolean {
  return !isGrowthTracked(ageYears);
}

// DISPLAY is a data question. A figure the family's own report states was never
// protected by being hidden, so composition values show wherever they exist. What
// #493's hiding still governs is the NO-DATA state: no empty chart slot, no
// affordance offering a number this profile has never had and cannot type in. Its
// export contract is untouched — the raw export keeps the column either way.
//
// THE NO-DATA HALF IS DELIBERATELY NOT APPLIED TO ADULTS (ruled 2026-09-02). Reading
// "absence renders no affordance" as universal would hide an empty body-fat tile from
// an adult too — and for an adult that tile is not empty of purpose, it is the door to
// the metric they CAN type in. So the data question only ever removes an affordance
// from a profile that has no way to fill it.
export function showBodyFatDisplay(
  ageYears: number | null | undefined,
  hasData: boolean
): boolean {
  return hasData || showCompositionEntry(ageYears);
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

// Decide WHICH body-composition charts a profile gets. Life stage adds the growth
// pair (height, and head circ for the very young); body fat follows the display rule
// above. `hasBodyFat` is asked of the caller because this module is pure — the
// section already holds the series it would otherwise read twice.
export function planBodyCharts(input: {
  ageYears: number | null | undefined;
  ageMonths: number | null | undefined;
  hasBodyFat: boolean;
}): BodyChartPlan {
  const keys: BodyChartKey[] = [];
  if (isGrowthTracked(input.ageYears)) {
    keys.push("height");
    if (showHeadCircEntry(input.ageMonths)) keys.push("head_circumference");
  }
  keys.push("weight");
  if (showBodyFatDisplay(input.ageYears, input.hasBodyFat))
    keys.push("bodyfat");
  keys.push("resting_hr");
  return { keys };
}
