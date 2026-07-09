import { describe, expect, it } from "vitest";
import {
  E1RM_REP_CAP,
  STANDARDS,
  STANDARDS_FEMALE,
  estimate1RM,
  levelFor,
  standardFor,
} from "@/lib/strength";

describe("estimate1RM (Epley, capped)", () => {
  it("returns the lifted weight for a single rep", () => {
    expect(estimate1RM(100, 1)).toBeCloseTo(100 * (1 + 1 / 30), 9);
  });

  it("estimates a higher 1RM for more reps at the same weight", () => {
    expect(estimate1RM(100, 5)).toBeGreaterThan(estimate1RM(100, 1));
  });

  it("matches the Epley formula in the accurate low-rep range", () => {
    // 100 kg × 10 reps → 100 * (1 + 10/30) = 133.33… (10 <= cap, untouched).
    expect(estimate1RM(100, 10)).toBeCloseTo(133.3333, 4);
  });

  it("falls back to the weight for non-positive reps", () => {
    expect(estimate1RM(100, 0)).toBe(100);
    expect(estimate1RM(100, -3)).toBe(100);
  });

  it("caps the rep contribution past E1RM_REP_CAP so high-rep sets don't inflate", () => {
    const atCap = estimate1RM(100, E1RM_REP_CAP);
    // Anything past the cap scores exactly as a cap-rep set (no further climb).
    expect(estimate1RM(100, E1RM_REP_CAP + 1)).toBe(atCap);
    expect(estimate1RM(100, 20)).toBe(atCap);
    expect(estimate1RM(100, 30)).toBe(atCap);
    // And that value is the capped Epley estimate, well below raw Epley at 20.
    expect(atCap).toBeCloseTo(100 * (1 + E1RM_REP_CAP / 30), 9);
    expect(estimate1RM(100, 20)).toBeLessThan(100 * (1 + 20 / 30));
  });

  it("is still monotonic up to the cap", () => {
    expect(estimate1RM(100, 12)).toBeGreaterThan(estimate1RM(100, 11));
  });
});

describe("standardFor", () => {
  it("looks up case- and whitespace-insensitively", () => {
    expect(standardFor("Bench Press")).toBe(STANDARDS["bench press"]);
    expect(standardFor("  squat  ")).toBe(STANDARDS["squat"]);
  });

  it("resolves known aliases and the newer lifts", () => {
    expect(standardFor("back squat")).toBeDefined();
    expect(standardFor("front squat")).toBeDefined();
    expect(standardFor("incline bench press")).toBeDefined();
    expect(standardFor("chin up")).toBeDefined();
  });

  it("maps barbell (and bare) variants to the base lift's standard", () => {
    expect(standardFor("Barbell Bench Press")).toBe(STANDARDS["bench press"]);
    expect(standardFor("Barbell Overhead Press")).toBe(
      STANDARDS["overhead press"]
    );
  });

  it("does not apply a barbell standard to other equipment variants", () => {
    expect(standardFor("Dumbbell Bench Press")).toBeUndefined();
    expect(standardFor("Dumbbell Curl")).toBeUndefined();
  });

  it("returns undefined for an unknown exercise", () => {
    expect(standardFor("nordic curl")).toBeUndefined();
  });

  it("defaults to the male/unspecified table when no sex is given (backward compatible)", () => {
    expect(standardFor("bench press")).toBe(STANDARDS["bench press"]);
    expect(standardFor("bench press", null)).toBe(STANDARDS["bench press"]);
    expect(standardFor("bench press", "male")).toBe(STANDARDS["bench press"]);
  });

  it("uses the female table for a female profile", () => {
    expect(standardFor("bench press", "female")).toBe(
      STANDARDS_FEMALE["bench press"]
    );
    // Female standards sit below male ones at every level (common-chart split).
    const m = STANDARDS["bench press"];
    const f = STANDARDS_FEMALE["bench press"];
    expect(f.beginner).toBeLessThan(m.beginner);
    expect(f.elite).toBeLessThan(m.elite);
  });

  it("maps barbell variants through the sex-appropriate table", () => {
    expect(standardFor("Barbell Bench Press", "female")).toBe(
      STANDARDS_FEMALE["bench press"]
    );
  });
});

describe("levelFor", () => {
  const s = standardFor("bench press")!; // 0.75 / 1.0 / 1.5 / 2.0

  it("labels by ascending threshold", () => {
    expect(levelFor(0.5, s).label).toBe("Beginner");
    expect(levelFor(0.8, s).label).toBe("Novice");
    expect(levelFor(1.2, s).label).toBe("Intermediate");
    expect(levelFor(1.7, s).label).toBe("Advanced");
    expect(levelFor(2.5, s).label).toBe("Elite");
  });

  it("treats a threshold boundary as the higher tier (>=)", () => {
    expect(levelFor(2.0, s).label).toBe("Elite");
    expect(levelFor(0.75, s).label).toBe("Novice");
  });
});
