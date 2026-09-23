import { describe, expect, it } from "vitest";
import {
  planRefillNudges,
  parseRefillMarker,
  refillAttemptDue,
  cancelRefillRequest,
  refillSignalKey,
  poolRefillSignalKey,
  refillMarkerKey,
  refillIdFromMarker,
  REFILL_MARKER_PREFIX,
  leftRefillTrackedSet,
  type RefillCandidate,
} from "@/lib/refill-nudge";
import { refillCueTargets } from "@/lib/queries/upcoming/refill-targets";
import type { IntakeItem } from "@/lib/types";

// Episode-dedup + page-suppression for the low-supply refill nudge (issues #87/#227),
// mirroring the preventive nudge's plan tests. planRefillNudges is pure: given each
// tracked item's supply state, the already-nudged ids, and the ids the user
// dismissed/snoozed on the Upcoming page, it returns which items to nudge now and
// which stale markers to clear.

const low = (id: number, daysLeft = 3): RefillCandidate => ({
  id,
  name: `item-${id}`,
  daysLeft,
  low: true,
});
const ok = (id: number, daysLeft = 90): RefillCandidate => ({
  id,
  name: `item-${id}`,
  daysLeft,
  low: false,
});

describe("planRefillNudges", () => {
  it("sends every low, unmarked item when nothing has been nudged yet", () => {
    const plan = planRefillNudges([low(1), low(2)], []);
    expect(plan.toSend.map((i) => i.id)).toEqual([1, 2]);
    expect(plan.toClear).toEqual([]);
  });

  it("suppresses a still-low, already-marked item (once per episode)", () => {
    const plan = planRefillNudges([low(1), low(2)], [1]);
    expect(plan.toSend.map((i) => i.id)).toEqual([2]);
    expect(plan.toClear).toEqual([]);
  });

  it("clears a marker once its item is no longer low (episode ended)", () => {
    const plan = planRefillNudges([ok(1), low(2)], [1, 2]);
    expect(plan.toSend).toEqual([]); // item 2 still low but already marked
    expect(plan.toClear).toEqual([1]);
  });

  describe("self-healing clear for an untracked/paused item (#325)", () => {
    it("clears a marker whose item is no longer a candidate at all", () => {
      // Item 1 had a marker but was paused / had quantity tracking turned off, so it's
      // absent from the candidate set entirely. Its marker must still be swept — the
      // per-candidate branch never sees it.
      const plan = planRefillNudges([low(2)], [1, 2]);
      expect(plan.toSend).toEqual([]); // item 2 still low + marked → frozen
      expect(plan.toClear).toEqual([1]);
    });

    it("clears a marker even when NO candidates remain (all untracked)", () => {
      const plan = planRefillNudges([], [7]);
      expect(plan.toSend).toEqual([]);
      expect(plan.toClear).toEqual([7]);
    });

    it("sweeps absent markers AND recovered candidates together, sorted", () => {
      // 1 recovered (ok+marked), 3 absent+marked, 2 still low+marked (frozen).
      const plan = planRefillNudges([ok(1), low(2)], [1, 2, 3]);
      expect(plan.toSend).toEqual([]);
      expect(plan.toClear).toEqual([1, 3]);
    });

    it("re-tracking a still-low item after its marker cleared re-fires a nudge", () => {
      // Marker was swept while the item was untracked (absent). Now it's a low
      // candidate again with NO marker → a fresh nudge fires.
      const plan = planRefillNudges([low(4)], []);
      expect(plan.toSend.map((i) => i.id)).toEqual([4]);
      expect(plan.toClear).toEqual([]);
    });
  });

  it("never sends when daysLeft is unestimable, even if flagged low", () => {
    // Defensive: low but daysLeft null → no ping (matches the notifier guard).
    const plan = planRefillNudges(
      [{ id: 1, name: "x", daysLeft: null, low: true }],
      []
    );
    expect(plan.toSend).toEqual([]);
    expect(plan.toClear).toEqual([]);
  });

  describe("page suppression (#227)", () => {
    it("does not nudge a suppressed low item, and never sets its marker", () => {
      // Item is low and unmarked, but dismissed on Upcoming → no ping; since it's not
      // marked, nothing to clear either (episode stays un-started, marker frozen).
      const plan = planRefillNudges([low(1), low(2)], [], [1]);
      expect(plan.toSend.map((i) => i.id)).toEqual([2]);
      expect(plan.toClear).toEqual([]);
    });

    it("re-allows the nudge once the item is un-dismissed", () => {
      // Suppressed → no send, marker still unset.
      const suppressed = planRefillNudges([low(1)], [], [1]);
      expect(suppressed.toSend).toEqual([]);
      expect(suppressed.toClear).toEqual([]);

      // Un-dismissed (snooze expired / restored), still low + unmarked → nudge fires.
      const restored = planRefillNudges([low(1)], [], []);
      expect(restored.toSend.map((i) => i.id)).toEqual([1]);
      expect(restored.toClear).toEqual([]);
    });

    it("freezes a marked item's episode while suppressed, then no double-nudge on restore", () => {
      // Nudged (marked), then dismissed while STILL low → no re-send, marker preserved.
      const dismissed = planRefillNudges([low(1)], [1], [1]);
      expect(dismissed.toSend).toEqual([]);
      expect(dismissed.toClear).toEqual([]); // marker frozen, not cleared

      // Un-dismissed, still low + still marked → no duplicate ping (same episode).
      const restored = planRefillNudges([low(1)], [1], []);
      expect(restored.toSend).toEqual([]);
      expect(restored.toClear).toEqual([]);
    });

    it("still clears a recovered item's marker regardless of a lingering dismissal", () => {
      // Item recovered (not low) but a stale dismissal row lingers: the not-low branch
      // has no refill finding to suppress, so the episode still ends.
      const plan = planRefillNudges([ok(1)], [1], [1]);
      expect(plan.toSend).toEqual([]);
      expect(plan.toClear).toEqual([1]);
    });

    it("defaults to no suppression when the set is omitted (back-compat)", () => {
      const plan = planRefillNudges([low(1)], []);
      expect(plan.toSend.map((i) => i.id)).toEqual([1]);
    });
  });
});

