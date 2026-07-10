import { describe, expect, it } from "vitest";
import {
  fitnessPercentile,
  fitnessAge,
  fitnessContext,
  hasFitnessNorms,
  FITNESS_NORM_MARKERS,
  formatPercentile,
  formatFitnessAge,
  ordinal,
} from "@/lib/fitness-norms";

// Pure percentile + fitness-age lookup over the baked norms (issue #158). No DB/
// network. Exemplars are read off the committed VO2 Max (FRIEND) male table.

describe("fitness-norms percentile lookup", () => {
  it("returns the exact grid percentile when the value equals a band's percentile point", () => {
    // Male, age 45 (a band midpoint): the 50th-percentile VO2 is 38.4 in the table.
    const p = fitnessPercentile("VO2 Max", 38.4, "male", 45);
    expect(p).not.toBeNull();
    expect(p!.percentile).toBe(50);
    expect(p!.clamped).toBeNull();
  });

  it("interpolates WITHIN a band between two percentile points", () => {
    // Male, age 45: between p50=38.4 and p60=40.6. Midpoint value → ~55th.
    const p = fitnessPercentile("VO2 Max", (38.4 + 40.6) / 2, "male", 45)!;
    expect(p.percentile).toBe(55);
    expect(p.clamped).toBeNull();
  });

  it("interpolates the value vector BETWEEN age bands (band interpolation)", () => {
    // Halfway between age 45 (p50=38.4) and age 55 (p50=35.2) → interpolated p50
    // value is (38.4+35.2)/2 = 36.8; feeding that back yields the 50th percentile.
    const p = fitnessPercentile("VO2 Max", 36.8, "male", 50)!;
    expect(p.percentile).toBe(50);
  });

  it("clamps and flags a value above the top percentile", () => {
    const p = fitnessPercentile("VO2 Max", 99, "male", 45)!;
    expect(p.percentile).toBe(90);
    expect(p.clamped).toBe("high");
  });

  it("clamps and flags a value below the bottom percentile", () => {
    const p = fitnessPercentile("VO2 Max", 5, "male", 45)!;
    expect(p.percentile).toBe(10);
    expect(p.clamped).toBe("low");
  });

  it("uses the boundary band's values for ages outside the covered range (no extrapolation)", () => {
    // Age 90 is past the oldest VO2 band (75). It should reuse the age-75 vector,
    // so the age-75 p50 value (27.2) reads as the 50th percentile.
    const p = fitnessPercentile("VO2 Max", 27.2, "male", 90)!;
    expect(p.percentile).toBe(50);
  });
});

describe("fitness age", () => {
  it("equals the band age when the value matches that band's median", () => {
    // Male p50 at age 45 is 38.4 → fitness age 45.
    const fa = fitnessAge("VO2 Max", 38.4, "male", 45)!;
    expect(fa.fitnessAge).toBe(45);
    expect(fa.clamped).toBeNull();
  });

  it("gives a younger fitness age for a value above your age's median", () => {
    // A 55-year-old with a 45-year-old's median (38.4) is fitter than their age.
    const fa = fitnessAge("VO2 Max", 38.4, "male", 55)!;
    expect(fa.fitnessAge).toBe(45);
    expect(fa.fitnessAge).toBeLessThan(55);
  });

  it("interpolates fitness age between band medians", () => {
    // Between age-45 median (38.4) and age-55 median (35.2): the midpoint value
    // 36.8 → fitness age 50.
    const fa = fitnessAge("VO2 Max", 36.8, "male", 40)!;
    expect(fa.fitnessAge).toBe(50);
  });

  it("clamps fitness age low when fitter than the youngest band", () => {
    const fa = fitnessAge("VO2 Max", 99, "male", 60)!;
    expect(fa.fitnessAge).toBe(25); // youngest band midpoint
    expect(fa.clamped).toBe("low");
  });

  it("clamps fitness age high when below the oldest band's median", () => {
    const fa = fitnessAge("VO2 Max", 5, "male", 30)!;
    expect(fa.fitnessAge).toBe(75); // oldest band midpoint
    expect(fa.clamped).toBe("high");
  });
});

