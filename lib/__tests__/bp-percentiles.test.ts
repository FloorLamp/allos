import { describe, expect, it } from "vitest";
import {
  bpComponentFor,
  bpThresholds,
  bpPercentile,
  bpComponentCategory,
  pediatricBpContext,
  pediatricBpOverall,
  worseBpCategory,
  formatBpPercentile,
  ordinal,
  ADULT_BP_AGE,
} from "@/lib/bp-percentiles";

// Pure pediatric BP interpretation over the AAP 2017 baked tables (issue #150).
// Exemplars are read straight off lib/bp-percentiles.json (AAP 2017 Tables 3 & 4)
// so the classifier is pinned to published normative values.

describe("bpComponentFor", () => {
  it("maps the canonical BP biomarker names", () => {
    expect(bpComponentFor("Blood Pressure Systolic")).toBe("systolic");
    expect(bpComponentFor("Blood Pressure Diastolic")).toBe("diastolic");
    expect(bpComponentFor("Heart Rate")).toBeNull();
  });
});

describe("bpThresholds", () => {
  it("reads a table anchor column directly (boy age 8, 25th height pct)", () => {
    // boys age 8: 50→sbp[25th]=97, 90→109, 95→112 (AAP 2017 Table 3).
    const t = bpThresholds("systolic", "male", 8, 25);
    expect(t).toEqual({ p50: 97, p90: 109, p95: 112 });
  });

  it("interpolates linearly between height-percentile columns", () => {
    // boys age 8 systolic 90th: [107,108,109,110,111,112,112] at [5,10,25,...].
    // 17.5 is halfway between the 10th (108) and 25th (109) columns → 108.5.
    const t = bpThresholds("systolic", "male", 8, 17.5)!;
    expect(t.p90).toBeCloseTo(108.5, 6);
  });

  it("clamps height percentile to the table edges [5,95]", () => {
    const low = bpThresholds("systolic", "male", 8, 1)!; // → 5th column
    const high = bpThresholds("systolic", "male", 8, 99)!; // → 95th column
    expect(low.p50).toBe(95); // boys age8 sbp 50th, 5th col
    expect(high.p50).toBe(100); // boys age8 sbp 50th, 95th col
  });

  it("floors and clamps age into the 1-17 table window", () => {
    // age 1.6 → row 1; age 30 → clamped to row 17.
    expect(bpThresholds("systolic", "male", 1.6, 50)).toEqual(
      bpThresholds("systolic", "male", 1, 50)
    );
    expect(bpThresholds("systolic", "male", 30, 50)).toEqual(
      bpThresholds("systolic", "male", 17, 50)
    );
  });

  it("returns null without a known sex", () => {
    expect(bpThresholds("systolic", null, 8, 50)).toBeNull();
  });
});

describe("bpPercentile", () => {
  const thr = { p50: 99, p90: 110, p95: 115 }; // boy age9 systolic, 50th height
  it("clamps at/under the 50th and at/over the 95th", () => {
    expect(bpPercentile(90, thr)).toEqual({ percentile: 50, clamped: "low" });
    expect(bpPercentile(120, thr)).toEqual({ percentile: 95, clamped: "high" });
  });
  it("lands a value on the 90th and interpolates between anchors", () => {
    expect(bpPercentile(110, thr)).toEqual({ percentile: 90, clamped: null });
    // midway 99→110 is ~the 70th (50 + 0.5*40).
    expect(bpPercentile(104.5, thr).percentile).toBe(70);
  });
});

describe("bpComponentCategory — AAP 2017 percentile bands (age 1-12)", () => {
  // boy age 9, 50th height: sys 50/90/95 = 99/110/115 (→ 95th+12 = 127).
  const sys = { p50: 99, p90: 110, p95: 115 };
  it("normal below the 90th", () => {
    expect(bpComponentCategory("systolic", 108, 9, sys)).toBe("normal");
  });
  it("elevated at ≥90th and <95th (capped at 120)", () => {
    expect(bpComponentCategory("systolic", 110, 9, sys)).toBe("elevated");
    expect(bpComponentCategory("systolic", 114, 9, sys)).toBe("elevated");
  });
  it("stage 1 at ≥95th and <95th+12", () => {
    expect(bpComponentCategory("systolic", 115, 9, sys)).toBe("stage1");
    expect(bpComponentCategory("systolic", 126, 9, sys)).toBe("stage1");
  });
  it("stage 2 at ≥95th+12 (or the 140 cap)", () => {
    expect(bpComponentCategory("systolic", 127, 9, sys)).toBe("stage2");
  });
  it("applies the static 130 Stage-1 cap when the 95th percentile is higher", () => {
    // A very tall/old-in-band child whose 95th exceeds 130: the 130 cap wins.
    const tall = { p50: 118, p90: 128, p95: 133 };
    expect(bpComponentCategory("systolic", 130, 12, tall)).toBe("stage1");
  });
});

