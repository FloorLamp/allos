// DB INTEGRATION TIER — the "mobility" offline-replay flow (#2130).
//
// `mobility-move` is declared idempotent in ONE_TAP_AFFORDANCES — the offline
// queue's own admission criterion — and the #2130 coverage record made it a
// member. These pin the replay half: a queued ON tap replays through the SAME
// auth-blind core the online action uses (logMobilityMoveCore's set semantics
// per (profile, date, move)), lands exactly once under the replayed_keys
// ledger, settles idempotently when the move is already present, and a
// removed-from-catalog slug dead-letters with its reason instead of vanishing.

import { describe, it, expect } from "vitest";
import { db, today } from "@/lib/db";
import { applyIntent } from "@/lib/offline/writes";
import { readMobilitySession } from "@/lib/mobility-log-write";
import { buildIntent } from "@/lib/offline/queue";

const MOVE = "neck_cars"; // first catalog entry; any registered slug works

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

describe("applyIntent — mobility (#2130)", () => {
  it("replays a queued ON tap through the shared core, exactly once", () => {
    const p = newProfile("mobility-replay");
    const date = today(p);
    const intent = buildIntent("mobility", date, { move: MOVE }, p);

    expect(applyIntent(p, intent)).toEqual({ status: "done" });
    expect(readMobilitySession(p, date).moves).toContain(MOVE);

    // A racing second flush of the SAME intent is a no-op on the key ledger.
    expect(applyIntent(p, intent)).toEqual({ status: "duplicate" });
    expect(readMobilitySession(p, date).moves).toEqual([MOVE]);
  });

  it("a fresh intent for an already-present move settles on the same session (set semantics)", () => {
    const p = newProfile("mobility-idem");
    const date = today(p);
    expect(
      applyIntent(p, buildIntent("mobility", date, { move: MOVE }, p))
    ).toEqual({ status: "done" });
    // A different key (an online tap raced the queue, then the queue flushed):
    // the set-add is a no-op, not a duplicate row and not a refusal.
    expect(
      applyIntent(p, buildIntent("mobility", date, { move: MOVE }, p))
    ).toEqual({ status: "done" });
    expect(readMobilitySession(p, date).moves).toEqual([MOVE]);
  });

  it("dead-letters an unknown move with the honest reason", () => {
    const p = newProfile("mobility-unknown");
    const outcome = applyIntent(
      p,
      buildIntent("mobility", today(p), { move: "not-a-move" }, p)
    );
    expect(outcome.status).toBe("rejected");
    expect(outcome.reason).toMatch(/no longer in the catalog/);
  });

  it("rejects a shapeless payload rather than writing", () => {
    const p = newProfile("mobility-shapeless");
    const intent = buildIntent("mobility", today(p), { move: MOVE }, p);
    expect(
      applyIntent(p, {
        ...intent,
        payload: {} as never,
      })
    ).toEqual({ status: "rejected" });
    expect(readMobilitySession(p, today(p)).moves).toEqual([]);
  });
});
