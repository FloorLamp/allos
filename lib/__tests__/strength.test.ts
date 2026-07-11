import { describe, expect, it } from "vitest";
import { E1RM_REP_CAP, estimate1RM } from "@/lib/strength";

// The strength LEVEL/standard logic (levelFor/standardFor/STANDARDS/…) was retired
// in favor of the single bodyweight-band model in lib/strength-standards.ts (#152);
// its tests live in lib/__tests__/strength-standards*.test.ts. Only 1RM estimation
// remains here.

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
