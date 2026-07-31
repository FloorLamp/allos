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
