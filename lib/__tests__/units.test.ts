import { describe, expect, it } from "vitest";
import {
  avgSpeed,
  fmtDistance,
  fmtWeight,
  kgTo,
  kmTo,
  resolveWeightKg,
  round,
  stripNegative,
  stripNonPositive,
  submittedDistanceUnit,
  submittedWeightUnit,
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

describe("resolveWeightKg (issue #194)", () => {
  // The edit-form round-trip: a form pre-fills the display value as
  // round(kgTo(stored, unit), 1); re-saving that same display value must NOT
  // move the canonical kg (a true no-op), for kg and lb alike.
  const displayOf = (kg: number, unit: "kg" | "lb") => round(kgTo(kg, unit), 1);

  it("keeps the stored kg exactly when the display value is unchanged (lb)", () => {
    const stored = 60.4; // canonical kg with sub-quantum precision
    const submitted = displayOf(stored, "lb"); // what the untouched form holds
    expect(resolveWeightKg(submitted, stored, "lb")).toBe(stored);
  });

  it("keeps the stored kg exactly when the display value is unchanged (kg)", () => {
    const stored = 80.25; // more precision than the 1-decimal display shows
    const submitted = displayOf(stored, "kg"); // 80.3
    expect(resolveWeightKg(submitted, stored, "kg")).toBe(stored);
  });

  it("does not drift across repeated untouched round-trips (lb)", () => {
    let kg = 100.7;
    for (let i = 0; i < 25; i++) {
      const submitted = displayOf(kg, "lb");
      kg = resolveWeightKg(submitted, kg, "lb");
    }
    expect(kg).toBe(100.7);
  });

  it("converts a genuinely changed value through toKg (lb)", () => {
    const stored = 60.4;
    const changed = displayOf(stored, "lb") + 1; // user nudged it up 1 lb
    expect(resolveWeightKg(changed, stored, "lb")).toBeCloseTo(
      toKg(changed, "lb"),
      9
    );
    expect(resolveWeightKg(changed, stored, "lb")).not.toBe(stored);
  });

  it("falls back to toKg when there is no stored value (create path)", () => {
    expect(resolveWeightKg(150, null, "lb")).toBeCloseTo(toKg(150, "lb"), 9);
    expect(resolveWeightKg(80, undefined, "kg")).toBe(80);
  });
});

describe("submittedWeightUnit / submittedDistanceUnit (issue #630)", () => {
  it("trusts a valid submitted weight unit over the fallback pref", () => {
    // The number was captured in kg; the login's stored pref is now lb — the
    // captured unit must win so the value isn't re-converted as lb.
    expect(submittedWeightUnit("kg", "lb")).toBe("kg");
    expect(submittedWeightUnit("lb", "kg")).toBe("lb");
  });

  it("falls back to the pref for an absent/garbage weight unit", () => {
    expect(submittedWeightUnit(null, "lb")).toBe("lb");
    expect(submittedWeightUnit(undefined, "kg")).toBe("kg");
    expect(submittedWeightUnit("", "lb")).toBe("lb");
    expect(submittedWeightUnit("stone", "kg")).toBe("kg");
  });

  it("trusts a valid submitted distance unit over the fallback pref", () => {
    expect(submittedDistanceUnit("km", "mi")).toBe("km");
    expect(submittedDistanceUnit("mi", "km")).toBe("mi");
  });

  it("falls back to the pref for an absent/garbage distance unit", () => {
    expect(submittedDistanceUnit(null, "mi")).toBe("mi");
    expect(submittedDistanceUnit("furlong", "km")).toBe("km");
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
