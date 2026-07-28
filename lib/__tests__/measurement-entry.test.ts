import { describe, expect, it } from "vitest";
import { isMeasurementEntryAllowed } from "@/lib/measurement-entry";

describe("isMeasurementEntryAllowed", () => {
  it("preserves each life-stage gate on metric-scoped entry", () => {
    const child = {
      showBodyFat: false,
      showGrowth: true,
      showHeadCirc: true,
    };
    expect(isMeasurementEntryAllowed("body-fat", child)).toBe(false);
    expect(isMeasurementEntryAllowed("hrv", child)).toBe(false);
    expect(isMeasurementEntryAllowed("head-circ", child)).toBe(true);

    const adult = {
      showBodyFat: true,
      showGrowth: false,
      showHeadCirc: false,
    };
    expect(isMeasurementEntryAllowed("body-fat", adult)).toBe(true);
    expect(isMeasurementEntryAllowed("hrv", adult)).toBe(true);
    expect(isMeasurementEntryAllowed("head-circ", adult)).toBe(false);
  });

  it("leaves measurements without life-stage gates available", () => {
    const restrictive = {
      showBodyFat: false,
      showGrowth: true,
      showHeadCirc: false,
    };
    for (const metric of [
      "weight",
      "resting-hr",
      "blood-pressure",
      "spo2",
      "temperature",
      "height",
    ] as const) {
      expect(isMeasurementEntryAllowed(metric, restrictive)).toBe(true);
    }
  });
});
