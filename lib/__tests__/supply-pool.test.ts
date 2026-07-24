import { describe, expect, it } from "vitest";
import {
  pooledUnitsPerDay,
  daysOfSupplyForPool,
  resolvePoolUnlinkRestore,
  daysOfSupplyLeft,
} from "@/lib/refill";
import {
  planPoolDispatchProfiles,
  planPoolRefillNudges,
  poolRefillSignalKey,
  poolRefillMarkerKey,
  poolRefillIdFromMarker,
  POOL_REFILL_MARKER_PREFIX,
} from "@/lib/refill-nudge";
import { resolveSuppressedKeyDisplay } from "@/lib/suppression-display";

// Pure tests for the shared supply pool math + episode/dispatch decisions (#1374).
// The DB gather, the pool-aware decrement, and the notify wiring are covered in the
// DB/action tiers; everything decidable without a database lives here.

describe("pooledUnitsPerDay", () => {
  it("sums each linked item's own doses/day × its own units/dose", () => {
    // An adult taking 2 tablets twice a day and a child taking 1 tablet once a day
    // draw 4 + 1 = 5 units/day from the same bottle.
    expect(
      pooledUnitsPerDay([
        { dosesPerDay: 2, qtyPerDose: 2 },
        { dosesPerDay: 1, qtyPerDose: 1 },
      ])
    ).toBe(5);
  });

  it("is zero for no consumers and drops non-positive contributions", () => {
    expect(pooledUnitsPerDay([])).toBe(0);
    expect(
      pooledUnitsPerDay([
        { dosesPerDay: 0, qtyPerDose: 3 },
        { dosesPerDay: 1, qtyPerDose: 0 },
        { dosesPerDay: 2, qtyPerDose: 1 },
      ])
    ).toBe(2);
  });

  it("mixes an actual-rate (fractional) and a schedule-estimate basis", () => {
    // basis 'history' rates are fractional (confirmed ÷ window); the pool sums them
    // with a whole scheduled-count estimate without special-casing either.
    expect(
      pooledUnitsPerDay([
        { dosesPerDay: 0.5, qtyPerDose: 2 },
        { dosesPerDay: 3, qtyPerDose: 1 },
      ])
    ).toBe(4);
  });
});

describe("daysOfSupplyForPool", () => {
  it("floors the pooled quantity over the summed rate", () => {
    expect(
      daysOfSupplyForPool(50, [
        { dosesPerDay: 2, qtyPerDose: 2 },
        { dosesPerDay: 1, qtyPerDose: 1 },
      ])
    ).toBe(10); // 50 / 5
  });

  it("reads LOWER than either member's private projection would", () => {
    // The bug pools fix: 60 units split across two members who each project against
    // the whole bottle read 30 and 60 days; the pooled truth is 20.
    const consumers = [
      { dosesPerDay: 2, qtyPerDose: 1 },
      { dosesPerDay: 1, qtyPerDose: 1 },
    ];
    expect(daysOfSupplyForPool(60, consumers)).toBe(20);
    expect(daysOfSupplyLeft(60, 1, 2)).toBe(30);
    expect(daysOfSupplyLeft(60, 1, 1)).toBe(60);
  });

  it("is null when untracked or nothing consumes it, and 0 when empty", () => {
    expect(daysOfSupplyForPool(null, [{ dosesPerDay: 1, qtyPerDose: 1 }])).toBe(
      null
    );
    expect(daysOfSupplyForPool(30, [])).toBe(null);
    expect(daysOfSupplyForPool(0, [{ dosesPerDay: 1, qtyPerDose: 1 }])).toBe(0);
  });
});

describe("resolvePoolUnlinkRestore", () => {
  it("gives the whole remaining count back to a SOLE linked item", () => {
    expect(resolvePoolUnlinkRestore(42, 1)).toBe(42);
  });

  it("returns NULL (untracked) for two or more, never N copies of one bottle", () => {
    expect(resolvePoolUnlinkRestore(42, 2)).toBe(null);
    expect(resolvePoolUnlinkRestore(42, 5)).toBe(null);
  });

  it("restores null for an untracked pool regardless of membership", () => {
    expect(resolvePoolUnlinkRestore(null, 1)).toBe(null);
    expect(resolvePoolUnlinkRestore(null, 3)).toBe(null);
  });

  it("restores nothing when the pool had no members at all", () => {
    expect(resolvePoolUnlinkRestore(42, 0)).toBe(null);
  });
});

describe("planPoolDispatchProfiles", () => {
  const p = (profileId: number, loginIds: number[]) => ({
    profileId,
    loginIds,
  });

  it("sends ONCE when one caregiver manages every linked profile", () => {
    // The ordinary household: one bottle, two kids, one parent login.
    expect(planPoolDispatchProfiles([p(2, [7]), p(3, [7])])).toEqual([2]);
  });

  it("sends once when both caregivers manage both linked profiles", () => {
    expect(planPoolDispatchProfiles([p(2, [7, 8]), p(3, [7, 8])])).toEqual([2]);
  });

  it("reaches a split caregiver who manages only the second profile", () => {
    // Two different people — two messages is correct, not a duplicate.
    expect(planPoolDispatchProfiles([p(2, [7]), p(3, [9])])).toEqual([2, 3]);
  });

  it("skips a linked profile with no managing login", () => {
    expect(planPoolDispatchProfiles([p(2, []), p(3, [9])])).toEqual([3]);
    expect(planPoolDispatchProfiles([p(2, []), p(3, [])])).toEqual([]);
  });

  it("is order-independent (walks linked profiles by id)", () => {
    expect(planPoolDispatchProfiles([p(9, [7]), p(4, [7])])).toEqual([4]);
  });
});

describe("pool episode keys + plan", () => {
  it("keys the finding and the marker on the POOL, not a member item", () => {
    expect(poolRefillSignalKey(12)).toBe("pool-refill:12");
    expect(poolRefillMarkerKey(12)).toBe("notify_last_pool_refill_12");
    expect(poolRefillIdFromMarker(poolRefillMarkerKey(12))).toBe(12);
    expect(poolRefillMarkerKey(12).startsWith(POOL_REFILL_MARKER_PREFIX)).toBe(
      true
    );
  });

  it("resolves the pooled key in the shared suppression-display registry", () => {
    // #203/#1151: a suppressed pool key must render a real label in the central
    // "Snoozed & dismissed" section, not the orphan fallback.
    const d = resolveSuppressedKeyDisplay(poolRefillSignalKey(12));
    expect(d).toEqual({
      domain: "Due & scheduled",
      label: "Shared-supply refill nudge",
    });
  });

  it("nudges once per low episode, freezes a suppressed pool, sweeps a dead marker", () => {
    const low = { id: 1, name: "Ibuprofen 200 mg", daysLeft: 3, low: true };
    const recovered = { id: 2, name: "Vitamin D", daysLeft: 40, low: false };

    // First run: the low pool sends; the recovered pool's stale marker clears.
    expect(planPoolRefillNudges([low, recovered], [2])).toEqual({
      toSend: [{ id: 1, name: "Ibuprofen 200 mg", daysLeft: 3 }],
      toClear: [2],
    });
    // Already marked → silent while the episode stands.
    expect(planPoolRefillNudges([low], [1]).toSend).toEqual([]);
    // Suppressed by a linked member's dismissal → held out AND not cleared (frozen).
    expect(planPoolRefillNudges([low], [], [1])).toEqual({
      toSend: [],
      toClear: [],
    });
    // A marker whose pool is gone entirely is swept (#325 self-healing).
    expect(planPoolRefillNudges([], [99]).toClear).toEqual([99]);
  });
});