describe("bpComponentCategory — static adolescent thresholds (age ≥13)", () => {
  const anySys = { p50: 108, p90: 121, p95: 125 };
  const anyDia = { p50: 64, p90: 76, p95: 79 };
  it("uses fixed adult-style cutoffs, ignoring the percentile bands", () => {
    expect(bpComponentCategory("systolic", 118, 14, anySys)).toBe("normal");
    expect(bpComponentCategory("systolic", 125, 14, anySys)).toBe("elevated");
    expect(bpComponentCategory("systolic", 135, 14, anySys)).toBe("stage1");
    expect(bpComponentCategory("systolic", 142, 14, anySys)).toBe("stage2");
  });
  it("diastolic ≥13 has no elevated band (<80 normal, 80-89 stage1, ≥90 stage2)", () => {
    expect(bpComponentCategory("diastolic", 79, 14, anyDia)).toBe("normal");
    expect(bpComponentCategory("diastolic", 85, 14, anyDia)).toBe("stage1");
    expect(bpComponentCategory("diastolic", 92, 14, anyDia)).toBe("stage2");
  });
  it("switches regime exactly at ADULT_BP_AGE", () => {
    expect(ADULT_BP_AGE).toBe(13);
  });
});

describe("pediatricBpContext", () => {
  it("classifies a 1-year-old girl's borderline systolic as elevated (assumed height)", () => {
    // girls age1, 50th height: sys 50/90/95 = 86/100/103. 101 → ~92nd, Elevated.
    const ctx = pediatricBpContext("systolic", 101, {
      sex: "female",
      ageYears: 1,
    })!;
    expect(ctx.category).toBe("elevated");
    expect(ctx.heightAssumed).toBe(true);
    expect(ctx.heightPercentile).toBe(50);
    expect(ctx.percentile).toBeGreaterThanOrEqual(90);
    expect(ctx.percentile).toBeLessThan(95);
    expect(ctx.adultRegime).toBe(false);
  });

  it("uses a supplied height percentile (not assumed)", () => {
    const ctx = pediatricBpContext("systolic", 108, {
      sex: "male",
      ageYears: 9,
      heightPercentile: 50,
    })!;
    expect(ctx.heightAssumed).toBe(false);
    expect(ctx.category).toBe("normal");
  });

  it("flags the adult-threshold regime from age 13", () => {
    const ctx = pediatricBpContext("systolic", 118, {
      sex: "female",
      ageYears: 13,
      heightPercentile: 50,
    })!;
    expect(ctx.adultRegime).toBe(true);
    expect(ctx.category).toBe("normal");
  });

  it("returns null outside the pediatric window or without sex", () => {
    expect(
      pediatricBpContext("systolic", 110, { sex: "male", ageYears: 18 })
    ).toBeNull();
    expect(
      pediatricBpContext("systolic", 110, { sex: "male", ageYears: 0 })
    ).toBeNull();
    expect(
      pediatricBpContext("systolic", 110, { sex: null, ageYears: 9 })
    ).toBeNull();
    expect(
      pediatricBpContext("systolic", null, { sex: "male", ageYears: 9 })
    ).toBeNull();
  });
});

describe("pediatricBpOverall", () => {
  it("takes the worse of the two components (boy 9, 118/78 → stage 1)", () => {
    const o = pediatricBpOverall(118, 78, {
      sex: "male",
      ageYears: 9,
      heightPercentile: 50,
    })!;
    expect(o.systolic.category).toBe("stage1");
    expect(o.diastolic.category).toBe("stage1");
    expect(o.category).toBe("stage1");
  });
  it("elevated systolic + normal diastolic → elevated overall (110/70)", () => {
    const o = pediatricBpOverall(110, 70, {
      sex: "male",
      ageYears: 9,
      heightPercentile: 50,
    })!;
    expect(o.systolic.category).toBe("elevated");
    expect(o.diastolic.category).toBe("normal");
    expect(o.category).toBe("elevated");
  });
});

describe("display helpers", () => {
  it("worseBpCategory ranks the classes", () => {
    expect(worseBpCategory("normal", "elevated")).toBe("elevated");
    expect(worseBpCategory("stage2", "stage1")).toBe("stage2");
  });
  it("ordinal + formatBpPercentile", () => {
    expect(ordinal(92)).toBe("92nd");
    expect(ordinal(95)).toBe("95th");
    const ctx = pediatricBpContext("systolic", 130, {
      sex: "male",
      ageYears: 9,
      heightPercentile: 50,
    })!;
    expect(formatBpPercentile(ctx)).toBe("≥ 95th percentile");
  });
});