describe("refillSignalKey", () => {
  it("matches the `refill:<id>` key the Upcoming refill item carries", () => {
    // The push must compute the IDENTICAL dedupeKey the pull surface uses, or a page
    // dismissal won't line up with the nudge (issue #227, the crux).
    expect(refillSignalKey(7)).toBe("refill:7");
  });
});

describe("refillMarkerKey / refillIdFromMarker (#325)", () => {
  it("builds the notify_last_refill_<id> profile-setting key", () => {
    expect(REFILL_MARKER_PREFIX).toBe("notify_last_refill_");
    expect(refillMarkerKey(42)).toBe("notify_last_refill_42");
  });

  it("round-trips the id back out of a marker key", () => {
    expect(refillIdFromMarker(refillMarkerKey(99))).toBe(99);
  });

  it("yields a non-positive/NaN id for a malformed key (filtered by the caller)", () => {
    // The notifier keeps only `Number.isInteger(id) && id > 0`, so both of these are
    // dropped: an empty suffix parses to 0, a non-numeric suffix to NaN.
    expect(refillIdFromMarker("notify_last_refill_")).toBe(0);
    expect(Number.isNaN(refillIdFromMarker("notify_last_refill_x"))).toBe(true);
  });
});

describe("leftRefillTrackedSet (#325)", () => {
  it("true when quantity tracking is turned off while active", () => {
    expect(
      leftRefillTrackedSet(
        { active: true, quantityOnHand: 30 },
        { active: true, quantityOnHand: null }
      )
    ).toBe(true);
  });

  it("true when an actively-tracked item is paused", () => {
    expect(
      leftRefillTrackedSet(
        { active: true, quantityOnHand: 30 },
        { active: false, quantityOnHand: 30 }
      )
    ).toBe(true);
  });

  it("false when the item stays in the tracked set (still active + tracked)", () => {
    // A mere quantity change below/above threshold is NOT a clear — the tick's
    // per-candidate branch owns that transition.
    expect(
      leftRefillTrackedSet(
        { active: true, quantityOnHand: 30 },
        { active: true, quantityOnHand: 2 }
      )
    ).toBe(false);
  });

  it("false when the item was never tracked (no marker to clear)", () => {
    expect(
      leftRefillTrackedSet(
        { active: true, quantityOnHand: null },
        { active: false, quantityOnHand: null }
      )
    ).toBe(false);
    expect(
      leftRefillTrackedSet(
        { active: false, quantityOnHand: 30 },
        { active: false, quantityOnHand: null }
      )
    ).toBe(false);
  });

  it("false on entering / resuming the tracked set", () => {
    expect(
      leftRefillTrackedSet(
        { active: false, quantityOnHand: 30 },
        { active: true, quantityOnHand: 30 }
      )
    ).toBe(false);
  });
});

