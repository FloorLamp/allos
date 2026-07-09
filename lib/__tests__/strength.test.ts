import { describe, expect, it } from "vitest";
import { STANDARDS, estimate1RM, levelFor, standardFor } from "@/lib/strength";

describe("estimate1RM (Epley)", () => {
  it("returns the lifted weight for a single rep", () => {
    expect(estimate1RM(100, 1)).toBeCloseTo(100 * (1 + 1 / 30), 9);
  });

  it("estimates a higher 1RM for more reps at the same weight", () => {
    expect(estimate1RM(100, 5)).toBeGreaterThan(estimate1RM(100, 1));
  });

  it("matches the Epley formula for a known case", () => {
    // 100 kg × 10 reps → 100 * (1 + 10/30) = 133.33…
    expect(estimate1RM(100, 10)).toBeCloseTo(133.3333, 4);
  });

  it("falls back to the weight for non-positive reps", () => {
    expect(estimate1RM(100, 0)).toBe(100);
    expect(estimate1RM(100, -3)).toBe(100);
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
