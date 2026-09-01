import { describe, it, expect } from "vitest";
import {
  isGrowthTracked,
  GROWTH_CHART_MAX_AGE,
  showHeadCircEntry,
  showGrowthQuickAdd,
  showCompositionEntry,
  showBodyFatDisplay,
  planBodyCharts,
} from "@/lib/growth-metrics";

// The body census growth-led presentation now keys on the WHO/CDC growth-chart data
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

describe("showGrowthQuickAdd / composition entry and display", () => {
  it("growth quick-add mirrors isGrowthTracked", () => {
    expect(showGrowthQuickAdd(3)).toBe(true);
    expect(showGrowthQuickAdd(19)).toBe(true);
    expect(showGrowthQuickAdd(40)).toBe(false);
  });

  // ENTRY is the life-stage half, and it now governs the whole composition class
  // rather than body fat alone (#4147): the app never prompts a growth-tracked
  // profile for body fat, lean mass or bone mass. Adults are unchanged.
  it("closes manual composition entry for a growth-tracked age only", () => {
    expect(showCompositionEntry(3)).toBe(false);
    expect(showCompositionEntry(19)).toBe(false);
    expect(showCompositionEntry(20)).toBe(true);
    expect(showCompositionEntry(40)).toBe(true);
    expect(showCompositionEntry(null)).toBe(true);
  });

  // DISPLAY is the data half. #493 hid body fat from a growing profile
  // unconditionally; that hiding now governs the NO-DATA state only, so an imported
  // DEXA figure shows on the child's own profile. The adult column is the control
  // that this narrowing did not widen into "adults lose their empty affordance".
  it.each([
    { age: 8, hasData: false, shown: false },
    { age: 8, hasData: true, shown: true },
    { age: 19, hasData: false, shown: false },
    { age: 19, hasData: true, shown: true },
    { age: 40, hasData: false, shown: true },
    { age: 40, hasData: true, shown: true },
    { age: null, hasData: false, shown: true },
  ])(
    "shows body fat for age $age with data=$hasData → $shown",
    ({ age, hasData, shown }) => {
      expect(showBodyFatDisplay(age, hasData)).toBe(shown);
    }
  );
});

describe("planBodyCharts", () => {
  // Life stage decides the growth pair; data decides body fat (#4147). The
  // no-data column is the one that moved: it used to be the ONLY answer for a
  // growth-tracked profile, and the has-data column below is the narrowing.
  it.each([
    {
      what: "an adult",
      ageYears: 40 as number | null,
      ageMonths: 480 as number | null,
      hasBodyFat: false,
      keys: ["weight", "bodyfat", "resting_hr"],
    },
    {
      what: "an unknown age, treated as an adult",
      ageYears: null,
      ageMonths: null,
      hasBodyFat: false,
      keys: ["weight", "bodyfat", "resting_hr"],
    },
    {
      what: "exactly 20, past the chart ceiling",
      ageYears: 20,
      ageMonths: 240,
      hasBodyFat: false,
      keys: ["weight", "bodyfat", "resting_hr"],
    },
    {
      what: "an infant with no composition reading",
      ageYears: 1,
      ageMonths: 18,
      hasBodyFat: false,
      keys: ["height", "head_circumference", "weight", "resting_hr"],
    },
    {
      what: "an infant whose imported DEXA gave one",
      ageYears: 1,
      ageMonths: 18,
      hasBodyFat: true,
      keys: ["height", "head_circumference", "weight", "bodyfat", "resting_hr"],
    },
    {
      what: "an older child with no reading (no head circ either)",
      ageYears: 10,
      ageMonths: 120,
      hasBodyFat: false,
      keys: ["height", "weight", "resting_hr"],
    },
    {
      what: "an older child with a reading",
      ageYears: 10,
      ageMonths: 120,
      hasBodyFat: true,
      keys: ["height", "weight", "bodyfat", "resting_hr"],
    },
    {
      what: "an 18–19-year-old, still growth-tracked (#492)",
      ageYears: 18,
      ageMonths: 216,
      hasBodyFat: false,
      keys: ["height", "weight", "resting_hr"],
    },
  ])("charts $what", ({ ageYears, ageMonths, hasBodyFat, keys }) => {
    expect(planBodyCharts({ ageYears, ageMonths, hasBodyFat })).toEqual({
      keys,
    });
  });
});
