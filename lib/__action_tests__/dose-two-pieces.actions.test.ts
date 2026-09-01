// SERVER-ACTION TIER — the dose leg of #4424: what the ONE row control's write may and
// may not do once it carries a day. Auth is mocked (harness); the DB is real.
//
// `DoseStatusControl` is now mounted on the day ledger's rows and the quick sheet's
// list as well as on today's cards, so `setDoseStatus` took an optional `date` where it
// used to stamp `today(profileId)`. Two properties have to hold for that to be safe,
// and neither is visible from the component tier:
//
//   1. THE ±2 IS INTACT. `TAP_REACH["dose-status"]` is coupled to
//      `MESSAGE_POINTER_RETENTION_DAYS` — a Telegram dose keyboard stays live exactly
//      that long, and the tap must stay resolvable while the message it sits on can
//      still be tapped. The day is checked against `doseLogDays`, so day 3 is REFUSED
//      and nothing is written. Proven by a refusal here, never by reading the constant.
//   2. RESOLVE-ONLY FROM A CLEAR CONTROL (#280). The tri-state's licence to overwrite
//      comes from the person looking at the state; a list of what a day still owes
//      renders every stale row as clear, so a ✅ there may resolve and may not flip a
//      deliberate skip made on another device.

import { describe, it, expect } from "vitest";
import { db, today } from "@/lib/db";
import { setDoseStatus } from "@/app/(app)/nutrition/intake-actions";
import { shiftDateStr } from "@/lib/date";
import { TAP_REACH } from "@/lib/log-manifest";
import { MESSAGE_POINTER_RETENTION_DAYS } from "@/lib/notifications/message-pointers";
import { applyIntent } from "@/lib/offline/writes";
import { createLogin, createProfile, actAs, fd } from "./harness";

function seedDose(profileId: number): number {
  const itemId = Number(
    db
      .prepare(
        `INSERT INTO intake_items
           (profile_id, name, active, kind, condition, obligation)
         VALUES (?, 'Creatine', 1, 'supplement', 'daily', 'should')`
      )
      .run(profileId).lastInsertRowid
  );
  return Number(
    db
      .prepare(
        `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
         VALUES (?, '5 g', 'any', 'any', 0)`
      )
      .run(itemId).lastInsertRowid
  );
}

function status(doseId: number, date: string): string | undefined {
  return (
    db
      .prepare(
        "SELECT status FROM intake_item_logs WHERE dose_id = ? AND date = ?"
      )
      .get(doseId, date) as { status: string } | undefined
  )?.status;
}

function actor(): { profileId: number; doseId: number } {
  const login = createLogin();
  const profile = createProfile("Dose row", login.id);
  actAs(login, profile);
  return { profileId: profile.id, doseId: seedDose(profile.id) };
}

describe("the dose row control's day is bounded by the tap's own reach (#4424)", () => {
  // THE BOUND AS A RELATIONSHIP, not as a number: the offered window has to stay
  // strictly inside pointer retention, because the sweep that closes a live keyboard
  // can only do it while that keyboard's pointer row still exists.
  it("keeps the offered window strictly inside Telegram pointer retention", () => {
    expect(TAP_REACH["dose-status"].kind).toBe("bounded");
    const reach = TAP_REACH["dose-status"];
    if (reach.kind !== "bounded") throw new Error("dose-status is bounded");
    expect(reach.back).toBeLessThan(MESSAGE_POINTER_RETENTION_DAYS);
  });

  it.each([
    ["today", 0, true],
    ["one day back", 1, true],
    ["the far edge of the reach", 2, true],
    ["one day past the reach", 3, false],
  ])("%s: accepted=%s", async (_label, back, accepted) => {
    const { profileId, doseId } = actor();
    const date = shiftDateStr(today(profileId), -back);

    const result = await setDoseStatus(
      fd({ dose_id: doseId, status: "taken", from: "clear", date })
    );

    expect(result.ok).toBe(accepted);
    // The REFUSAL IS A WRITE THAT DID NOT HAPPEN, which is the half a returned
    // `ok:false` cannot tell you on its own.
    expect(status(doseId, date)).toBe(accepted ? "taken" : undefined);
  });

  it("refuses a future day the switcher never offers, though the core's window is symmetric", async () => {
    const { profileId, doseId } = actor();
    const tomorrow = shiftDateStr(today(profileId), 1);

    const result = await setDoseStatus(
      fd({ dose_id: doseId, status: "taken", from: "clear", date: tomorrow })
    );

    expect(result).toEqual({ ok: false, error: "Couldn't update this dose." });
    expect(status(doseId, tomorrow)).toBeUndefined();
  });
});

