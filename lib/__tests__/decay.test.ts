import { describe, it, expect } from "vitest";
import { decayedWeight, SUGGESTION_HALF_LIFE_DAYS } from "@/lib/decay";
import { rankByFrequency } from "@/lib/rank-by-frequency";

const TODAY = "2026-07-10";

describe("decayedWeight", () => {
  it("weighs an occurrence today as 1.0", () => {
    expect(decayedWeight(TODAY, TODAY)).toBe(1);
  });

  it("halves every half-life (~60 days)", () => {
    // 60 days ago -> 0.5, 120 -> 0.25, 180 -> 0.125.
    expect(decayedWeight("2026-05-11", TODAY)).toBeCloseTo(0.5, 5); // 60d
    expect(decayedWeight("2026-03-12", TODAY)).toBeCloseTo(0.25, 5); // 120d
    expect(decayedWeight("2026-01-11", TODAY)).toBeCloseTo(0.125, 5); // 180d
  });

  it("decays a summer-ago occurrence to a few percent", () => {
    // ~10 months back is deep into the tail — well under 0.05.
    const w = decayedWeight("2025-09-10", TODAY); // ~303 days
    expect(w).toBeLessThan(0.05);
    expect(w).toBeGreaterThan(0);
  });

  it("clamps a future or same-day date to 1.0 (never over-weighs)", () => {
    expect(decayedWeight("2026-08-01", TODAY)).toBe(1); // future
    expect(decayedWeight(TODAY, TODAY)).toBe(1);
  });

  it("clamps an unparseable date to 1.0 rather than dropping it", () => {
    expect(decayedWeight("not-a-date", TODAY)).toBe(1);
  });

  it("respects a custom half-life", () => {
    // With a 30-day half-life, 30 days ago -> 0.5.
    expect(decayedWeight("2026-06-10", TODAY, 30)).toBeCloseTo(0.5, 5);
  });

  it("exposes a ~60-day default half-life", () => {
    expect(SUGGESTION_HALF_LIFE_DAYS).toBe(60);
  });
});

describe("decay drives frequency ranking", () => {
  // "10x this month beats 40x ten months ago": a recent burst outranks a bigger
  // but stale pile once each occurrence is recency-weighted.
  it("hoists a recent habit over a larger stale one", () => {
    const recentWeight = 10 * decayedWeight("2026-07-01", TODAY); // ~9 days ago
    const staleWeight = 40 * decayedWeight("2025-09-15", TODAY); // ~298 days ago
    expect(recentWeight).toBeGreaterThan(staleWeight);
    const ranked = rankByFrequency(
      [],
      [
        { name: "Stale Lift", c: staleWeight },
        { name: "Recent Lift", c: recentWeight },
      ]
    );
    expect(ranked[0]).toBe("Recent Lift");
  });

  it("keeps the curated-order tiebreak when decayed weights tie", () => {
    // Two never-logged curated names both weigh 0 -> curated order wins.
    const ranked = rankByFrequency(
      ["Alpha", "Bravo"],
      [{ name: "Bravo", c: 0 }]
    );
    expect(ranked).toEqual(["Alpha", "Bravo"]);
  });
});
