import { describe, it, expect } from "vitest";
import {
  lmsToZ,
  zToValue,
  zToPercentile,
  percentileToZ,
  chartForAge,
  lmsAtAge,
  lmsFor,
  measurementPercentile,
  bmiFrom,
  bandCurves,
  BAND_PERCENTILES,
  MAX_AGE_MONTHS,
} from "../growth";

describe("lmsToZ", () => {
  it("uses the power form when L ≠ 0 (L=1 reduces to a linear z)", () => {
    // L=1: z = ((X/M)^1 − 1)/(1·S) = (X/M − 1)/S.
    expect(lmsToZ(11, { L: 1, M: 10, S: 0.1 })!).toBeCloseTo(1, 10);
    expect(lmsToZ(9, { L: 1, M: 10, S: 0.1 })!).toBeCloseTo(-1, 10);
    expect(lmsToZ(10, { L: 1, M: 10, S: 0.1 })!).toBeCloseTo(0, 10);
  });

  it("uses the log form at L=0", () => {
    // z = ln(X/M)/S; X = M·e^{0.1} ⇒ z = 1.
    const value = 10 * Math.exp(0.1);
    expect(lmsToZ(value, { L: 0, M: 10, S: 0.1 })!).toBeCloseTo(1, 10);
  });

  it("rejects non-positive value / M / S", () => {
    expect(lmsToZ(0, { L: 1, M: 10, S: 0.1 })).toBeNull();
    expect(lmsToZ(-5, { L: 1, M: 10, S: 0.1 })).toBeNull();
    expect(lmsToZ(5, { L: 1, M: 0, S: 0.1 })).toBeNull();
  });
});

describe("zToValue is the inverse of lmsToZ", () => {
  it("round-trips a skewed (L≠0) table", () => {
    const lms = { L: 0.3487, M: 3.3464, S: 0.14602 };
    for (const z of [-2, -1, 0, 0.5, 1.5, 2]) {
      const v = zToValue(z, lms)!;
      expect(lmsToZ(v, lms)!).toBeCloseTo(z, 8);
    }
  });
  it("round-trips at L=0", () => {
    const lms = { L: 0, M: 20, S: 0.09 };
    for (const z of [-1.5, 0, 1, 2.3]) {
      expect(lmsToZ(zToValue(z, lms)!, lms)!).toBeCloseTo(z, 8);
    }
  });
});

describe("zToPercentile / percentileToZ", () => {
  it("maps the standard-normal landmarks", () => {
    expect(zToPercentile(0)).toBeCloseTo(50, 6);
    expect(zToPercentile(1)).toBeCloseTo(84.13, 1);
    expect(zToPercentile(-1)).toBeCloseTo(15.87, 1);
    expect(zToPercentile(1.96)).toBeCloseTo(97.5, 1);
    expect(zToPercentile(-1.96)).toBeCloseTo(2.5, 1);
  });
  it("percentileToZ inverts zToPercentile", () => {
    expect(percentileToZ(50)).toBeCloseTo(0, 6);
    expect(percentileToZ(97.5)).toBeCloseTo(1.96, 2);
    expect(percentileToZ(2.5)).toBeCloseTo(-1.96, 2);
    for (const p of BAND_PERCENTILES) {
      expect(zToPercentile(percentileToZ(p))).toBeCloseTo(p, 4);
    }
  });
});

// --- Pinned against independently published WHO reference points --------------
describe("WHO worked examples (boys weight-for-age at birth)", () => {
  // WHO Child Growth Standards, boys, 0 months: L=0.3487, M=3.3464, S=0.14602.
  // Published percentile birth weights: 3rd ≈ 2.5 kg, 50th ≈ 3.3 kg, 97th ≈ 4.35 kg.
  const lms = lmsFor("male", 0, "weight")!;

  it("has the published birth LMS", () => {
    expect(lms.L).toBeCloseTo(0.3487, 4);
    expect(lms.M).toBeCloseTo(3.3464, 4);
    expect(lms.S).toBeCloseTo(0.14602, 5);
  });

  it("reproduces the 3rd / 50th / 97th percentile birth weights", () => {
    expect(zToValue(percentileToZ(3), lms)!).toBeCloseTo(2.5, 1);
    expect(zToValue(percentileToZ(50), lms)!).toBeCloseTo(3.35, 1);
    expect(zToValue(percentileToZ(97), lms)!).toBeCloseTo(4.35, 1);
  });

  it("scores a median-weight newborn at ~50th percentile", () => {
    const r = measurementPercentile("male", 0, "weight", 3.3464)!;
    expect(r.source).toBe("who");
    expect(r.percentile).toBeCloseTo(50, 4);
  });
});

describe("WHO length medians", () => {
  it("boys 12-month length median ≈ 75.7 cm", () => {
    expect(lmsFor("male", 12, "height")!.M).toBeCloseTo(75.7488, 3);
    // A child at exactly the median scores the 50th percentile.
    expect(
      measurementPercentile("male", 12, "height", 75.7488)!.percentile
    ).toBeCloseTo(50, 3);
  });
  it("girls birth length median ≈ 49.1 cm", () => {
    expect(lmsFor("female", 0, "height")!.M).toBeCloseTo(49.1477, 3);
  });
});

