import { describe, expect, it } from "vitest";
import {
  cooperVo2,
  rockportWalkVo2,
  queensStepVo2,
  heartRateRecovery,
  sittingRisingResult,
  sittingRisingBand,
  HRR_ABNORMAL_CUTOFF,
} from "@/lib/vo2-field-tests";

// Pure, cited field-test estimators (issue #834). Boundary + exemplar checks against the
// published regressions; no DB/network.

describe("Cooper 12-minute run VO2", () => {
  it("computes VO2max = (distance − 504.9) / 44.73", () => {
    // 2400 m → (2400 − 504.9)/44.73 = 42.37 → 42.4.
    const r = cooperVo2(2400)!;
    expect(r.vo2).toBeCloseTo(42.4, 1);
    expect(r.method).toMatch(/Cooper/);
    expect(r.citation).toMatch(/JAMA 1968/);
  });

  it("clamps an absurd distance into the plausible VO2 envelope", () => {
    expect(cooperVo2(9000)!.vo2).toBe(90); // clamped high
    expect(cooperVo2(300)!.vo2).toBe(10); // below floor → clamped low
  });

  it("refuses a missing/non-positive distance (no guess)", () => {
    expect(cooperVo2(null)).toBeNull();
    expect(cooperVo2(undefined)).toBeNull();
    expect(cooperVo2(0)).toBeNull();
    expect(cooperVo2(NaN)).toBeNull();
  });
});

describe("Rockport 1-mile walk VO2", () => {
  it("computes the Kline regression for a worked example", () => {
    // weight 175 lb, age 40, male, 14 min, HR 140:
    // 132.853 − 0.0769·175 − 0.3877·40 + 6.315·1 − 3.2649·14 − 0.1565·140
    // = 132.853 − 13.4575 − 15.508 + 6.315 − 45.7086 − 21.91 = 42.58 → 42.6
    const r = rockportWalkVo2({
      weightLb: 175,
      age: 40,
      sex: "male",
      timeMin: 14,
      heartRate: 140,
    })!;
    expect(r.vo2).toBeCloseTo(42.6, 1);
    expect(r.method).toMatch(/Rockport/);
  });

  it("scores women lower than men for identical inputs (sex term)", () => {
    const base = { weightLb: 150, age: 35, timeMin: 15, heartRate: 130 };
    const male = rockportWalkVo2({ ...base, sex: "male" })!;
    const female = rockportWalkVo2({ ...base, sex: "female" })!;
    expect(male.vo2 - female.vo2).toBeCloseTo(6.3, 1); // the 6.315 sex coefficient
  });

  it("refuses when any input is missing", () => {
    expect(
      rockportWalkVo2({
        weightLb: 175,
        age: 40,
        sex: null,
        timeMin: 14,
        heartRate: 140,
      })
    ).toBeNull();
    expect(
      rockportWalkVo2({
        weightLb: null,
        age: 40,
        sex: "male",
        timeMin: 14,
        heartRate: 140,
      })
    ).toBeNull();
  });
});

describe("Queens College step-test VO2", () => {
  it("applies the sex-specific recovery-HR regression", () => {
    // Men: 111.33 − 0.42·150 = 48.33 → 48.3
    expect(queensStepVo2(150, "male")!.vo2).toBeCloseTo(48.3, 1);
    // Women: 65.81 − 0.1847·150 = 38.105 → 38.1
    expect(queensStepVo2(150, "female")!.vo2).toBeCloseTo(38.1, 1);
  });

  it("a lower recovery HR yields a higher VO2 (fitter)", () => {
    expect(queensStepVo2(120, "male")!.vo2).toBeGreaterThan(
      queensStepVo2(170, "male")!.vo2
    );
  });

  it("refuses without sex or a valid HR", () => {
    expect(queensStepVo2(150, null)).toBeNull();
    expect(queensStepVo2(0, "male")).toBeNull();
  });
});

describe("1-minute heart-rate recovery", () => {
  it("computes the drop and bands ≤ 12 as abnormal (Cole 1999)", () => {
    const good = heartRateRecovery(170, 140)!; // 30 drop
    expect(good.hrr).toBe(30);
    expect(good.band).toBe("normal");
    const bad = heartRateRecovery(170, 160)!; // 10 drop
    expect(bad.hrr).toBe(10);
    expect(bad.band).toBe("abnormal");
  });

  it("bands exactly at the cutoff as abnormal (≤ 12)", () => {
    const atCutoff = heartRateRecovery(150, 150 - HRR_ABNORMAL_CUTOFF)!;
    expect(atCutoff.hrr).toBe(HRR_ABNORMAL_CUTOFF);
    expect(atCutoff.band).toBe("abnormal");
    const justOver = heartRateRecovery(150, 150 - HRR_ABNORMAL_CUTOFF - 1)!;
    expect(justOver.band).toBe("normal");
  });

  it("refuses missing/non-positive HR values", () => {
    expect(heartRateRecovery(null, 140)).toBeNull();
    expect(heartRateRecovery(170, 0)).toBeNull();
  });
});

describe("Sitting-Rising Test (SRT) scoring", () => {
  it("bands the published 0-10 scale (<8 elevated, 8-9.5 intermediate, 10 reference)", () => {
    expect(sittingRisingBand(6)).toBe("elevated-risk");
    expect(sittingRisingBand(7.5)).toBe("elevated-risk");
    expect(sittingRisingBand(8)).toBe("intermediate");
    expect(sittingRisingBand(9.5)).toBe("intermediate");
    expect(sittingRisingBand(10)).toBe("reference");
  });

  it("snaps to half-point resolution and rejects out-of-range scores", () => {
    expect(sittingRisingResult(7.3)!.score).toBe(7.5);
    expect(sittingRisingResult(8.2)!.score).toBe(8);
    expect(sittingRisingResult(-1)).toBeNull();
    expect(sittingRisingResult(11)).toBeNull();
    expect(sittingRisingResult(null)).toBeNull();
  });
});
