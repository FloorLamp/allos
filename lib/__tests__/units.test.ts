import { describe, expect, it } from "vitest";
import {
  avgSpeed,
  fmtDistance,
  fmtWeight,
  kgTo,
  kmTo,
  round,
  stripNegative,
  stripNonPositive,
  toKg,
  toKm,
} from "@/lib/units";

describe("weight conversions", () => {
  it("are identity for kg", () => {
    expect(kgTo(100, "kg")).toBe(100);
    expect(toKg(100, "kg")).toBe(100);
  });

  it("round-trip kg → lb → kg", () => {
    const kg = 80;
    expect(toKg(kgTo(kg, "lb"), "lb")).toBeCloseTo(kg, 9);
  });

  it("converts kg to lb", () => {
    expect(kgTo(1, "lb")).toBeCloseTo(2.2046226218, 6);
  });
});

describe("distance conversions", () => {
  it("are identity for km and round-trip via miles", () => {
    expect(kmTo(5, "km")).toBe(5);
    expect(toKm(kmTo(5, "mi"), "mi")).toBeCloseTo(5, 9);
  });
});

describe("round", () => {
  it("rounds to the requested decimals", () => {
    expect(round(1.2345, 2)).toBe(1.23);
    expect(round(1.2355, 2)).toBe(1.24);
    expect(round(1.49)).toBe(1.5);
  });
});

describe("stripNegative", () => {
  it("removes minus signs but keeps the digits", () => {
    expect(stripNegative("-5")).toBe("5");
    expect(stripNegative("-2.5")).toBe("2.5");
  });

  it("leaves non-negative and in-progress input untouched", () => {
    expect(stripNegative("")).toBe("");
    expect(stripNegative("0")).toBe("0");
    expect(stripNegative("1.")).toBe("1.");
    expect(stripNegative("60")).toBe("60");
  });
});

describe("stripNonPositive", () => {
  it("clears zero and negative values", () => {
    expect(stripNonPositive("0")).toBe("");
    expect(stripNonPositive("00")).toBe("");
    expect(stripNonPositive("-0")).toBe("");
    expect(stripNonPositive("-5")).toBe("5");
  });

  it("keeps positive values and empty input untouched", () => {
    expect(stripNonPositive("")).toBe("");
    expect(stripNonPositive("1")).toBe("1");
    expect(stripNonPositive("10")).toBe("10");
  });
});

describe("avgSpeed", () => {
  it("returns distance per hour in the chosen unit", () => {
    // 10 km in 60 min = 10 km/h.
    expect(avgSpeed(10, 60, "km")).toBe(10);
  });

  it("returns null when distance or duration is missing or zero", () => {
    expect(avgSpeed(null, 60, "km")).toBeNull();
    expect(avgSpeed(10, 0, "km")).toBeNull();
    expect(avgSpeed(10, null, "km")).toBeNull();
  });
});

describe("formatters", () => {
  it("render an em dash for null", () => {
    expect(fmtWeight(null, "kg")).toBe("—");
    expect(fmtDistance(null, "km")).toBe("—");
  });

  it("append the unit suffix", () => {
    expect(fmtWeight(80, "kg")).toBe("80 kg");
    expect(fmtDistance(5, "km")).toBe("5 km");
  });
});
