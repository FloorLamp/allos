import { describe, it, expect } from "vitest";
import {
  isMinor,
  showHeadCircEntry,
  showGrowthQuickAdd,
  showBodyFat,
  planBodyCharts,
} from "@/lib/growth-metrics";

describe("isMinor", () => {
  it("is true for a known age under 18", () => {
    expect(isMinor(2)).toBe(true);
    expect(isMinor(17)).toBe(true);
  });
  it("is false at/over 18 and for unknown age", () => {
    expect(isMinor(18)).toBe(false);
    expect(isMinor(40)).toBe(false);
    expect(isMinor(null)).toBe(false);
    expect(isMinor(undefined)).toBe(false);
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
  it("growth quick-add mirrors isMinor", () => {
    expect(showGrowthQuickAdd(3)).toBe(true);
    expect(showGrowthQuickAdd(40)).toBe(false);
  });
  it("body fat is hidden for minors, shown for adults/unknown", () => {
    expect(showBodyFat(3)).toBe(false);
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

  it("never includes body fat for a minor", () => {
    const plan = planBodyCharts({ ageYears: 8, ageMonths: 96 });
    expect(plan.keys).not.toContain("bodyfat");
  });
});
