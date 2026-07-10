import { describe, it, expect } from "vitest";
import {
  buildGrowthProfile,
  displayWeightGrowth,
  growthBadge,
} from "../growth-series";
import { kgTo } from "../units";

describe("buildGrowthProfile degradation", () => {
  const base = {
    today: "2026-07-06",
    heights: [{ date: "2026-07-01", value: 90 }],
    weights: [{ date: "2026-07-01", value: 13 }],
  };
  it("returns null when sex is unknown", () => {
    expect(
      buildGrowthProfile({ ...base, sex: null, birthdate: "2023-01-01" })
    ).toBeNull();
  });
  it("returns null when birthdate is unknown", () => {
    expect(
      buildGrowthProfile({ ...base, sex: "male", birthdate: null })
    ).toBeNull();
  });
  it("returns null for an out-of-range (adult) age", () => {
    expect(
      buildGrowthProfile({ ...base, sex: "male", birthdate: "1980-01-01" })
    ).toBeNull();
  });
  it("builds for an in-range child", () => {
    const p = buildGrowthProfile({
      ...base,
      sex: "male",
      birthdate: "2023-07-01",
    });
    expect(p).not.toBeNull();
    expect(p!.sex).toBe("male");
    expect(p!.metrics.map((m) => m.metric).sort()).toEqual([
      "bmi",
      "head_circumference",
      "height",
      "weight",
    ]);
  });
});

describe("head circumference (WHO 0–24 mo)", () => {
  it("plots head-circ samples at the age they were taken and scores a percentile", () => {
    const p = buildGrowthProfile({
      sex: "male",
      birthdate: "2024-01-15",
      today: "2026-07-06",
      heights: [],
      weights: [],
      // Two head-circ readings ~a year apart: ages ~6 mo and ~18 mo (both WHO range).
      headCircs: [
        { date: "2024-07-15", value: 43.3 },
        { date: "2025-07-15", value: 47.4 },
      ],
    });
    const hc = p!.metrics.find((m) => m.metric === "head_circumference")!;
    expect(hc.points.map((pt) => pt.ageMonths)).toEqual([6, 18]);
    for (const pt of hc.points) expect(pt.percentile).not.toBeNull();
    // WHO-only reference band draws over the covered 0–24 mo window.
    expect(hc.bands.length).toBeGreaterThan(0);
    expect(hc.maxMonths).toBeLessThanOrEqual(24);
  });

  it("is an empty series when there are no head-circ samples (chart hides)", () => {
    const p = buildGrowthProfile({
      sex: "female",
      birthdate: "2024-01-15",
      today: "2025-01-15",
      heights: [{ date: "2024-07-15", value: 67 }],
      weights: [],
    });
    const hc = p!.metrics.find((m) => m.metric === "head_circumference")!;
    expect(hc.points).toEqual([]);
  });
});

describe("age on the measurement date", () => {
  it("plots each measurement at the age it was taken, not today", () => {
    const p = buildGrowthProfile({
      sex: "female",
      birthdate: "2024-01-15",
      today: "2026-07-06",
      // Two heights ~a year apart: ages should be ~6 mo and ~18 mo.
      heights: [
        { date: "2024-07-15", value: 67 },
        { date: "2025-07-15", value: 80 },
      ],
      weights: [],
    });
    const height = p!.metrics.find((m) => m.metric === "height")!;
    expect(height.points.map((pt) => pt.ageMonths)).toEqual([6, 18]);
    // Every point carries a percentile (both ages are in WHO range).
    for (const pt of height.points) expect(pt.percentile).not.toBeNull();
    // Newest measurement is the badge's "latest".
    expect(height.latest!.ageMonths).toBe(18);
  });
});

describe("BMI trajectory pairs each weight with the height then in effect", () => {
  it("derives BMI from weight + the latest prior height", () => {
    const p = buildGrowthProfile({
      sex: "male",
      birthdate: "2020-01-01",
      today: "2026-07-06",
      heights: [{ date: "2025-01-01", value: 110 }], // 1.10 m at age 5
      weights: [{ date: "2025-06-01", value: 19.36 }], // ~16 BMI
    });
    const bmi = p!.metrics.find((m) => m.metric === "bmi")!;
    expect(bmi.points).toHaveLength(1);
    expect(bmi.points[0].value).toBeCloseTo(16, 1);
    expect(bmi.points[0].percentile).not.toBeNull();
  });
});

describe("growthBadge", () => {
  it("is null for a null profile", () => {
    expect(growthBadge(null)).toBeNull();
  });
  it("surfaces the latest percentile per metric", () => {
    const p = buildGrowthProfile({
      sex: "female",
      birthdate: "2023-07-06",
      today: "2026-07-06",
      heights: [{ date: "2026-07-06", value: 96 }],
      weights: [{ date: "2026-07-06", value: 14 }],
    });
    const badge = growthBadge(p);
    expect(badge).not.toBeNull();
    expect(badge!.heightPercentile).toBeGreaterThan(0);
    expect(badge!.weightPercentile).toBeGreaterThan(0);
    expect(badge!.bmiPercentile).toBeGreaterThan(0);
  });
});

describe("displayWeightGrowth (issue #194)", () => {
  const series = {
    bands: [
      {
        percentile: 50,
        points: [
          { ageMonths: 12, value: 9 },
          { ageMonths: 18, value: 10 },
        ],
      },
    ],
    points: [
      { date: "2026-07-01", ageMonths: 18, value: 10.9, percentile: 42 },
    ],
  };

  it("is a no-op for kg (same references)", () => {
    const out = displayWeightGrowth(series, "kg");
    expect(out.bands).toBe(series.bands);
    expect(out.points).toBe(series.points);
  });

  it("converts BANDS and POINTS together for lb", () => {
    const out = displayWeightGrowth(series, "lb");
    expect(out.bands[0].points[0].value).toBeCloseTo(kgTo(9, "lb"), 9);
    expect(out.bands[0].points[1].value).toBeCloseTo(kgTo(10, "lb"), 9);
    expect(out.points[0].value).toBeCloseTo(kgTo(10.9, "lb"), 9);
  });

  it("preserves percentile fields (computed in kg upstream)", () => {
    const out = displayWeightGrowth(series, "lb");
    expect(out.points[0].percentile).toBe(42);
    expect(out.bands[0].percentile).toBe(50);
  });

  it("does not mutate the input series", () => {
    displayWeightGrowth(series, "lb");
    expect(series.points[0].value).toBe(10.9);
    expect(series.bands[0].points[0].value).toBe(9);
  });
});