describe("age/sex gating (hidden when unset or non-adult)", () => {
  it("hides when sex is unset", () => {
    expect(fitnessPercentile("VO2 Max", 45, null, 40)).toBeNull();
    expect(fitnessAge("VO2 Max", 45, null, 40)).toBeNull();
    expect(fitnessContext("VO2 Max", 45, null, 40)).toBeNull();
  });

  it("hides when age is unset", () => {
    expect(fitnessPercentile("VO2 Max", 45, "male", null)).toBeNull();
    expect(fitnessContext("VO2 Max", 45, "male", undefined)).toBeNull();
  });

  it("hides for a child (adult-context norms)", () => {
    expect(fitnessPercentile("VO2 Max", 45, "female", 8)).toBeNull();
    expect(fitnessContext("VO2 Max", 45, "female", 8)).toBeNull();
  });

  it("hides for a marker with no norms", () => {
    expect(fitnessPercentile("Total Cholesterol", 180, "male", 40)).toBeNull();
    expect(hasFitnessNorms("Total Cholesterol")).toBe(false);
  });

  it("hides for a missing/non-finite value", () => {
    expect(fitnessPercentile("VO2 Max", null, "male", 40)).toBeNull();
    expect(fitnessPercentile("VO2 Max", NaN, "male", 40)).toBeNull();
  });
});

describe("sex-specific norms", () => {
  it("scores male and female differently for the same value", () => {
    // 37.6 is the female age-25 p50 but well below the male age-25 p50 (43.9).
    const male = fitnessPercentile("VO2 Max", 37.6, "male", 25)!;
    const female = fitnessPercentile("VO2 Max", 37.6, "female", 25)!;
    expect(female.percentile).toBe(50);
    expect(male.percentile).toBeLessThan(50);
  });
});

describe("fitnessContext bundle", () => {
  it("bundles percentile + fitness age + unit/source", () => {
    const ctx = fitnessContext("Grip Strength", 48, "male", 45)!;
    expect(ctx.unit).toBe("kg");
    expect(ctx.source).toMatch(/Dodds/);
    expect(ctx.percentile.percentile).toBe(50);
    expect(ctx.fitnessAge).not.toBeNull();
  });
});

describe("every declared marker resolves norms for both sexes (anti-drift)", () => {
  it("resolves a percentile for each marker/sex at a covered adult age", () => {
    for (const name of FITNESS_NORM_MARKERS) {
      for (const sex of ["male", "female"] as const) {
        // age 65 is inside every marker's covered range (incl. chair-stand 60+).
        const p = fitnessPercentile(name, 20, sex, 65);
        expect(p, `${name}/${sex}`).not.toBeNull();
      }
    }
  });

  it("exposes the four expected markers", () => {
    expect(FITNESS_NORM_MARKERS).toEqual(
      expect.arrayContaining([
        "VO2 Max",
        "Grip Strength",
        "30-Second Chair Stand",
        "Single-Leg Balance",
      ])
    );
  });
});

describe("formatters", () => {
  it("ordinal suffixes", () => {
    expect(ordinal(1)).toBe("1st");
    expect(ordinal(2)).toBe("2nd");
    expect(ordinal(3)).toBe("3rd");
    expect(ordinal(11)).toBe("11th");
    expect(ordinal(12)).toBe("12th");
    expect(ordinal(13)).toBe("13th");
    expect(ordinal(82)).toBe("82nd");
    expect(ordinal(90)).toBe("90th");
  });

  it("percentile phrases carry the clamp direction", () => {
    expect(formatPercentile({ percentile: 82, clamped: null })).toBe(
      "82nd percentile"
    );
    expect(formatPercentile({ percentile: 90, clamped: "high" })).toBe(
      "≥ 90th percentile"
    );
    expect(formatPercentile({ percentile: 10, clamped: "low" })).toBe(
      "≤ 10th percentile"
    );
  });

  it("fitness-age phrases carry the clamp direction", () => {
    expect(formatFitnessAge({ fitnessAge: 39, clamped: null })).toBe("39");
    expect(formatFitnessAge({ fitnessAge: 25, clamped: "low" })).toBe("≤ 25");
    expect(formatFitnessAge({ fitnessAge: 85, clamped: "high" })).toBe("≥ 85");
  });
});
