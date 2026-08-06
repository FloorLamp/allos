// DB INTEGRATION TIER — the #2140 lifecycle-hardening batch.
//
// Three machines below the severity of their own issue, hardened the same way:
//   • markCarePlanItemDone answers from state (typed CarePlanDoneOutcome) instead of
//     an unconditional bare UPDATE — first tap wins, a repeat reports "already", a
//     forged id or someone else's close refuses.
//   • deactivateRoutine is a compare-and-swap with `active = 1` as the expectation —
//     the first tap transitions, the second reports false rather than confirming a
//     transition it did not make.
//   • setActiveSituations diffs its before-set INSIDE the write transaction
//     (readAllForUpdate), so the appended start/stop event log always describes
//     transitions that actually happened, across sequential whole-set rewrites.

import { describe, it, expect } from "vitest";
import { db, today } from "@/lib/db";
import { markCarePlanItemDone } from "@/lib/queries/upcoming/plans";
import {
  adoptTemplate,
  activateRoutine,
  deactivateRoutine,
} from "@/lib/routines";
import {
  getActiveSituations,
  getSituationEvents,
  setActiveSituations,
} from "@/lib/settings";

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

function insertCarePlanItem(
  profileId: number,
  description: string,
  status: string | null
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO care_plan_items (profile_id, description, planned_date, status)
         VALUES (?, ?, '2026-09-01', ?)`
      )
      .run(profileId, description, status).lastInsertRowid
  );
}

function carePlanStatus(id: number): string | null {
  return (
    db.prepare("SELECT status FROM care_plan_items WHERE id = ?").get(id) as {
      status: string | null;
    }
  ).status;
}

describe("markCarePlanItemDone typed outcomes (#2140)", () => {
  it("completes an open item, and a repeat tap reports already-closed", () => {
    const p = newProfile("CP Lifecycle");
    const id = insertCarePlanItem(p, "Repeat colonoscopy", "planned");

    expect(markCarePlanItemDone(p, id)).toEqual({ kind: "completed" });
    expect(carePlanStatus(id)).toBe("completed");

    // Second tap: nothing rewritten, the standing status is named.
    expect(markCarePlanItemDone(p, id)).toEqual({
      kind: "already-closed",
      status: "completed",
    });
    expect(carePlanStatus(id)).toBe("completed");
  });

  it("a null-status item is open (the free-form contract) and completes", () => {
    const p = newProfile("CP NullStatus");
    const id = insertCarePlanItem(p, "Unstatused plan", null);
    expect(markCarePlanItemDone(p, id)).toEqual({ kind: "completed" });
    expect(carePlanStatus(id)).toBe("completed");
  });

  it("refuses over a cancellation instead of silently overwriting it", () => {
    const p = newProfile("CP Cancelled");
    const id = insertCarePlanItem(p, "Cancelled imaging", "cancelled");
    expect(markCarePlanItemDone(p, id)).toEqual({
      kind: "already-closed",
      status: "cancelled",
    });
    // The other person's decision persists.
    expect(carePlanStatus(id)).toBe("cancelled");
  });

  it("a forged id and another profile's id both answer not-found", () => {
    const a = newProfile("CP Owner");
    const b = newProfile("CP Intruder");
    const id = insertCarePlanItem(a, "A's plan", "planned");

    expect(markCarePlanItemDone(b, id)).toEqual({ kind: "not-found" });
    expect(markCarePlanItemDone(a, 999999)).toEqual({ kind: "not-found" });
    expect(carePlanStatus(id)).toBe("planned");
  });
});

describe("deactivateRoutine first-wins CAS (#2140)", () => {
  it("the first deactivate transitions; the second reports false", () => {
    const p = newProfile("Routine CAS");
    const rid = adoptTemplate(p, "full-body-3x");
    expect(activateRoutine(p, rid)).toBe(true);

    expect(deactivateRoutine(p, rid)).toBe(true);
    // A stale second tab's tap: the expectation (active = 1) no longer holds.
    expect(deactivateRoutine(p, rid)).toBe(false);
    const active = db
      .prepare("SELECT active FROM routines WHERE id = ?")
      .get(rid) as { active: number };
    expect(active.active).toBe(0);
  });
});

describe("setActiveSituations in-transaction diff (#2140)", () => {
  it("sequential whole-set rewrites append a coherent start/stop event log", () => {
    const p = newProfile("Situations Diff");
    const onDate = today(p);

    setActiveSituations(p, ["Travel"]);
    expect(getActiveSituations(p)).toEqual(["Travel"]);

    setActiveSituations(p, ["Illness"]);
    expect(getActiveSituations(p)).toEqual(["Illness"]);

    setActiveSituations(p, []);
    expect(getActiveSituations(p)).toEqual([]);

    // Every transition that happened — and none that didn't — is in the log:
    // Travel start, Travel stop + Illness start, Illness stop.
    expect(getSituationEvents(p)).toEqual([
      { date: onDate, situation: "Travel", change: "start" },
      { date: onDate, situation: "Illness", change: "start" },
      { date: onDate, situation: "Travel", change: "stop" },
      { date: onDate, situation: "Illness", change: "stop" },
    ]);
  });

  it("keeps the illness-episode row in lock-step with the active flag", () => {
    const p = newProfile("Situations Episode");

    setActiveSituations(p, ["Illness"]);
    const open = db
      .prepare(
        `SELECT COUNT(*) AS n FROM illness_episodes
          WHERE profile_id = ? AND ended_at IS NULL`
      )
      .get(p) as { n: number };
    expect(open.n).toBe(1);

    setActiveSituations(p, []);
    const openAfter = db
      .prepare(
        `SELECT COUNT(*) AS n FROM illness_episodes
          WHERE profile_id = ? AND ended_at IS NULL`
      )
      .get(p) as { n: number };
    expect(openAfter.n).toBe(0);
  });
});
