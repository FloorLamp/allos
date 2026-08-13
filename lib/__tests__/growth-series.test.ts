import { describe, it, expect } from "vitest";
import {
  buildGrowthProfile,
  bmiSeriesDatePaired,
  displayWeightGrowth,
  growthBadge,
  PAIRED_HEIGHT_INTERVAL_DAYS,
} from "../growth-series";
import type { LifeStage } from "../life-stage";
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

describe("fractional age keeps same-month measurements distinct (issue #405)", () => {
  it("plots every weigh-in in one calendar month, not just the last", () => {
    const p = buildGrowthProfile({
      sex: "male",
      birthdate: "2024-01-01",
      today: "2024-04-01",
      heights: [],
      // Four weigh-ins all in month 2 (age ~2 whole months) — must stay 4 points.
      weights: [
        { date: "2024-03-04", value: 6.0 },
        { date: "2024-03-11", value: 6.1 },
        { date: "2024-03-18", value: 6.2 },
        { date: "2024-03-25", value: 6.3 },
      ],
    });
    const weight = p!.metrics.find((m) => m.metric === "weight")!;
    expect(weight.points).toHaveLength(4);
    // Whole-month age is the same (2) for all — the scoring input.
    expect(weight.points.map((pt) => pt.ageMonths)).toEqual([2, 2, 2, 2]);
    // …but the fractional ages are strictly increasing, so they don't collapse.
    const xs = weight.points.map((pt) => pt.ageMonthsExact);
    expect(new Set(xs).size).toBe(4);
    for (let i = 1; i < xs.length; i++)
      expect(xs[i]).toBeGreaterThan(xs[i - 1]);
  });
});

describe("out-of-range point keeps the axis + points (issue #405)", () => {
  it("extends maxMonths to cover a head-circ measured past the WHO 0–24mo band", () => {
    const p = buildGrowthProfile({
      sex: "male",
      birthdate: "2022-01-01",
      today: "2024-08-01",
      heights: [],
      weights: [],
      // 30 months — beyond WHO head-circ range (0–24), still a real US measurement.
      headCircs: [
        { date: "2022-07-01", value: 44 }, // ~6 mo (in range)
        { date: "2024-07-01", value: 50 }, // ~30 mo (out of band range)
      ],
    });
    const hc = p!.metrics.find((m) => m.metric === "head_circumference")!;
    // Both measurements are still plotted (nothing dropped).
    expect(hc.points).toHaveLength(2);
    // The axis now extends to cover the 30-month point (was clamped to 24).
    expect(hc.maxMonths).toBeGreaterThan(24);
    expect(hc.maxMonths).toBeGreaterThanOrEqual(
      hc.points[hc.points.length - 1].ageMonthsExact
    );
    // Bands still exist and clamp to their own reference range (≤ 24 mo).
    expect(hc.bands.length).toBeGreaterThan(0);
    for (const band of hc.bands) {
      for (const bp of band.points)
        expect(bp.ageMonths).toBeLessThanOrEqual(24);
    }
  });
});

describe("bmiSeriesDatePaired (issue #407)", () => {
  it("pairs each weigh-in with the height in effect on/before that date", () => {
    const out = bmiSeriesDatePaired(
      [
        { date: "2025-01-01", value: 16 }, // height 1.00 m → BMI 16
        { date: "2025-07-01", value: 18.375 }, // height 1.05 m → BMI ~16.67
      ],
      [
        { date: "2024-12-01", value: 100 },
        { date: "2025-06-01", value: 105 },
      ],
      null
    );
    expect(out).toHaveLength(2);
    expect(out[0].value).toBeCloseTo(16, 2);
    expect(out[1].value).toBeCloseTo(18.375 / 1.05 ** 2, 2);
  });

  it("skips a weigh-in with no prior height (no BMI derivable)", () => {
    const out = bmiSeriesDatePaired(
      [{ date: "2025-01-01", value: 16 }],
      [{ date: "2025-06-01", value: 100 }],
      null
    );
    expect(out).toEqual([]);
  });

  it("sorts defensively (unordered input still date-pairs correctly)", () => {
    const out = bmiSeriesDatePaired(
      [
        { date: "2025-07-01", value: 18.375 },
        { date: "2025-01-01", value: 16 },
      ],
      [
        { date: "2025-06-01", value: 105 },
        { date: "2024-12-01", value: 100 },
      ],
      null
    );
    expect(out.map((p) => p.date)).toEqual(["2025-01-01", "2025-07-01"]);
    expect(out[0].value).toBeCloseTo(16, 2);
  });
});

