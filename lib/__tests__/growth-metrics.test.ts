import { describe, it, expect } from "vitest";
import {
  isGrowthTracked,
  GROWTH_CHART_MAX_AGE,
  showHeadCircEntry,
  showGrowthQuickAdd,
  showBodyFat,
  planBodyCharts,
} from "@/lib/growth-metrics";

// The Body tab's growth-led presentation now keys on the WHO/CDC growth-chart data
// ceiling (< 20 y), converging the former fixed-18 layout line with the 240-month
// chart ceiling so an 18–19-year-old keeps the growth-led view (#492).

describe("isGrowthTracked", () => {
  it("is true for a known age under the growth-chart ceiling (20)", () => {
    expect(isGrowthTracked(2)).toBe(true);
    expect(isGrowthTracked(17)).toBe(true);
    // The 18–19 window that used to fall into the adult layout while the growth
    // card still rendered (the #492 demotion) is now growth-tracked.
    expect(isGrowthTracked(18)).toBe(true);
    expect(isGrowthTracked(19)).toBe(true);
    expect(GROWTH_CHART_MAX_AGE).toBe(20);
  });
  it("is false at/over 20 and for unknown age", () => {
    expect(isGrowthTracked(20)).toBe(false);
    expect(isGrowthTracked(40)).toBe(false);
    expect(isGrowthTracked(null)).toBe(false);
    expect(isGrowthTracked(undefined)).toBe(false);
  });
});

describe("showHeadCircEntry", () => {
  it("is true for a known age under 36 months", () => {
    expect(showHeadCircEntry(0)).toBe(true);
    expect(showHeadCircEntry(18)).toBe(true);
    expect(showHeadCircEntry(35)).toBe(true);
  });
  it("is false at/over 36 months or unknown", () => {
    expect(showHeadCircEntry(36)).toBe(false);
    expect(showHeadCircEntry(200)).toBe(false);
    expect(showHeadCircEntry(null)).toBe(false);
  });
});

describe("showGrowthQuickAdd / showBodyFat", () => {
  it("growth quick-add mirrors isGrowthTracked", () => {
    expect(showGrowthQuickAdd(3)).toBe(true);
    expect(showGrowthQuickAdd(19)).toBe(true);
    expect(showGrowthQuickAdd(40)).toBe(false);
  });
  it("body fat is hidden for a growth-tracked age, shown for adults/unknown", () => {
    expect(showBodyFat(3)).toBe(false);
    expect(showBodyFat(19)).toBe(false);
    expect(showBodyFat(20)).toBe(true);
    expect(showBodyFat(40)).toBe(true);
    expect(showBodyFat(null)).toBe(true);
  });
});

describe("planBodyCharts", () => {
  it("keeps the original adult order and body fat", () => {
    expect(planBodyCharts({ ageYears: 40, ageMonths: 480 })).toEqual({
      keys: ["weight", "bodyfat", "resting_hr"],
      growthCardFirst: false,
    });
  });

  it("treats unknown age as an adult", () => {
    expect(planBodyCharts({ ageYears: null, ageMonths: null })).toEqual({
      keys: ["weight", "bodyfat", "resting_hr"],
      growthCardFirst: false,
    });
  });

  it("prioritizes height + head circ for an infant and drops body fat", () => {
    expect(planBodyCharts({ ageYears: 1, ageMonths: 18 })).toEqual({
      keys: ["height", "head_circumference", "weight", "resting_hr"],
      growthCardFirst: true,
    });
  });

  it("prioritizes height (no head circ) for an older child", () => {
    expect(planBodyCharts({ ageYears: 10, ageMonths: 120 })).toEqual({
      keys: ["height", "weight", "resting_hr"],
      growthCardFirst: true,
    });
  });

  it("keeps the growth-led layout for an 18–19-year-old (no demotion, #492)", () => {
    expect(planBodyCharts({ ageYears: 18, ageMonths: 216 })).toEqual({
      keys: ["height", "weight", "resting_hr"],
      growthCardFirst: true,
    });
  });

  it("returns the adult layout at exactly 20 (past the chart ceiling)", () => {
    expect(planBodyCharts({ ageYears: 20, ageMonths: 240 })).toEqual({
      keys: ["weight", "bodyfat", "resting_hr"],
      growthCardFirst: false,
    });
  });

  it("never includes body fat for a growth-tracked profile", () => {
    const plan = planBodyCharts({ ageYears: 8, ageMonths: 96 });
    expect(plan.keys).not.toContain("bodyfat");
  });
});
