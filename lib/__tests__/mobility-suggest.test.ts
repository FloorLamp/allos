import { describe, it, expect } from "vitest";
import {
  mobilitySuggestions,
  mobilitySuggestSignalKey,
  MOBILITY_SUGGEST_PREFIX,
  LOW_PERCENTILE,
  FLEXIBILITY_REGION,
  BALANCE_REGION,
} from "@/lib/mobility-suggest";
import { dedupeKeyHasKnownPrefix } from "@/lib/rule-finding-prefixes";

// Pure deficit→habit suggestion logic (#840 phase 2). Suggest-only, calm, and closed on
// accept (a region already targeted is never re-suggested). No DB/network.

describe("mobilitySuggestions", () => {
  const none = {
    sitReachPercentile: null,
    balancePercentile: null,
    recoveringRegions: [],
    existingTargetRegions: new Set<never>(),
  };

  it("suggests nothing without a low measurement or a recovering injury", () => {
    expect(mobilitySuggestions(none)).toEqual([]);
    // A healthy percentile is above the nudge threshold — no suggestion.
    expect(
      mobilitySuggestions({ ...none, sitReachPercentile: 60 })
    ).toEqual([]);
  });

  it("suggests the posterior-chain region for a low sit-and-reach percentile", () => {
    const out = mobilitySuggestions({
      ...none,
      sitReachPercentile: LOW_PERCENTILE,
    });
    expect(out.length).toBe(1);
    expect(out[0].region).toBe(FLEXIBILITY_REGION);
    expect(out[0].source).toBe("flexibility");
    expect(out[0].perWeek).toBe(3);
    expect(out[0].dedupeKey).toBe(
      mobilitySuggestSignalKey(FLEXIBILITY_REGION, "flexibility")
    );
    expect(out[0].dedupeKey.startsWith(MOBILITY_SUGGEST_PREFIX)).toBe(true);
    expect(dedupeKeyHasKnownPrefix(out[0].dedupeKey)).toBe(true);
  });

  it("suggests hip/ankle stability for a low balance percentile", () => {
    const out = mobilitySuggestions({ ...none, balancePercentile: 10 });
    expect(out.length).toBe(1);
    expect(out[0].region).toBe(BALANCE_REGION);
    expect(out[0].source).toBe("balance");
  });

  it("suggests gentle mobility for a recovering injury region (soft, note-only)", () => {
    const out = mobilitySuggestions({
      ...none,
      recoveringRegions: ["Shoulders"],
    });
    expect(out.length).toBe(1);
    expect(out[0].region).toBe("Shoulders");
    expect(out[0].source).toBe("injury");
    // Soft language — not a rehab plan.
    expect(out[0].detail).toMatch(/soft suggestion|not a rehab/i);
  });

  it("never re-suggests a region that already has a mobility_region target (#580 closed loop)", () => {
    const out = mobilitySuggestions({
      ...none,
      sitReachPercentile: 5,
      existingTargetRegions: new Set([FLEXIBILITY_REGION]),
    });
    expect(out).toEqual([]);
  });

  it("does not nudge the same region twice across sources", () => {
    // Legs is both the flexibility target and a recovering-injury region — one suggestion.
    const out = mobilitySuggestions({
      ...none,
      sitReachPercentile: 5,
      recoveringRegions: ["Legs"],
    });
    const legs = out.filter((s) => s.region === "Legs");
    expect(legs.length).toBe(1);
    // Flexibility wins the priority order.
    expect(legs[0].source).toBe("flexibility");
  });
});
