// Pure, age-aware layout for the Trends → Body tab (no DB, no React) — unit-tested
// in lib/__tests__/growth-metrics.test.ts. For a child, HEIGHT is the priority
// datapoint and body fat % is not tracked, so the Body tab reorders itself: the
// growth-percentile card leads, height (and head circumference for the very young)
// is charted, and the body-fat chart/tile is dropped. Adults keep the original
// weight / body fat / resting-HR layout unchanged. Keeping this a pure decision
// function lets both the Body section (chart order) and the Overview metric tiles
// (which body measures to show) share one age rule.

// A profile under this age (whole years) is treated as a child for the Body tab.
// 18 is the WHO/CDC growth-chart ceiling age too, so a minor is always plausibly in
// (or just past) chart range.
export const MINOR_MAX_AGE_YEARS = 18;

// Head circumference is a pediatric-only measure. The WHO head-circ-for-age chart
// runs 0–24 mo; we surface manual ENTRY a little past that (through 35 mo) so a
// parent measuring a ~2-year-old can still log it — an out-of-chart-range value
// simply ages out of the percentile curve gracefully (chartForAge returns null),
// exactly like any over-age point.
export const HEAD_CIRC_ENTRY_MAX_AGE_MONTHS = 36;

// True only when the age is KNOWN and below the child ceiling. An unknown age
// (no birthdate and no stored-age fallback) is treated as an adult — we don't
// restructure the Body tab on missing data, only on a positive under-age match.
export function isMinor(ageYears: number | null | undefined): boolean {
  return ageYears != null && ageYears < MINOR_MAX_AGE_YEARS;
}

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

// The manual growth quick-add (height + optionally head circ) is a child-only
// affordance. Adults keep the Body tab byte-identical to before.
export function showGrowthQuickAdd(
  ageYears: number | null | undefined
): boolean {
  return isMinor(ageYears);
}

// Body fat % is a body-composition measure we don't surface for children — for a
// minor it's de-prioritized out of the Body charts and Overview tiles entirely.
export function showBodyFat(ageYears: number | null | undefined): boolean {
  return !isMinor(ageYears);
}

// The body-composition trend charts, in priority order, that the Body section
// should render for a profile. Keys map to concrete chart specs in the section.
export type BodyChartKey =
  "height" | "head_circumference" | "weight" | "bodyfat" | "resting_hr";

export interface BodyChartPlan {
  // Ordered chart keys to render (highest priority first).
  keys: BodyChartKey[];
  // Render the WHO/CDC growth-percentile card ABOVE the body-composition charts
  // (true for a child — the percentile view is the headline for a kid).
  growthCardFirst: boolean;
}

// Decide the Body tab's chart order from the profile's age. For a child, height
// leads (with head circ for the very young), body fat is dropped, and the growth
// card floats to the top. For an adult / unknown age, the original
// weight → body fat → resting-HR order is preserved exactly.
export function planBodyCharts(input: {
  ageYears: number | null | undefined;
  ageMonths: number | null | undefined;
}): BodyChartPlan {
  if (!isMinor(input.ageYears)) {
    return {
      keys: ["weight", "bodyfat", "resting_hr"],
      growthCardFirst: false,
    };
  }
  const keys: BodyChartKey[] = ["height"];
  if (showHeadCircEntry(input.ageMonths)) keys.push("head_circumference");
  keys.push("weight", "resting_hr");
  return { keys, growthCardFirst: true };
}
