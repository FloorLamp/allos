import { describe, it, expect } from "vitest";
import {
  comparisonDifference,
  comparisonTone,
  formatComparisonValue,
} from "@/lib/session-comparison-format";
import type { RideComparisonMetric } from "@/lib/ride-detail";

const metric = (
  key: RideComparisonMetric["key"],
  current: number,
  median: number
): RideComparisonMetric => ({
  key,
  current,
  median,
  difference: current - median,
  points: [],
});

describe("session comparison presentation (#2566 convergence)", () => {
  it("gives ONLY speed a direction — every other metric is context", () => {
    // The rule this module exists to hold: a session run at a higher heart rate
    // is not a better session, and colouring it as one tells the reader
    // something untrue about their own body.
    expect(comparisonTone(metric("speed", 12, 10), "above")).toBe("good");
    expect(comparisonTone(metric("speed", 8, 10), "below")).toBe("watch");
    for (const key of [
      "heart_rate",
      "power",
      "weighted_power",
      "cadence",
      "elevation",
      "relative_effort",
    ] as const) {
      expect(comparisonTone(metric(key, 160, 140), "above")).toBe("neutral");
      expect(comparisonTone(metric(key, 120, 140), "below")).toBe("neutral");
    }
  });

  it("says 'same as' rather than a zero difference", () => {
    // 0.4 bpm is not a difference anyone can act on, and "0 bpm above" reads as
    // a measurement rather than a rounding.
    expect(
      comparisonDifference(metric("heart_rate", 150.4, 150), "km")
    ).toEqual({ value: null, relation: "same as" });
    // But a tenth of a km/h IS reported, because speed is read to a tenth.
    expect(comparisonDifference(metric("speed", 10.1, 10), "km")).toEqual({
      value: "0.1 km/h",
      relation: "above",
    });
  });

  it("converts to the reader's units, label and sign together", () => {
    const m = metric("speed", 16.09344, 8.04672); // 10 mph vs 5 mph
    expect(formatComparisonValue("speed", m.current, "mi")).toBe("10 mi/h");
    expect(comparisonDifference(m, "mi")).toEqual({
      value: "5 mi/h",
      relation: "above",
    });
    // Elevation is stored in metres and read in feet.
    expect(formatComparisonValue("elevation", 100, "mi")).toBe("328 ft");
    expect(formatComparisonValue("elevation", 100, "km")).toBe("100 m");
  });

  it("keeps heart rate whole — 152.4 bpm is false precision", () => {
    expect(formatComparisonValue("heart_rate", 152.4, "km")).toBe("152 bpm");
  });
});
