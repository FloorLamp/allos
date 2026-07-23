import { describe, expect, it } from "vitest";
import {
  computeUvDose,
  elevationUvCeiling,
  parseSkinType,
  SED_PER_UV_MINUTE,
  SKIN_TYPE_MED_SED,
  VITAMIN_D_SUFFICIENT_SED,
  type UvDoseInput,
} from "../uv-dose";

// A window covering [10:00, 12:00] local (600..720 min), and hourly UV = 6 in both
// hours 10 and 11.
function baseInput(over: Partial<UvDoseInput> = {}): UvDoseInput {
  return {
    windows: [{ startMin: 600, endMin: 720 }],
    hourlyUv: new Map([
      [10, 6],
      [11, 6],
    ]),
    uvSource: "live",
    skinType: null,
    ...over,
  };
}

describe("computeUvDose — the ONE crossing computation (#1172)", () => {
  it("crosses minutes × hourly UV into UV-minutes and SED", () => {
    const r = computeUvDose(baseInput());
    expect(r.outdoorMinutes).toBe(120);
    // 60 min at UV6 + 60 min at UV6 = 720 UV-minutes.
    expect(r.uvMinutes).toBe(720);
    // SED = 720 × 0.015 = 10.8.
    expect(r.sed).toBeCloseTo(720 * SED_PER_UV_MINUTE, 6);
    expect(r.peakUvIndex).toBe(6);
  });

  it("splits a window that spans an hour boundary by minutes-in-hour", () => {
    // 11:30–12:30: 30 min in hour 11 (UV6), 30 min in hour 12 (UV2).
    const r = computeUvDose(
      baseInput({
        windows: [{ startMin: 690, endMin: 750 }],
        hourlyUv: new Map([
          [11, 6],
          [12, 2],
        ]),
      })
    );
    expect(r.outdoorMinutes).toBe(60);
    // 30×6 + 30×2 = 180 + 60 = 240.
    expect(r.uvMinutes).toBe(240);
    expect(r.peakUvIndex).toBe(6);
  });

  it("counts only meaningful-UV (≥3) minutes toward the vitamin-D side", () => {
    const r = computeUvDose(
      baseInput({
        windows: [{ startMin: 600, endMin: 720 }],
        hourlyUv: new Map([
          [10, 4], // meaningful
          [11, 1], // below threshold
        ]),
      })
    );
    expect(r.meaningfulUvMinutes).toBe(60);
    // vitaminDSed only accrues in the UV4 hour: 60×4×0.015 = 3.6.
    expect(r.vitaminDSed).toBeCloseTo(60 * 4 * SED_PER_UV_MINUTE, 6);
  });

  it("sufficiency flips at VITAMIN_D_SUFFICIENT_SED (meaningful-UV hours only)", () => {
    // 10 min at UV4 → vitaminDSed = 10×4×0.015 = 0.6 ≥ 0.5 → sufficient.
    const suff = computeUvDose(
      baseInput({
        windows: [{ startMin: 600, endMin: 610 }],
        hourlyUv: new Map([[10, 4]]),
      })
    );
    expect(suff.vitaminDSed).toBeGreaterThanOrEqual(VITAMIN_D_SUFFICIENT_SED);
    expect(suff.sufficient).toBe(true);

    // 5 min at UV4 → 0.3 < 0.5 → not sufficient.
    const insuff = computeUvDose(
      baseInput({
        windows: [{ startMin: 600, endMin: 605 }],
        hourlyUv: new Map([[10, 4]]),
      })
    );
    expect(insuff.sufficient).toBe(false);
  });

  it("stays silent on the overexposure side without a skin type", () => {
    const r = computeUvDose(baseInput({ skinType: null }));
    expect(r.overexposed).toBeNull();
    expect(r.minutesToBurn).toBeNull();
  });

  it("flags overexposure once the cumulative dose crosses the skin-type MED", () => {
    // Type II MED = 2.5 SED. 120 min at UV6 → SED 10.8 ≫ 2.5 → overexposed.
    const r = computeUvDose(baseInput({ skinType: 2 }));
    expect(r.overexposed).toBe(true);
    // minutesToBurn at peak UV6: MED / (6 × 0.015) = 2.5 / 0.09 ≈ 28.
    expect(r.minutesToBurn).toBe(
      Math.round(SKIN_TYPE_MED_SED[2] / (6 * SED_PER_UV_MINUTE))
    );
  });

  it("does NOT flag overexposure below the MED", () => {
    // 10 min at UV3 → SED = 10×3×0.015 = 0.45 < type I MED (2.0).
    const r = computeUvDose(
      baseInput({
        windows: [{ startMin: 600, endMin: 610 }],
        hourlyUv: new Map([[10, 3]]),
        skinType: 1,
      })
    );
    expect(r.overexposed).toBe(false);
  });

  it("darker skin types tolerate a larger dose before overexposure", () => {
    // 60 min at UV5 → SED = 60×5×0.015 = 4.5. Type III MED 3.0 → over; type VI MED 10 → under.
    const win = {
      windows: [{ startMin: 600, endMin: 660 }],
      hourlyUv: new Map([[10, 5]]),
    };
    expect(computeUvDose(baseInput({ ...win, skinType: 3 })).overexposed).toBe(
      true
    );
    expect(computeUvDose(baseInput({ ...win, skinType: 6 })).overexposed).toBe(
      false
    );
  });

  it("degrades to minutes-only when there is no UV signal", () => {
    const r = computeUvDose(baseInput({ uvSource: "none" }));
    expect(r.outdoorMinutes).toBe(120);
    expect(r.uvMinutes).toBeNull();
    expect(r.sed).toBeNull();
    expect(r.sufficient).toBeNull();
    expect(r.overexposed).toBeNull();
    expect(r.peakUvIndex).toBeNull();
  });

  it("carries the clear-sky provenance through unchanged", () => {
    expect(computeUvDose(baseInput({ uvSource: "clear-sky" })).uvSource).toBe(
      "clear-sky"
    );
  });
});

describe("elevationUvCeiling — the offline clear-sky rung", () => {
  it("is 0 at/below the horizon and rises with elevation", () => {
    expect(elevationUvCeiling(0)).toBe(0);
    expect(elevationUvCeiling(-5)).toBe(0);
    expect(elevationUvCeiling(90)).toBeCloseTo(12, 6);
    expect(elevationUvCeiling(30)).toBeGreaterThan(0);
    expect(elevationUvCeiling(60)).toBeGreaterThan(elevationUvCeiling(30));
  });
});

describe("parseSkinType", () => {
  it("accepts 1..6 as string or number, rejects the rest", () => {
    expect(parseSkinType("3")).toBe(3);
    expect(parseSkinType(6)).toBe(6);
    expect(parseSkinType("0")).toBeNull();
    expect(parseSkinType("7")).toBeNull();
    expect(parseSkinType("")).toBeNull();
    expect(parseSkinType(null)).toBeNull();
    expect(parseSkinType("2.5")).toBeNull();
  });
});
