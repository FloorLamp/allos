import { describe, expect, it } from "vitest";
import {
  BASELINE_DIALS,
  DEFAULT_SEED,
  describeDials,
  jitterStream,
  mulberry32,
  sampleDials,
  seedFromEnv,
  type SeedDials,
} from "../../scripts/seed-rng";

// The seed-entropy contracts (#2594). These are the pins that make entropy a
// seeing-tool feature instead of flake: the default look never moves, a seed's
// look never moves, and the jitter stream can't re-deal the dials.

describe("mulberry32", () => {
  it("is deterministic per seed and distinct across seeds", () => {
    const a1 = mulberry32(42);
    const a2 = mulberry32(42);
    const b = mulberry32(43);
    const seqA1 = [a1(), a1(), a1()];
    const seqA2 = [a2(), a2(), a2()];
    const seqB = [b(), b(), b()];
    expect(seqA1).toEqual(seqA2);
    expect(seqA1).not.toEqual(seqB);
    for (const v of seqA1) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe("sampleDials", () => {
  it("pins DEFAULT_SEED to the baseline look, by construction", () => {
    // npm run seed, the e2e template DB, and census --baseline diffing all
    // rely on the unset/default seed producing the historical hand-authored
    // look. This must hold no matter how the dial table evolves.
    expect(sampleDials(DEFAULT_SEED)).toEqual(BASELINE_DIALS);
  });

  it("is deterministic: the same seed always deals the same dials", () => {
    for (const seed of [2, 7, 99, 12345]) {
      expect(sampleDials(seed)).toEqual(sampleDials(seed));
    }
  });

  it("actually varies: every dial takes both values across a small seed range", () => {
    // Existence of variety — if a dial can never leave its baseline value the
    // feature silently regressed to one look again.
    const seen: Record<keyof SeedDials, Set<string>> = {
      illnessNow: new Set(),
      importQuirks: new Set(),
      volume: new Set(),
      gapiness: new Set(),
      textLength: new Set(),
    };
    for (let seed = 2; seed <= 40; seed++) {
      const dials = sampleDials(seed);
      for (const k of Object.keys(seen) as (keyof SeedDials)[]) {
        seen[k].add(dials[k]);
      }
    }
    for (const k of Object.keys(seen) as (keyof SeedDials)[]) {
      expect(seen[k].size, `dial ${k} never varied`).toBe(2);
    }
  });

  it("jitter consumption cannot re-deal a seed's dials", () => {
    // The two streams are independent by construction; this is the regression
    // trap for someone "simplifying" them into one shared rng.
    const before = sampleDials(7);
    const jitter = jitterStream(7);
    for (let i = 0; i < 100; i++) jitter();
    expect(sampleDials(7)).toEqual(before);
  });

  it("jitter is deterministic per seed too", () => {
    const a = jitterStream(7);
    const b = jitterStream(7);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });
});

describe("describeDials", () => {
  it("names only the non-baseline dials, and the baseline plainly", () => {
    expect(describeDials(BASELINE_DIALS)).toBe("baseline look");
    expect(
      describeDials({
        ...BASELINE_DIALS,
        volume: "heavy",
        illnessNow: "past",
      })
    ).toBe("past illness + heavy volume");
  });
});

describe("seedFromEnv", () => {
  it("falls back to DEFAULT_SEED on absent, empty, or malformed input", () => {
    // A typo must produce the pinned look, never a silently different one.
    expect(seedFromEnv({})).toBe(DEFAULT_SEED);
    expect(seedFromEnv({ SEED_RNG: "" })).toBe(DEFAULT_SEED);
    expect(seedFromEnv({ SEED_RNG: "  " })).toBe(DEFAULT_SEED);
    expect(seedFromEnv({ SEED_RNG: "seven" })).toBe(DEFAULT_SEED);
    expect(seedFromEnv({ SEED_RNG: "1.5" })).toBe(DEFAULT_SEED);
  });

  it("parses an integer seed", () => {
    expect(seedFromEnv({ SEED_RNG: "7" })).toBe(7);
    expect(seedFromEnv({ SEED_RNG: " 42 " })).toBe(42);
  });
});
