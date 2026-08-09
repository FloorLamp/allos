import { describe, it, expect } from "vitest";
import { bandNumber, formatBand } from "@/lib/band-format";

// ONE band spelling (#221/#2315). Promoted out of MetricJudgmentCard so the card,
// the biomarker row's judgment cell and the detail page's range cards cannot print
// the same band three ways.
describe("formatBand", () => {
  it("writes a two-sided band with an en dash", () => {
    expect(formatBand(70, 85)).toBe("70–85");
    // A hyphen would read as a minus sign in front of the upper bound.
    expect(formatBand(70, 85)).not.toContain("-");
  });

  it("writes a one-sided band with the bound it actually has", () => {
    expect(formatBand(null, 60)).toBe("≤ 60");
    expect(formatBand(2, null)).toBe("≥ 2");
  });

  it("collapses a point band to one value", () => {
    // A curated low === high is a single target ("ideally undetectable" toxins
    // pinned at 0), never a zero-width interval.
    expect(formatBand(0, 0)).toBe("0");
  });

  it("returns null when the band states no bound at all", () => {
    expect(formatBand(null, null)).toBeNull();
    expect(formatBand(undefined, undefined)).toBeNull();
  });

  it("appends the unit suffix verbatim, to the last number only", () => {
    expect(formatBand(50, 100, " bpm")).toBe("50–100 bpm");
    expect(formatBand(null, 60, " mg/dL")).toBe("≤ 60 mg/dL");
    expect(formatBand(2, null, " mg/L")).toBe("≥ 2 mg/L");
  });
});

describe("bandNumber (the rounding)", () => {
  it("kills floating-point residue", () => {
    expect(bandNumber(0.1 + 0.2)).toBe("0.3");
    expect(formatBand(0.1 + 0.2, 0.7 + 0.1)).toBe("0.3–0.8");
  });

  it("keeps a band whose meaning lives in its third decimal", () => {
    // Urine Specific Gravity is curated 1.001–1.035. Two-decimal rounding — the
    // formatter's shape before it was promoted — prints "1–1.04", which is wrong
    // and undetectable on sight. This is the case that sets the precision.
    expect(formatBand(1.001, 1.035)).toBe("1.001–1.035");
  });

  it("leaves whole numbers whole", () => {
    expect(bandNumber(150)).toBe("150");
    expect(bandNumber(3.5)).toBe("3.5");
  });
});
