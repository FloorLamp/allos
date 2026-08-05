// PURE TIER — the one-tap logging substrate (#2041, #2007).
//
// Three things under test, matching the three the module owns: the feedback
// registry's invariants (a confirm can never leak onto an additive tap), the ledger
// state machine (bump → rollback restores the pre-tap value → reconcile adopts the
// server's total even when it disagrees), and the cadence-aware re-log decision.

import { describe, expect, it } from "vitest";
import {
  DEFAULT_SUPPLY_CYCLE_DAYS,
  ONE_TAP_AFFORDANCES,
  POST_SUCCESS_COOLDOWN_MS,
  REFILL_CONFIRM_MAX_DAYS,
  acceptsTap,
  elapsedPhrase,
  initialLedger,
  ledgerReducer,
  oneTapAffordance,
  practiceRelogMessage,
  refillConfirmWindowDays,
  refillRelogMessage,
  shouldConfirmRelog,
  type LedgerState,
  type OneTapAffordance,
} from "@/lib/one-tap";

const ids = Object.keys(ONE_TAP_AFFORDANCES) as OneTapAffordance[];

describe("the one-tap affordance registry (#2041 finding 2)", () => {
  it("declares an expected interval on exactly the cadenced affordances", () => {
    for (const id of ids) {
      const decl = oneTapAffordance(id);
      if (decl.repeat === "cadenced") {
        expect(decl.expectedInterval, id).not.toBe("none");
      } else {
        // The leak guard, stated as data: an additive or idempotent tap declares
        // `none` explicitly, which is what makes shouldConfirmRelog's early return
        // unconditional.
        expect(decl.expectedInterval, id).toBe("none");
      }
    }
  });

  it("gives every affordance a feedback design and a reason", () => {
    for (const id of ids) {
      const decl = oneTapAffordance(id);
      expect(
        ["optimistic-count", "cooldown", "outcome-toast", "recency-line"],
        id
      ).toContain(decl.feedback);
      expect(decl.why.length, id).toBeGreaterThan(20);
    }
  });

  it("classifies the two taps that expect an interval and no others", () => {
    const cadenced = ids.filter(
      (id) => oneTapAffordance(id).repeat === "cadenced"
    );
    expect(cadenced.sort()).toEqual(["medication-refill", "practice-session"]);
  });
});

describe("the ledger state machine (#2041 finding 1)", () => {
  const start = initialLedger(3);

  it("bumps optimistically and holds the pre-tap value", () => {
    const tapped = ledgerReducer(start, { kind: "tap", optimistic: 4 });
    expect(tapped.value).toBe(4);
    expect(tapped.phase).toBe("writing");
    expect(tapped.preTap).toBe(3);
  });

  it("rolls back to the pre-tap value, not to an inverted delta", () => {
    const tapped = ledgerReducer(start, { kind: "tap", optimistic: 4 });
    const rolled = ledgerReducer(tapped, {
      kind: "settled",
      settlement: { kind: "rollback" },
    });
    expect(rolled.value).toBe(3);
    // A refused write must be immediately retryable — no cooldown after a failure.
    expect(rolled.phase).toBe("ready");
    expect(rolled.preTap).toBeNull();
  });

  it("adopts the server total even when it disagrees with the optimistic value", () => {
    // The drift case that motivated the pattern: another device logged two servings
    // between render and response, so the authoritative total is 9, not the 4 this
    // tap guessed.
    const tapped = ledgerReducer(start, { kind: "tap", optimistic: 4 });
    const settled = ledgerReducer(tapped, {
      kind: "settled",
      settlement: { kind: "adopt", value: 9 },
    });
    expect(settled.value).toBe(9);
    expect(settled.phase).toBe("cooldown");
    expect(settled.preTap).toBeNull();
  });

  it("keeps the optimistic value when the write was captured elsewhere", () => {
    // The offline queue: nothing authoritative came back, and the optimistic count
    // stands in for the queued write until replay.
    const tapped = ledgerReducer(start, { kind: "tap", optimistic: 4 });
    const kept = ledgerReducer(tapped, {
      kind: "settled",
      settlement: { kind: "keep" },
    });
    expect(kept.value).toBe(4);
    expect(kept.phase).toBe("cooldown");
  });

  it("absorbs a second tap while writing and inside the cooldown (#2007 layer 1)", () => {
    const writing = ledgerReducer(start, { kind: "tap", optimistic: 4 });
    expect(acceptsTap(writing.phase)).toBe(false);
    expect(ledgerReducer(writing, { kind: "tap", optimistic: 5 })).toBe(
      writing
    );

    const cooling = ledgerReducer(writing, {
      kind: "settled",
      settlement: { kind: "adopt", value: 4 },
    });
    expect(acceptsTap(cooling.phase)).toBe(false);
    expect(ledgerReducer(cooling, { kind: "tap", optimistic: 5 })).toBe(
      cooling
    );

    const cooled = ledgerReducer(cooling, { kind: "cooled" });
    expect(acceptsTap(cooled.phase)).toBe(true);
    // The value the cooldown was holding survives it — cooling down is not a reset.
    expect(cooled.value).toBe(4);
  });

  it("ignores events that cannot apply in the current phase", () => {
    const ready: LedgerState<number> = start;
    expect(
      ledgerReducer(ready, { kind: "settled", settlement: { kind: "keep" } })
    ).toBe(ready);
    expect(ledgerReducer(ready, { kind: "cooled" })).toBe(ready);
  });

  it("keeps the cooldown short enough to be a debounce, not a lockout", () => {
    expect(POST_SUCCESS_COOLDOWN_MS).toBeGreaterThanOrEqual(1000);
    expect(POST_SUCCESS_COOLDOWN_MS).toBeLessThanOrEqual(3000);
  });
});

