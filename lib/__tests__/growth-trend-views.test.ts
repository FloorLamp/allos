import { describe, expect, it } from "vitest";
import { buildGrowthTrendPresentation } from "@/lib/growth-trend-views";
import { kgTo } from "@/lib/units";

const input = {
  sex: "female" as const,
  birthdate: "2020-01-15",
  today: "2026-07-27",
  heights: [
    { date: "2025-01-15", value: 108 },
    { date: "2026-01-15", value: 114 },
  ],
  weights: [
    { date: "2025-01-15", value: 18 },
    { date: "2026-01-15", value: 20 },
  ],
  headCircs: [],
};

describe("buildGrowthTrendPresentation", () => {
  it("builds the shared title-cased WHO/CDC views for an eligible child", () => {
    const result = buildGrowthTrendPresentation({
      ...input,
      weightUnit: "kg",
    });

    expect(result).not.toBeNull();
    expect(result!.source).toBe("CDC");
    expect(result!.views.map((view) => view.label)).toEqual([
      "Height",
      "Weight",
      "Body Mass Index",
      "Head Circumference",
    ]);
    expect(result!.views.map((view) => view.percentileTitle)).toEqual([
      "Height Percentile",
      "Weight Percentile",
      "Body Mass Index Percentile",
      "Head Circumference Percentile",
    ]);
    expect(
      result!.views.slice(0, 3).every((view) => view.latestPercentile != null)
    ).toBe(true);
    expect(result!.views[3].latestPercentile).toBeNull();
  });

  it("converts weight bands and points without changing their percentiles", () => {
    const kg = buildGrowthTrendPresentation({
      ...input,
      weightUnit: "kg",
    })!;
    const lb = buildGrowthTrendPresentation({
      ...input,
      weightUnit: "lb",
    })!;
    const kgWeight = kg.views.find((view) => view.metric === "weight")!;
    const lbWeight = lb.views.find((view) => view.metric === "weight")!;

    expect(lbWeight.unit).toBe(" lb");
    expect(lbWeight.points[0].value).toBeCloseTo(
      kgTo(kgWeight.points[0].value, "lb")
    );
    expect(lbWeight.latestPercentile).toBe(kgWeight.latestPercentile);
  });

  it("keeps four chart identities while windowing every trajectory", () => {
    const result = buildGrowthTrendPresentation({
      ...input,
      weightUnit: "kg",
      range: { from: "2024-01-01", to: "2024-12-31" },
    })!;

    expect(result.views).toHaveLength(4);
    expect(result.views.every((view) => view.points.length === 0)).toBe(true);
    expect(result.views.every((view) => view.latestPercentile == null)).toBe(
      true
    );
  });

  // #2803: a toddler HAS a BMI (weight × height, the date-paired derivation) but
  // there is no WHO BMI-for-age table under 24 months, so the percentile is null.
  // The card must say the REFERENCE is missing, not the measurement — the old
  // `bands.length > 0` test said "available" because bandCurves clamps the window
  // up to CDC's floor at month 24 and returns curves the toddler is nowhere near.
  const toddler = {
    sex: "male" as const,
    birthdate: "2024-10-09",
    today: "2026-08-15",
    heights: [{ date: "2026-08-09", value: 84.3 }],
    weights: [{ date: "2026-08-09", value: 11.2 }],
    headCircs: [{ date: "2026-08-09", value: 47.5 }],
    weightUnit: "kg" as const,
  };

  it("reports no reference where the age has no table (#2803)", () => {
    const views = buildGrowthTrendPresentation(toddler)!.views;
    const bmi = views.find((view) => view.metric === "bmi")!;

    expect(bmi.latestPercentile).toBeNull();
    expect(bmi.referenceAvailable).toBe(false);
    // Height/weight/head circumference all have a WHO table at 22 months.
    for (const metric of ["height", "weight", "head_circumference"]) {
      const view = views.find((v) => v.metric === metric)!;
      expect(view.referenceAvailable).toBe(true);
      expect(view.referenceSource).toBe("WHO");
      expect(view.latestPercentile).not.toBeNull();
    }
  });

  it("names the reference the scored measurement actually used", () => {
    // The reading was taken at 20 months (WHO); the child is 25 months now. The
    // card is about the reading, so it names WHO — not the table today's age lands in.
    const straddling = buildGrowthTrendPresentation({
      ...toddler,
      today: "2026-11-20",
    })!;
    expect(straddling.currentAgeMonths).toBe(25);
    expect(
      straddling.views.find((view) => view.metric === "height")!.referenceSource
    ).toBe("WHO");
  });

  it("still blames the date range when a reference does exist", () => {
    const windowed = buildGrowthTrendPresentation({
      ...input,
      weightUnit: "kg",
      range: { from: "2024-01-01", to: "2024-12-31" },
    })!;
    const height = windowed.views.find((view) => view.metric === "height")!;
    expect(height.latestPercentile).toBeNull();
    expect(height.referenceAvailable).toBe(true);
  });

  it("returns null outside pediatric chart eligibility", () => {
    expect(
      buildGrowthTrendPresentation({
        ...input,
        birthdate: "1980-01-15",
        weightUnit: "kg",
      })
    ).toBeNull();
  });
});
