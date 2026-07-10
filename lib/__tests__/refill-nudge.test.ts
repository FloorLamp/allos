import { describe, expect, it } from "vitest";
import {
  planRefillNudges,
  refillSignalKey,
  type RefillCandidate,
} from "@/lib/refill-nudge";

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