describe("explicit refill delivery state", () => {
  const requested = {
    v: 1,
    state: "requested",
    g: "fixture0001",
    sentOn: "2026-09-08",
    dueOn: "2026-09-11",
  };
  it("allows only a due request while ordinary restored episodes stay spent", () => {
    const marker = parseRefillMarker(JSON.stringify(requested));
    expect(refillAttemptDue(marker, "2026-09-10", 0)).toBe(false);
    expect(refillAttemptDue(marker, "2026-09-11", 0)).toBe(true);
    const cancelled = cancelRefillRequest(JSON.stringify(requested));
    expect(cancelled).toBe("2026-09-08");
    expect(
      refillAttemptDue(parseRefillMarker(cancelled), "2026-09-11", 0)
    ).toBe(false);
  });

  it("blocks a live claim, recovers an expired claim and preserves no-baseline cancellation", () => {
    const raw = JSON.stringify({
      v: 1,
      state: "attempt",
      g: "fixture0001",
      sentOn: null,
      dueOn: null,
      claimUntil: 150000,
    });
    const marker = parseRefillMarker(raw);
    expect(refillAttemptDue(marker, "2026-09-08", 149999)).toBe(false);
    expect(refillAttemptDue(marker, "2026-09-08", 150000)).toBe(true);
    expect(cancelRefillRequest(raw)).toBeUndefined();
    expect(
      refillAttemptDue(parseRefillMarker("broken"), "2026-09-08", 150000)
    ).toBe(false);
  });
});

// ── The cue's control target (#5121 §9, #5907) ───────────────────────────────
//
// `refillCueTargets` is the projection Home used to spell inline: one target per cue
// KEY, minted by the two functions above. Tested here, beside the minters, because the
// two claims it makes are about THEM — that a pooled bottle is keyed on the pool and
// carried by this profile's lowest-id member (the pick `poolRefillItems` makes), and
// that only the bottle's own remembered fill, never a member's, reaches that key. Both
// used to be reachable only by rendering the page.
describe("refillCueTargets", () => {
  const cueItem = (id: number, over: Partial<IntakeItem> = {}): IntakeItem =>
    ({
      id,
      name: `item-${id}`,
      active: 1,
      supply_id: null,
      quantity_on_hand: null,
      last_fill_size: null,
      ...over,
    }) as IntakeItem;

  it("keys a private supply on the item and keeps its remembered fill", () => {
    const targets = refillCueTargets(
      [cueItem(4, { quantity_on_hand: 2, last_fill_size: 30 })],
      () => 45
    );
    expect([...targets]).toEqual([
      [refillSignalKey(4), { itemId: 4, supplyId: null, lastFillSize: 30 }],
    ]);
  });

  it("keys a bottle on the pool and carries this profile's LOWEST-id member", () => {
    // The same pick poolRefillItems makes, and made whatever order the rows arrive in
    // and whatever the carrier's own state is: an inactive member with the lowest id
    // still carries, because the pool's own math — not this projection — decides
    // whether the cue exists at all.
    for (const order of [
      [9, 7, 4],
      [4, 7, 9],
      [7, 4, 9],
    ]) {
      const targets = refillCueTargets(
        order.map((id) =>
          cueItem(id, { supply_id: 900, active: id === 4 ? 0 : 1 })
        ),
        () => null
      );
      expect(targets.get(poolRefillSignalKey(900))?.itemId).toBe(4);
      expect(targets.has(refillSignalKey(4))).toBe(false);
    }
  });

  it("gives a pooled key the bottle's own fill and never a member's", () => {
    // A member refilled at 30 while still PRIVATE and linked afterwards keeps
    // last_fill_size; it was never a fill of this jar. The bottle's own fill answers
    // (#5121 owner ruling 2026-09-16), and a bottle that remembers none asks.
    const members = [
      cueItem(2, { supply_id: 900, last_fill_size: 30 }),
      cueItem(6, { supply_id: 900, last_fill_size: 60 }),
    ];
    const asked: number[] = [];
    const remembering = refillCueTargets(members, (supplyId) => {
      asked.push(supplyId);
      return 45;
    });
    expect(remembering.get(poolRefillSignalKey(900))).toEqual({
      itemId: 2,
      supplyId: 900,
      lastFillSize: 45,
    });
    expect(asked).toEqual([900]);
    expect(
      refillCueTargets(members, () => null).get(poolRefillSignalKey(900))
    ).toEqual({ itemId: 2, supplyId: 900, lastFillSize: null });
  });
});
