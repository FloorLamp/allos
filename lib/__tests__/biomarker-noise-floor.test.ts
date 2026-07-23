import { describe, it, expect } from "vitest";
import {
  curatedNoiseFloor,
  noiseFloorForSeries,
  REFERENCE_WIDTH_NOISE_FRACTION,
} from "../biomarker-noise-floor";

describe("curatedNoiseFloor", () => {
  it("returns the curated SpO2 floor (±2 device error), case-insensitively", () => {
    expect(curatedNoiseFloor("Oxygen Saturation")).toBe(2);
    expect(curatedNoiseFloor("  oxygen saturation ")).toBe(2);
  });

  it("returns null for an analyte with no curated floor, or empty input", () => {
    expect(curatedNoiseFloor("LDL Cholesterol")).toBeNull();
    expect(curatedNoiseFloor(null)).toBeNull();
    expect(curatedNoiseFloor("")).toBeNull();
  });
});

describe("noiseFloorForSeries — source precedence (issue #563)", () => {
  it("1. curated wins even over integer resolution", () => {
    // SpO2 is integer-recorded (would give 1) but the curated ±2 is stricter.
    expect(
      noiseFloorForSeries("Oxygen Saturation", [98, 97, 98], {
        low: 95,
        high: 100,
      })
    ).toBe(2);
  });

  it("2. an integer-recorded series floors at 1 unit (resolution)", () => {
    expect(noiseFloorForSeries("Heart Rate", [60, 62, 61], null)).toBe(1);
  });

  it("2. a fractional reading defeats the integer path", () => {
    // Not all-integer ⇒ fall through to the reference-width fallback.
    expect(
      noiseFloorForSeries("Prostate-Specific Antigen (PSA)", [0.4, 0.5, 0.6], {
        low: 0,
        high: 4,
      })
    ).toBeCloseTo(4 * REFERENCE_WIDTH_NOISE_FRACTION);
  });

  it("3. falls back to a fraction of the reference-range width", () => {
    expect(
      noiseFloorForSeries("Some Assay", [1.1, 2.2, 3.3], { low: 10, high: 30 })
    ).toBeCloseTo(20 * REFERENCE_WIDTH_NOISE_FRACTION);
  });

  it("returns null when nothing can be derived (unbounded, non-integer)", () => {
    expect(noiseFloorForSeries("Some Assay", [1.1, 2.2], null)).toBeNull();
    expect(
      noiseFloorForSeries("Some Assay", [1.1, 2.2], { low: 5, high: null })
    ).toBeNull();
    // An empty/all-NaN series can't be judged integer-recorded → no resolution
    // floor; with no reference it's null.
    expect(noiseFloorForSeries("Some Assay", [], null)).toBeNull();
  });
});