describe("shouldConfirmRelog (#2007 layer 3)", () => {
  it("never confirms an affordance that declares no interval, however recent", () => {
    const now = Date.UTC(2026, 7, 5, 12, 0, 0);
    for (const id of ids) {
      if (oneTapAffordance(id).expectedInterval !== "none") continue;
      expect(
        shouldConfirmRelog({
          affordance: id,
          lastLoggedDate: "2026-08-05",
          today: "2026-08-05",
          lastLoggedAtMs: now - 1000,
          nowMs: now,
        }),
        id
      ).toBe(false);
    }
  });

  it("confirms a second practice session the same day, but not the next", () => {
    expect(
      shouldConfirmRelog({
        affordance: "practice-session",
        lastLoggedDate: "2026-08-05",
        today: "2026-08-05",
      })
    ).toBe(true);
    expect(
      shouldConfirmRelog({
        affordance: "practice-session",
        lastLoggedDate: "2026-08-04",
        today: "2026-08-05",
      })
    ).toBe(false);
  });

  it("does not confirm a practice session with nothing logged yet", () => {
    expect(
      shouldConfirmRelog({
        affordance: "practice-session",
        lastLoggedDate: null,
        today: "2026-08-05",
      })
    ).toBe(false);
  });

  it("confirms a refill two hours after the last one, not a month later", () => {
    const now = Date.UTC(2026, 7, 5, 12, 0, 0);
    const hour = 60 * 60 * 1000;
    expect(
      shouldConfirmRelog({
        affordance: "medication-refill",
        lastLoggedAtMs: now - 2 * hour,
        nowMs: now,
      })
    ).toBe(true);
    expect(
      shouldConfirmRelog({
        affordance: "medication-refill",
        lastLoggedAtMs: now - 30 * 24 * hour,
        nowMs: now,
      })
    ).toBe(false);
  });

  it("sizes the refill window to how long a fill actually lasts", () => {
    const now = Date.UTC(2026, 7, 5, 12, 0, 0);
    const day = 24 * 60 * 60 * 1000;
    // A 4-day supply: a refill 2 days later is an ordinary restock, not a double-tap.
    expect(
      shouldConfirmRelog({
        affordance: "medication-refill",
        lastLoggedAtMs: now - 2 * day,
        nowMs: now,
        supplyCycleDays: 4,
      })
    ).toBe(false);
    // …but the same 2 days into a 90-day bottle is still capped at the ceiling.
    expect(refillConfirmWindowDays(90)).toBe(REFILL_CONFIRM_MAX_DAYS);
    expect(refillConfirmWindowDays(4)).toBe(1);
    expect(refillConfirmWindowDays(null)).toBe(
      Math.min(REFILL_CONFIRM_MAX_DAYS, DEFAULT_SUPPLY_CYCLE_DAYS * 0.25)
    );
    expect(refillConfirmWindowDays(0)).toBe(refillConfirmWindowDays(null));
  });

  it("treats a backwards clock as just now rather than as ancient", () => {
    const now = Date.UTC(2026, 7, 5, 12, 0, 0);
    expect(
      shouldConfirmRelog({
        affordance: "medication-refill",
        lastLoggedAtMs: now + 5000,
        nowMs: now,
      })
    ).toBe(true);
  });

  it("asks nothing when it has no previous tap to name", () => {
    const now = Date.UTC(2026, 7, 5, 12, 0, 0);
    expect(
      shouldConfirmRelog({
        affordance: "medication-refill",
        lastLoggedAtMs: null,
        nowMs: now,
      })
    ).toBe(false);
  });
});

describe("the re-log confirm copy", () => {
  it("names the practice, the count and the time when it knows it", () => {
    expect(practiceRelogMessage("Sauna", 1, "08:12")).toBe(
      "You logged Sauna today at 08:12. Log another session?"
    );
    expect(practiceRelogMessage("Sauna", 2, null)).toBe(
      "You logged Sauna 2 times today. Log another session?"
    );
  });

  it("names both fills and how long ago the last one was", () => {
    const hour = 60 * 60 * 1000;
    expect(refillRelogMessage(90, 90, 2 * hour)).toBe(
      "You marked this refilled 2 hours ago (+90). Add another 90?"
    );
    expect(refillRelogMessage(0.5, 0.5, 30_000)).toBe(
      "You marked this refilled just now (+0.5). Add another 0.5?"
    );
  });

  it("reads elapsed time coarsely", () => {
    expect(elapsedPhrase(5_000)).toBe("just now");
    expect(elapsedPhrase(60_000)).toBe("1 minute ago");
    expect(elapsedPhrase(12 * 60_000)).toBe("12 minutes ago");
    expect(elapsedPhrase(60 * 60_000)).toBe("1 hour ago");
    expect(elapsedPhrase(26 * 60 * 60_000)).toBe("1 day ago");
    expect(elapsedPhrase(3 * 24 * 60 * 60_000)).toBe("3 days ago");
  });
});