// #2646 decision 1 — the staleness bound on the height #407 pairs backward.
//
// #407's rule ("the height in EFFECT on or before this weigh-in") is right and is
// asserted unchanged above; what it never said is how far back "in effect" reaches.
// For an adult that is forever, and must stay forever. For a growing child it is not:
// BMI is kg/m², so a height that is months out of date understates the denominator
// and the missing growth arrives on the chart as FATNESS — always in that direction.
describe("bmiSeriesDatePaired height staleness bound (issue #2646)", () => {
  // 60 kg at 1.70 m — the paired height is two years old, which for an adult is
  // simply the truth: adults do not grow, and dropping these points would delete the
  // BMI history of the population that has the most of it.
  it("pairs an adult weigh-in with a two-year-old height", () => {
    const out = bmiSeriesDatePaired(
      [{ date: "2026-01-01", value: 60 }],
      [{ date: "2024-01-01", value: 170 }],
      "1990-03-04"
    );
    expect(out).toHaveLength(1);
    expect(out[0].value).toBeCloseTo(60 / 1.7 ** 2, 2);
  });

  // The same shape for a toddler, and the answer is the opposite one. A length
  // measured two years ago belongs to a different child; the honest output is NO
  // point, not a wrong one.
  it("drops a toddler weigh-in whose only height is two years old", () => {
    expect(
      bmiSeriesDatePaired(
        [{ date: "2026-01-01", value: 12 }],
        [{ date: "2024-01-01", value: 76 }],
        "2023-06-01"
      )
    ).toEqual([]);
  });

  // …and keeps the SAME toddler's point when the length was taken at the same visit,
  // so the bound removes wrong points rather than the metric.
  it("keeps a toddler weigh-in paired with a same-visit length", () => {
    const out = bmiSeriesDatePaired(
      [{ date: "2026-01-01", value: 12 }],
      [{ date: "2026-01-01", value: 88 }],
      "2023-06-01"
    );
    expect(out).toHaveLength(1);
    expect(out[0].value).toBeCloseTo(12 / 0.88 ** 2, 2);
  });

  // The bound is per LIFE STAGE, and the stages differ. An infant's clock is a
  // quarter and a child's is six months, so one height age lands on opposite sides of
  // the two — which is the whole reason the interval is declared per member rather
  // than as one number.
  it("resolves the interval by life stage, not by one global number", () => {
    const weights = [{ date: "2026-01-01", value: 12 }];
    const heights = [{ date: "2025-09-01", value: 80 }]; // 122 days earlier
    // Infant on the weigh-in date (7 months): 122 > 92, so the pairing is refused.
    expect(bmiSeriesDatePaired(weights, heights, "2025-06-01")).toEqual([]);
    // Child on the weigh-in date (4 years): 122 <= 183, so it stands.
    expect(bmiSeriesDatePaired(weights, heights, "2021-06-01")).toHaveLength(1);
  });

  // Age is resolved AS OF THE WEIGH-IN (#2090), never today. This profile is an adult
  // now and was an infant at the first weigh-in, and the infant clock is the one that
  // must apply there — reading age "now" would silently unbind a whole childhood.
  it("resolves age on the weigh-in date, not on the newest row", () => {
    const out = bmiSeriesDatePaired(
      [
        { date: "2006-01-01", value: 8 }, // infant: height 5 months stale → dropped
        { date: "2026-01-01", value: 70 }, // adult: same 5-month gap → kept
      ],
      [
        { date: "2005-08-01", value: 66 },
        { date: "2025-08-01", value: 178 },
      ],
      "2005-06-01"
    );
    expect(out.map((p) => p.date)).toEqual(["2026-01-01"]);
  });

  // Boundary, inherited from `freshnessState`: stale STRICTLY after the interval, so
  // a height exactly one interval old is still current and comes due the next day.
  it("treats a height exactly one interval old as still usable", () => {
    const born = "2023-06-01"; // a child throughout
    const at = (heightDate: string) =>
      bmiSeriesDatePaired(
        [{ date: "2026-01-01", value: 15 }],
        [{ date: heightDate, value: 95 }],
        born
      );
    expect(at("2025-07-02")).toHaveLength(1); // 183 days — current
    expect(at("2025-07-01")).toEqual([]); // 184 days — due
  });

  // Unknown birthdate follows lib/life-stage.ts's documented policy: restrict only on
  // a POSITIVE under-age match, never on missing data. So an unknown-age profile keeps
  // #407's behaviour exactly, which is what the three tests above this block assert.
  it("leaves an unknown birthdate unbounded", () => {
    expect(
      bmiSeriesDatePaired(
        [{ date: "2026-01-01", value: 60 }],
        [{ date: "2020-01-01", value: 170 }],
        null
      )
    ).toHaveLength(1);
  });

  // Every life stage answers. A stage added to the model without an interval would
  // otherwise inherit "unbounded" silently — the failure #2643 is about, one registry
  // over.
  it("declares an interval for every life stage", () => {
    const stages: LifeStage[] = [
      "infant",
      "child",
      "adolescent",
      "adult",
      "older-adult",
    ];
    expect(Object.keys(PAIRED_HEIGHT_INTERVAL_DAYS).sort()).toEqual(
      [...stages].sort()
    );
    // The growing stages are bounded and the grown ones are not — the substantive
    // claim, spelled out so a future edit that unbounds a child has to say so here.
    for (const growing of ["infant", "child", "adolescent"] as const) {
      const days = PAIRED_HEIGHT_INTERVAL_DAYS[growing];
      expect(days, growing).not.toBeNull();
      expect(days as number, growing).toBeGreaterThan(0);
    }
    for (const grown of ["adult", "older-adult"] as const)
      expect(PAIRED_HEIGHT_INTERVAL_DAYS[grown], grown).toBeNull();
  });

  // The shared function moved, so the growth card moves with it — that is the point
  // of decision 1, and it is asserted through buildGrowthProfile rather than inferred.
  it("carries the bound into the growth card's BMI trajectory", () => {
    const common = {
      sex: "female" as const,
      birthdate: "2023-06-01",
      today: "2026-07-01",
      weights: [{ date: "2026-06-01", value: 14 }],
    };
    const stale = buildGrowthProfile({
      ...common,
      heights: [{ date: "2024-01-01", value: 80 }],
    });
    expect(stale?.metrics.find((m) => m.metric === "bmi")?.points).toEqual([]);
    const fresh = buildGrowthProfile({
      ...common,
      heights: [{ date: "2026-06-01", value: 96 }],
    });
    expect(fresh?.metrics.find((m) => m.metric === "bmi")?.points).toHaveLength(
      1
    );
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
      {
        date: "2026-07-01",
        ageMonths: 18,
        ageMonthsExact: 18,
        value: 10.9,
        percentile: 42,
      },
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
