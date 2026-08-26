import { describe, expect, it } from "vitest";
import {
  BASELINE_DIALS,
  DEFAULT_SEED,
  NAMED_SEED_DIAL_SHAPES,
  describeDials,
  jitterStream,
  mulberry32,
  sampleDials,
  sampleNumberedDials,
  seedDialsFromEnv,
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
  it("pins the historical baseline bytes and representative numbered vectors", () => {
    // Equality to BASELINE_DIALS alone lets the constant and sampler drift
    // together. These literals are the external contract: the demo/e2e look and
    // existing documented SEED_RNG numbers do not move when named shapes grow.
    expect(BASELINE_DIALS).toEqual({
      illnessNow: "active",
      importQuirks: "clean",
      volume: "lean",
      gapiness: "continuous",
      textLength: "short",
      middleState: "baseline",
    });
    expect(sampleDials(3)).toEqual({
      illnessNow: "past",
      importQuirks: "clean",
      volume: "lean",
      gapiness: "continuous",
      textLength: "long",
      middleState: "baseline",
    });
    expect(sampleDials(40)).toEqual({
      illnessNow: "past",
      importQuirks: "quirky",
      volume: "lean",
      gapiness: "gappy",
      textLength: "short",
      middleState: "baseline",
    });
    expect(sampleDials(99)).toEqual({
      illnessNow: "active",
      importQuirks: "quirky",
      volume: "heavy",
      gapiness: "gappy",
      textLength: "short",
      middleState: "baseline",
    });
  });

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

  it("varies every randomized dial while the named-only middle state stays baseline", () => {
    // Existence of variety — if a randomized dial can never leave its baseline
    // value the feature silently regressed to one look again. middleState is the
    // deliberate opposite: numbered seeds never select it or spend a draw on it.
    const seen: Record<keyof SeedDials, Set<string>> = {
      illnessNow: new Set(),
      importQuirks: new Set(),
      volume: new Set(),
      gapiness: new Set(),
      textLength: new Set(),
      middleState: new Set(),
    };
    for (let seed = 2; seed <= 40; seed++) {
      const dials = sampleDials(seed);
      for (const k of Object.keys(seen) as (keyof SeedDials)[]) {
        seen[k].add(dials[k]);
      }
    }
    for (const k of Object.keys(seen) as (keyof SeedDials)[]) {
      expect(seen[k].size, `dial ${k} varied unexpectedly`).toBe(
        k === "middleState" ? 1 : 2
      );
    }
  });

  it("adds the named-only middle-state registration point without another numbered-seed draw", () => {
    let draws = 0;
    const dials = sampleNumberedDials(() => {
      draws += 1;
      return 0.25;
    });
    expect(draws).toBe(5);
    expect(dials).toEqual({
      illnessNow: "active",
      importQuirks: "clean",
      volume: "lean",
      gapiness: "continuous",
      textLength: "short",
      middleState: "baseline",
    });
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

describe("named seed dial shapes", () => {
  it("pins dirty directly to the two existing dirty-data dimensions", () => {
    expect(NAMED_SEED_DIAL_SHAPES).toEqual([
      {
        name: "dirty",
        description: "portal import quirks + long uncontrolled names",
        dials: {
          illnessNow: "active",
          importQuirks: "quirky",
          volume: "lean",
          gapiness: "continuous",
          textLength: "long",
          middleState: "baseline",
        },
      },
      {
        name: "one-cycle",
        description: "two periods yielding one completed cycle",
        dials: {
          illnessNow: "active",
          importQuirks: "clean",
          volume: "lean",
          gapiness: "continuous",
          textLength: "short",
          middleState: "one-completed-cycle",
        },
      },
    ]);
  });

  it("selects a named vector without sampling or mutating the registry", () => {
    const selection = seedDialsFromEnv({ SEED_DIAL_SHAPE: "dirty" });
    expect(selection.kind).toBe("named");
    if (selection.kind !== "named") return;
    expect(selection.dials).toEqual(selection.shape.dials);
    selection.dials.importQuirks = "clean";
    expect(selection.shape.dials.importQuirks).toBe("quirky");
  });

  it("selects the one-cycle middle state without changing any entropy dimension", () => {
    const selection = seedDialsFromEnv({ SEED_DIAL_SHAPE: "one-cycle" });
    expect(selection.kind).toBe("named");
    if (selection.kind !== "named") return;
    expect(selection.dials).toEqual({
      ...BASELINE_DIALS,
      middleState: "one-completed-cycle",
    });
    expect(describeDials(selection.dials)).toBe("one completed cycle");
  });

  it("fails unknown names and conflicts instead of falling back", () => {
    expect(seedDialsFromEnv({ SEED_DIAL_SHAPE: "dritty" })).toEqual({
      kind: "unknown",
      raw: "dritty",
      known: ["dirty", "one-cycle"],
    });
    expect(
      seedDialsFromEnv({ SEED_DIAL_SHAPE: "dirty", SEED_RNG: "7" })
    ).toEqual({
      kind: "conflict",
      raw: "dirty",
      reason: "SEED_DIAL_SHAPE=dirty pins a complete vector; remove SEED_RNG",
    });
  });
});
