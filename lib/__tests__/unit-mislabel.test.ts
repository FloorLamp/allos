import { describe, expect, it } from "vitest";
import {
  detectUnitMislabel,
  parseReferenceRange,
  reconciledFlag,
} from "../reference-range";

// Unit-mislabel plausibility cross-check (issue #761). A lab that MISLABELS a unit
// (MCHC "33 g/L" whose printed range 31–37 is really g/dL) converts faithfully into
// a confident, spuriously-extreme flag. detectUnitMislabel is the pure evidence gate
// off the stated reference range; reconciledFlag consults it to decline deriving the
// false flag pre-approval. These lock the fire cases AND the true negatives — the
// detector is deliberately conservative (a false positive is worse than a miss).

// A canonical-ranges shape reconciledFlag/detectUnitMislabel accept (full OptimalFields
// so the type is satisfied). Mirrors real MCHC: g/dL, reference 31.6–35.4, no optimal.
function mchc() {
  return {
    name: "Mean Corpuscular Hemoglobin Concentration (MCHC)",
    unit: "g/dL",
    direction: "in_range" as const,
    ref_low: 31.6,
    ref_high: 35.4,
    ref_low_male: null,
    ref_high_male: null,
    ref_low_female: null,
    ref_high_female: null,
    optimal_low: null,
    optimal_high: null,
    optimal_low_male: null,
    optimal_high_male: null,
    optimal_low_female: null,
    optimal_high_female: null,
  };
}

describe("parseReferenceRange (issue #761 forms)", () => {
  it("parses a two-sided range and a >= one-sided", () => {
    expect(parseReferenceRange("31-37")).toEqual({ low: 31, high: 37 });
    expect(parseReferenceRange(">=40")).toEqual({ low: 40 });
  });
  it("yields null for qualitative / malformed / empty", () => {
    expect(parseReferenceRange("NEGATIVE")).toBeNull();
    expect(parseReferenceRange("see note")).toBeNull();
    expect(parseReferenceRange("")).toBeNull();
    expect(parseReferenceRange(null)).toBeNull();
  });
});

describe("detectUnitMislabel", () => {
  it("fires on the MCHC g/L↔g/dL case (the worked example)", () => {
    // 33 g/L → 3.3 g/dL is a false 'low'; the printed range 31–37 is a clean 10×
    // off from the canonical 31.6–35.4 (it's really g/dL).
    const hit = detectUnitMislabel("31-37", "g/L", 33, mchc());
    expect(hit).toEqual({ factor: 10, corrected: { unit: "g/dL", value: 33 } });
  });

  it("fires when the corrected value is in the REPORT's range but just outside the canonical one (#761 real-export miss)", () => {
    // From a real export: MCHC 35.8 g/L, stated range 31.0–37.0. Relabeled to g/dL
    // the value is 35.8 — normal per the report (∈ 31–37) but 0.4 ABOVE our tight
    // canonical ceiling (35.4). The corroboration must accept the report's own
    // range, or the detector misses its own motivating case and the false 'low'
    // (35.8 g/L → 3.58 g/dL) is never suppressed.
    const hit = detectUnitMislabel("31.0-37.0", "g/L", 35.8, mchc());
    expect(hit).toEqual({
      factor: 10,
      corrected: { unit: "g/dL", value: 35.8 },
    });
    // And the flag path suppresses the false 'low' end to end.
    expect(reconciledFlag(null, 35.8, "g/L", mchc())).toBe("low"); // without the range
    expect(
      reconciledFlag(null, 35.8, "g/L", mchc(), null, null, null, "31.0-37.0")
    ).toBe(undefined); // with it → declines
  });

  it("does NOT fire when the relabeled value is out of BOTH ranges (a real low, not a mislabel)", () => {
    // 3.3 g/L relabels to 3.3 g/dL — out of the canonical range AND the report's
    // 31–37. Nothing corroborates the correction, so it stays a genuine reading.
    expect(detectUnitMislabel("31-37", "g/L", 3.3, mchc())).toBeNull();
  });

  it("fires on a one-sided stated range that is a clean decade off", () => {
    // A one-sided upper bound '<37' (really the g/dL upper) labeled g/L: value 33
    // g/L → 3.3 (low), the single bound is a clean 10× off, corrected lands in range.
    const hit = detectUnitMislabel("<37", "g/L", 33, mchc());
    expect(hit).toEqual({ factor: 10, corrected: { unit: "g/dL", value: 33 } });
  });

  it("does NOT fire when the value is already in range under the stated unit", () => {
    // 33 g/dL is correctly labeled and in range — nothing to correct.
    expect(detectUnitMislabel("31-37", "g/dL", 33, mchc())).toBeNull();
  });

  it("does NOT fire without a parseable stated range (no signal)", () => {
    expect(detectUnitMislabel(null, "g/L", 33, mchc())).toBeNull();
    expect(detectUnitMislabel("see report", "g/L", 33, mchc())).toBeNull();
  });

  it("does NOT fire on a genuinely-different cohort range (non-decimal disagreement)", () => {
    // Value 33 g/dL vs a cohort range 40-45 g/dL: off by ~1.3×, not a clean power
    // of ten → the range could just be a different lab's cohort → no signal.
    expect(detectUnitMislabel("40-45", "g/dL", 33, mchc())).toBeNull();
  });

  it("does NOT fire when the stated range is not convertible / no canonical range", () => {
    // No canonical range on the entry → no comparator.
    const noRange = { ...mchc(), ref_low: null, ref_high: null };
    expect(detectUnitMislabel("31-37", "g/L", 33, noRange)).toBeNull();
  });

  it("does NOT fire on a messy 5× disagreement (not a clean decade)", () => {
    // A stated range that is ~5× off from canonical is not a power-of-ten error.
    // 6.3-7.1 g/L → 0.63-0.71 g/dL; canonical 31.6-35.4 is ~50× → but per-bound
    // ratios must ALSO agree on the decade; here they don't cleanly → null.
    expect(detectUnitMislabel("6.3-7.1", "g/dL", 6.7, mchc())).toBeNull();
  });
});

describe("reconciledFlag mislabel suppression (issue #761)", () => {
  it("declines to derive the false 'low' from a probable mislabel", () => {
    // Without the reference, the old behavior derives a false 'low'.
    expect(reconciledFlag(null, 33, "g/L", mchc())).toBe("low");
    // With the stated range revealing the mislabel, it declines (leave unchanged).
    expect(
      reconciledFlag(null, 33, "g/L", mchc(), null, null, null, "31-37")
    ).toBe(undefined);
  });

  it("still derives a genuine 'low' for a correctly-labeled reading", () => {
    // 20 g/dL is a real low; its stated range agrees (no mislabel) → flag low.
    expect(
      reconciledFlag(null, 20, "g/dL", mchc(), null, null, null, "31.6-35.4")
    ).toBe("low");
  });

  it("clears a stale flag to Normal for a corrected in-range reading", () => {
    // Once the unit is g/dL, 33 is in range → any stale 'low' clears.
    expect(
      reconciledFlag("low", 33, "g/dL", mchc(), null, null, null, "31-37")
    ).toBe(null);
  });
});
