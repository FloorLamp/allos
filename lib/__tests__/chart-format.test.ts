import { describe, it, expect } from "vitest";
import { roundChartValue } from "../chart-format";

describe("roundChartValue", () => {
  it("caps a raw unit-conversion float at 2 decimals by default", () => {
    // The motivating case: 103 mg/dL charted in canonical mmol/L.
    expect(roundChartValue(5.716552154288337)).toBe(5.72);
  });

  it("honors a per-series decimals so tooltip and headline agree", () => {
    // TrendMiniCard headline uses round(v, decimals=1) → 5.7; the tooltip must
    // match, not show 5.72 (cap-2) or the raw float.
    expect(roundChartValue(5.716552154288337, 1)).toBe(5.7);
    expect(roundChartValue(5.716552154288337, 0)).toBe(6);
    expect(roundChartValue(130.4, 0)).toBe(130);
  });

  it("drops trailing zeros via the numeric round (no 5.70)", () => {
    expect(roundChartValue(5.7, 2)).toBe(5.7);
    expect(roundChartValue(5.0)).toBe(5);
  });

  it("leaves an already-short value unchanged", () => {
    expect(roundChartValue(45)).toBe(45);
    expect(roundChartValue(103)).toBe(103);
  });

  it("passes non-finite values through untouched", () => {
    expect(roundChartValue(NaN)).toBeNaN();
    expect(roundChartValue(Infinity)).toBe(Infinity);
  });

  it("treats a negative decimals as 0", () => {
    expect(roundChartValue(5.7, -1)).toBe(6);
  });
});