describe("a tap made against a clear control may resolve, never overwrite (#280)", () => {
  it.each([
    // from, target, what the day already stands as, whether the write may land
    ["clear", "taken", "skipped", false],
    ["clear", "skipped", "taken", false],
    ["skipped", "taken", "skipped", true],
    ["taken", "clear", "taken", true],
  ])(
    "showing %s, tapping %s against a day standing %s writes=%s",
    async (from, target, standing, writes) => {
      const { profileId, doseId } = actor();
      const date = today(profileId);
      // Establish the day through the action itself, so the fixture reaches the state
      // this assertion is about rather than a hand-built row that might not.
      await setDoseStatus(
        fd({ dose_id: doseId, status: standing, from: "clear" })
      );
      expect(status(doseId, date)).toBe(standing);

      const result = await setDoseStatus(
        fd({ dose_id: doseId, status: target, from })
      );

      expect(result.ok).toBe(writes);
      expect(status(doseId, date)).toBe(
        writes ? (target === "clear" ? undefined : target) : standing
      );
    }
  );

  it("says which status actually persists rather than confirming what was asked", async () => {
    const { doseId } = actor();
    await setDoseStatus(
      fd({ dose_id: doseId, status: "skipped", from: "clear" })
    );

    const result = await setDoseStatus(
      fd({ dose_id: doseId, status: "taken", from: "clear" })
    );

    expect(result).toEqual({
      ok: false,
      error: "Not logged — this dose is marked skipped",
    });
  });

  it("still lets a control that shows the state overwrite it, which is the tri-state", async () => {
    const { profileId, doseId } = actor();
    await setDoseStatus(
      fd({ dose_id: doseId, status: "taken", from: "clear" })
    );

    const flip = await setDoseStatus(
      fd({ dose_id: doseId, status: "skipped", from: "taken" })
    );

    expect(flip.ok).toBe(true);
    expect(status(doseId, today(profileId))).toBe("skipped");
  });
});

// THE OFFLINE REPLAY DID NOT MOVE UNDER THE CAPTURE (#4424 review). The row control's
// ONLINE post changed — `setDoseStatus` with the row's day, resolve-only from a clear —
// and the worry is that a past-day take queued while offline now lands through that
// action too, overwriting a status the person set by hand in the meantime.
//
// It does not. A capture enqueues `{ flow, date, payload }`, and the replay route reads
// the QUEUE: `applyIntent` (lib/offline/writes.ts) dispatches the two dose flows to
// `applyDoseIntent`, which calls `markDoseTaken` / `markDoseSkipped` — the resolve-only
// twins — and never `setDoseStatus` or `setDoseStatusCore`. Asserted by running the race
// rather than by reading the call chain, because the claim is about what the write DOES.
describe("a queued past-day dose replays resolve-only, whoever moved the day since", () => {
  it.each([
    // the flow captured offline, what the person set by hand before it replayed,
    // and whether the replay is allowed to change it
    ["dose", "skipped", "rejected"],
    ["skip-dose", "taken", "rejected"],
    ["dose", "taken", "done"],
  ] as const)(
    "a queued %s replaying onto a day standing %s is %s",
    async (flow, standing, disposition) => {
      const { profileId, doseId } = actor();
      const day = shiftDateStr(today(profileId), -1);

      // The person resolves that day BY HAND, through the control's own action —
      // which is the half of this race that this leg changed.
      const byHand = await setDoseStatus(
        fd({ dose_id: doseId, status: standing, from: "clear", date: day })
      );
      expect(byHand.ok).toBe(true);
      expect(status(doseId, day)).toBe(standing);

      const outcome = applyIntent(profileId, {
        key: `dose-replay-${flow}-${standing}-${day}`,
        flow,
        date: day,
        capturedAt: new Date().toISOString(),
        payload: { doseId },
      });

      // THE ROW FIRST, because it is the assertion: a `rejected` disposition that had
      // already written would be the defect wearing a correct-looking answer, and a
      // disposition checked first hides whether the row moved.
      expect(status(doseId, day)).toBe(standing);
      expect(outcome.status).toBe(disposition);
    }
  );
});
