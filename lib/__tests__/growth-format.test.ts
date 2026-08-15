import { describe, it, expect } from "vitest";
import {
  growthTooltipLabel,
  growthTooltipOrder,
  ordinalPercentile,
  TRAJECTORY_KEY,
} from "../growth-format";
import { BAND_PERCENTILES } from "../growth";

describe("ordinalPercentile", () => {
  it("formats ordinals with the right suffix", () => {
    expect(ordinalPercentile(40)).toBe("40th");
    expect(ordinalPercentile(1)).toBe("1st");
    expect(ordinalPercentile(2)).toBe("2nd");
    expect(ordinalPercentile(3)).toBe("3rd");
    expect(ordinalPercentile(21)).toBe("21st");
    expect(ordinalPercentile(97)).toBe("97th");
  });
  it("uses 'th' for the 11–13 teens", () => {
    expect(ordinalPercentile(11)).toBe("11th");
    expect(ordinalPercentile(12)).toBe("12th");
    expect(ordinalPercentile(13)).toBe("13th");
  });
  it("rounds to the nearest whole percentile", () => {
    expect(ordinalPercentile(49.6)).toBe("50th");
    expect(ordinalPercentile(24.2)).toBe("24th");
  });
  it("clamps the tails", () => {
    expect(ordinalPercentile(0.4)).toBe("<1st");
    expect(ordinalPercentile(99.7)).toBe(">99th");
  });
});

describe("growth chart tooltip rows (#2804)", () => {
  it("names a band by its ordinal, not a hardcoded 'th'", () => {
    expect(growthTooltipLabel("p3")).toBe("3rd pct");
    expect(growthTooltipLabel("p5")).toBe("5th pct");
    expect(growthTooltipLabel("p50")).toBe("50th pct");
    expect(growthTooltipLabel("p97")).toBe("97th pct");
  });

  it("names the profile's own trajectory", () => {
    expect(growthTooltipLabel(TRAJECTORY_KEY)).toBe("This profile");
  });

  it("orders the rows numerically, the profile's reading first", () => {
    // The lexical order recharts 3 defaults to is p10, p25, p3, p5, p50…; sorting
    // by this key gives the reader 3rd → 97th with their own value at the top.
    const keys = [TRAJECTORY_KEY, ...BAND_PERCENTILES.map((p) => `p${p}`)];
    const sorted = [...keys].sort(
      (a, b) => growthTooltipOrder(a) - growthTooltipOrder(b)
    );
    expect(sorted).toEqual([
      TRAJECTORY_KEY,
      "p3",
      "p5",
      "p10",
      "p25",
      "p50",
      "p75",
      "p90",
      "p95",
      "p97",
    ]);
  });
});