describe("WHO head-circumference medians (0–24 mo, WHO-only)", () => {
  it("boys birth OFC median ≈ 34.5 cm and scores the 50th percentile", () => {
    expect(lmsFor("male", 0, "head_circumference")!.M).toBeCloseTo(34.4618, 3);
    expect(
      measurementPercentile("male", 0, "head_circumference", 34.4618)!
        .percentile
    ).toBeCloseTo(50, 3);
  });
  it("boys 18-month OFC median ≈ 47.4 cm (last WHO-reachable anchor before the 24 mo cutover)", () => {
    expect(lmsFor("male", 18, "head_circumference")!.M).toBeCloseTo(47.4013, 3);
  });
  it("girls 12-month OFC median ≈ 44.9 cm", () => {
    expect(lmsFor("female", 12, "head_circumference")!.M).toBeCloseTo(
      44.8888,
      3
    );
  });
  it("has no CDC table — head circ is WHO-only, so it ages out past 24 mo", () => {
    expect(chartForAge("male", 12, "head_circumference")!.source).toBe("who");
    // At/after the 24-month transition there is no CDC head-circ table.
    expect(chartForAge("male", 24, "head_circumference")).toBeNull();
    expect(chartForAge("male", 60, "head_circumference")).toBeNull();
    // A larger-than-median head scores above the 50th percentile.
    expect(
      measurementPercentile("female", 6, "head_circumference", 44)!.percentile
    ).toBeGreaterThan(50);
  });
});

describe("chartForAge selection (WHO→CDC transition at 24 months)", () => {
  it("uses WHO below 24 months and CDC at/above 24 months for weight", () => {
    expect(chartForAge("male", 23, "weight")!.source).toBe("who");
    expect(chartForAge("male", 23.9, "weight")!.source).toBe("who");
    expect(chartForAge("male", 24, "weight")!.source).toBe("cdc");
    expect(chartForAge("female", 36, "weight")!.source).toBe("cdc");
  });
  it("uses WHO/CDC likewise for height", () => {
    expect(chartForAge("female", 0, "height")!.source).toBe("who");
    expect(chartForAge("female", 200, "height")!.source).toBe("cdc");
  });
  it("BMI has no WHO table (<24 mo) but is available on CDC", () => {
    expect(chartForAge("male", 12, "bmi")).toBeNull();
    expect(chartForAge("male", 30, "bmi")!.source).toBe("cdc");
  });
  it("returns null outside the covered age range", () => {
    expect(chartForAge("male", -1, "weight")).toBeNull();
    expect(chartForAge("male", MAX_AGE_MONTHS + 1, "weight")).toBeNull();
  });
});

describe("lmsAtAge interpolation", () => {
  const rows: [number, number, number, number][] = [
    [0, 1, 10, 0.1],
    [10, 1, 20, 0.2],
  ];
  it("interpolates linearly between anchors", () => {
    const lms = lmsAtAge(rows, 5)!;
    expect(lms.M).toBeCloseTo(15, 10);
    expect(lms.S).toBeCloseTo(0.15, 10);
  });
  it("clamps to the table ends", () => {
    expect(lmsAtAge(rows, -3)!.M).toBe(10);
    expect(lmsAtAge(rows, 99)!.M).toBe(20);
  });
});

describe("CDC self-consistency (median → 50th percentile)", () => {
  it("scores a CDC median 10-year-old weight at ~50th", () => {
    const m = lmsFor("male", 120, "weight")!.M;
    expect(
      measurementPercentile("male", 120, "weight", m)!.percentile
    ).toBeCloseTo(50, 3);
  });
  it("scores a CDC median BMI at ~50th", () => {
    const m = lmsFor("female", 144, "bmi")!.M;
    expect(
      measurementPercentile("female", 144, "bmi", m)!.percentile
    ).toBeCloseTo(50, 3);
  });
});

describe("bmiFrom", () => {
  it("computes kg/m² from weight + height(cm)", () => {
    expect(bmiFrom(16, 100)!).toBeCloseTo(16, 6); // 16 kg, 1.0 m
    expect(bmiFrom(70, 175)!).toBeCloseTo(22.857, 2);
  });
  it("returns null on missing/invalid inputs", () => {
    expect(bmiFrom(null, 100)).toBeNull();
    expect(bmiFrom(16, null)).toBeNull();
    expect(bmiFrom(16, 0)).toBeNull();
  });
});

describe("bandCurves", () => {
  it("produces one monotone-in-percentile curve per band percentile", () => {
    const curves = bandCurves("male", "weight", { stepMonths: 3 });
    expect(curves.map((c) => c.percentile)).toEqual(BAND_PERCENTILES);
    for (const c of curves) expect(c.points.length).toBeGreaterThan(5);
    // At any shared age the value must rise with the percentile.
    const at = (p: number) =>
      curves.find((c) => c.percentile === p)!.points[3].value;
    expect(at(3)).toBeLessThan(at(50));
    expect(at(50)).toBeLessThan(at(97));
  });
  it("respects a restricted age window", () => {
    const curves = bandCurves("female", "height", {
      minMonths: 0,
      maxMonths: 12,
      stepMonths: 1,
    });
    for (const c of curves) {
      for (const pt of c.points) {
        expect(pt.ageMonths).toBeGreaterThanOrEqual(0);
        expect(pt.ageMonths).toBeLessThanOrEqual(12);
      }
    }
  });
});
