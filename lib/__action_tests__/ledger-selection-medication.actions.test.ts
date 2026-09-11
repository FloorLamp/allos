// SERVER-ACTION TIER — medication doses in the day-selection batch (#5618).
//
// The owner ruling of 2026-09-10: `selectableOn` extends to medication doses, and the
// three batch verbs "write the same audit rows the single-row amend already writes; the
// single-row path is the proof the audit exists".
//
// SO EVERY VERB'S CASE HERE IS A COMPARISON, not an assertion about a shape somebody
// chose. Two actors are seeded identically — same medication, same schedule, same
// administration on the same past day — and then one is corrected through the BATCH and
// the other through the SINGLE-ROW ⋯ action with the arguments describing the same
// correction. A case passes only when both end with the same stored ledger row AND the
// same `dose-log.*` audit trail. A batch that skipped the audit, or wrote a different
// action / target / detail, fails against the other arm rather than against a
// hand-written expectation that could have been written to match the bug.
//
// IT RUNS AT THE ACTION TIER BECAUSE THAT IS WHERE THE AUDIT ROW IS WRITTEN. The batch
// core returns the (item, day) pairs it corrected and the boundary records them, exactly
// as the single-row boundary records its own. A core-tier case cannot see an audit row
// at all, so it could not carry this ruling's evidence.
//
// Nothing here asserts that a function was called. Every claim is read back out of
// `intake_item_logs`, `deleted_rows` or `audit_events`.
//
// Every value is synthetic.

import { describe, expect, it } from "vitest";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import { logHistoricalDose } from "@/lib/queries";
import { AUDIT_ACTIONS } from "@/lib/audit-actions";
import {
  deleteAdministration,
  deleteLedgerSelection,
  moveLedgerSelectionToDay,
  setLedgerSelectionTime,
  updateHistoricalDose,
} from "@/app/(app)/nutrition/intake-actions";
import {
  actAs,
  createLogin,
  createProfile,
  fd,
  type TestLogin,
  type TestProfile,
} from "./harness";

let unique = 0;

/**
 * A MEDICATION, `may` (PRN) so one day can hold more than one administration of it —
 * the ordinary medication case, and the one the per-row audit rule exists for. No
 * `medication_courses` row, so `updateHistoricalDose`'s course check passes on its
 * "this item has no courses" arm instead of needing a window seeded around every date.
 */
function seedMedication(
  profileId: number,
  obligation: "may" | "must" = "may"
): { itemId: number; doseId: number } {
  const itemId = Number(
    db
      .prepare(
        `INSERT INTO intake_items
           (profile_id, name, active, kind, condition, obligation,
            quantity_on_hand, qty_per_dose)
         VALUES (?, ?, 1, 'medication', 'pain', ?, 20, 1)`
      )
      .run(profileId, `Ibuprofen ${++unique}`, obligation).lastInsertRowid
  );
  const doseId = Number(
    db
      .prepare(
        `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
         VALUES (?, '200 mg', 'morning', 'any', 0)`
      )
      .run(itemId).lastInsertRowid
  );
  return { itemId, doseId };
}

/** `date` at `hh:mm` UTC — every harness profile keeps the default timezone. */
function at(date: string, hhmm: string): Date {
  return new Date(`${date}T${hhmm}:00.000Z`);
}

/** One taken administration on `date` at `hhmm`, through the domain's own core. */
function administer(
  profileId: number,
  itemId: number,
  doseId: number,
  date: string,
  hhmm: string
): number {
  const outcome = logHistoricalDose(
    profileId,
    itemId,
    doseId,
    at(date, hhmm),
    null,
    false,
    "page"
  );
  if (outcome.kind !== "logged") throw new Error(outcome.kind);
  return (
    db
      .prepare(
        `SELECT id FROM intake_item_logs WHERE item_id = ? ORDER BY id DESC LIMIT 1`
      )
      .get(itemId) as { id: number }
  ).id;
}

function doseRow(id: number) {
  return db
    .prepare(
      "SELECT date, occurred_at AS occurredAt FROM intake_item_logs WHERE id = ?"
    )
    .get(id) as { date: string; occurredAt: string | null } | undefined;
}

function undoCaptures(profileId: number): string[] {
  return (
    db
      .prepare(`SELECT kind FROM deleted_rows WHERE profile_id = ? ORDER BY id`)
      .all(profileId) as { kind: string }[]
  ).map((row) => row.kind);
}

/**
 * The profile's dose-correction audit trail, with the item id normalised away.
 *
 * The two arms of every comparison own DIFFERENT items — they are different profiles —
 * so a literal `target` could never compare equal. It is still asserted, as "this row
 * names the item whose history changed" rather than as a number: a row pointing
 * anywhere else collapses to `"other-item"` and the comparison fails.
 */
function auditTrail(profileId: number, itemId: number) {
  return (
    db
      .prepare(
        `SELECT action, target, detail FROM audit_events
          WHERE active_profile_id = ? AND action LIKE 'dose-log.%'
          ORDER BY id`
      )
      .all(profileId) as {
      action: string;
      target: string | null;
      detail: string | null;
    }[]
  ).map((row) => ({
    action: row.action,
    target: row.target === String(itemId) ? "the-item" : "other-item",
    detail: row.detail,
  }));
}

interface Arm {
  login: TestLogin;
  profile: TestProfile;
  itemId: number;
  doseId: number;
  date: string;
  logIds: number[];
}

/**
 * One actor with one medication and an administration per entry in `clocks`, all on the
 * same past day. Seeding goes through the domain core, not the backfill ACTION, so the
 * audit table starts empty and every row in it afterwards was written by the correction
 * under test.
 */
function seedArm(
  back: number,
  clocks: string[] = ["08:00"],
  obligation: "may" | "must" = "may"
): Arm {
  const login = createLogin({});
  const profile = createProfile(`lsm-${++unique}`, login.id);
  actAs(login, profile);
  const { itemId, doseId } = seedMedication(profile.id, obligation);
  const date = shiftDateStr(today(profile.id), -back);
  const logIds = clocks.map((hhmm) =>
    administer(profile.id, itemId, doseId, date, hhmm)
  );
  expect(auditTrail(profile.id, itemId)).toEqual([]);
  return { login, profile, itemId, doseId, date, logIds };
}

/** Drive the next action as this arm's actor. */
function act(arm: Arm) {
  actAs(arm.login, arm.profile);
}

/** The form a `DaySelection` batch posts, for one arm's dose rows and no servings. */
function batchForm(arm: Arm, extra: Record<string, string> = {}) {
  return fd({
    profile_id: arm.profile.id,
    date: arm.date,
    serving_ids: "",
    dose_log_ids: arm.logIds.join(","),
    ...extra,
  });
}

describe("Set time reaches a medication dose and audits it like the ⋯ amend", () => {
  it("stores the same row and the same dose-log.amend trail as the single-row path", async () => {
    const batch = seedArm(4);
    const single = seedArm(4);

    act(batch);
    expect(
      await setLedgerSelectionTime(batchForm(batch, { time: "19:45" }))
    ).toEqual({ ok: true, applied: 1, refused: [] });

    // The same correction, stated the way the ⋯ menu states it: this row, this day,
    // this wall time.
    act(single);
    expect(
      await updateHistoricalDose(
        fd({
          id: single.itemId,
          log_id: single.logIds[0],
          date: single.date,
          time: "19:45",
        })
      )
    ).toEqual({ ok: true });

    // THE STORED ROW, on both sides. The batch reaching a medication at all is the
    // ruling; that it reaches it the SAME way is the claim.
    expect(doseRow(batch.logIds[0])).toEqual({
      date: batch.date,
      occurredAt: `${batch.date}T19:45:00Z`,
    });
    expect(doseRow(single.logIds[0])).toEqual({
      date: single.date,
      occurredAt: `${single.date}T19:45:00Z`,
    });

    // THE AUDIT ROWS. One `dose-log.amend` against the item, detailed with the day the
    // row ends on — and the batch's is the single-row path's, element for element.
    const expected = [
      {
        action: AUDIT_ACTIONS.doseLogAmend,
        target: "the-item",
        detail: batch.date,
      },
    ];
    expect(auditTrail(batch.profile.id, batch.itemId)).toEqual(expected);
    expect(auditTrail(single.profile.id, single.itemId)).toEqual(expected);
  });
});

describe("Move to day reaches a medication dose and audits it like the ⋯ amend", () => {
  it("re-dates the row, carries its own clock, and writes the same amend trail", async () => {
    const batch = seedArm(4);
    const single = seedArm(4);
    const target = shiftDateStr(batch.date, -30);

    act(batch);
    expect(
      await moveLedgerSelectionToDay(batchForm(batch, { to_date: target }))
    ).toEqual({ ok: true, applied: 1, refused: [] });

    // The ⋯ menu's equivalent of a move: the same amend core, given the new day and the
    // row's own wall clock re-anchored onto it.
    act(single);
    expect(
      await updateHistoricalDose(
        fd({
          id: single.itemId,
          log_id: single.logIds[0],
          date: target,
          time: "08:00",
        })
      )
    ).toEqual({ ok: true });

    // A move that left the instant behind would state 08:00 on a day it no longer
    // belongs to, so the wall clock is asserted, not just the date.
    expect(doseRow(batch.logIds[0])).toEqual({
      date: target,
      occurredAt: `${target}T08:00:00Z`,
    });
    expect(doseRow(single.logIds[0])).toEqual({
      date: target,
      occurredAt: `${target}T08:00:00Z`,
    });

    // THE DETAIL IS THE DAY THE ROW ENDED ON, not the day the batch was launched from —
    // which is what makes the two trails comparable at all.
    const expected = [
      {
        action: AUDIT_ACTIONS.doseLogAmend,
        target: "the-item",
        detail: target,
      },
    ];
    expect(auditTrail(batch.profile.id, batch.itemId)).toEqual(expected);
    expect(auditTrail(single.profile.id, single.itemId)).toEqual(expected);
  });
});

describe("Delete reaches a medication dose and audits it like the ⋯ delete", () => {
  it("removes the row, leaves an undo capture, and writes the same delete trail", async () => {
    const batch = seedArm(4);
    const single = seedArm(4);

    act(batch);
    expect(await deleteLedgerSelection(batchForm(batch))).toEqual({
      ok: true,
      applied: 1,
      refused: [],
    });

    act(single);
    expect(
      await deleteAdministration(fd({ log_id: single.logIds[0] }))
    ).toMatchObject({ undoId: expect.any(Number) });

    expect(doseRow(batch.logIds[0])).toBeUndefined();
    expect(doseRow(single.logIds[0])).toBeUndefined();
    // Both go through the domain's UNDOABLE delete — the row is in the Trash, which is
    // what lets one confirmation replace the per-row Undo toast.
    expect(undoCaptures(batch.profile.id)).toEqual(["administration"]);
    expect(undoCaptures(single.profile.id)).toEqual(["administration"]);

    const expected = [
      {
        action: AUDIT_ACTIONS.doseLogDelete,
        target: "the-item",
        detail: batch.date,
      },
    ];
    expect(auditTrail(batch.profile.id, batch.itemId)).toEqual(expected);
    expect(auditTrail(single.profile.id, single.itemId)).toEqual(expected);
  });
});

describe("The audit is per corrected ROW, not per item", () => {
  // THE CASE THE OLD DEDUP GOT WRONG, and it is a medication case: `auditedItemIds` was
  // a deduped item list, so a batch over two administrations of ONE item wrote one audit
  // row where two trips through the ⋯ menu write two. A supplement is rarely taken twice
  // in a day; a PRN medication is, so bringing medications into selection is what made
  // it reachable.
  it("writes one dose-log.delete per administration when two share an item", async () => {
    const batch = seedArm(4, ["08:00", "14:30"]);
    const single = seedArm(4, ["08:00", "14:30"]);

    act(batch);
    expect(await deleteLedgerSelection(batchForm(batch))).toEqual({
      ok: true,
      applied: 2,
      refused: [],
    });

    act(single);
    for (const logId of single.logIds)
      expect(await deleteAdministration(fd({ log_id: logId }))).toMatchObject({
        undoId: expect.any(Number),
      });

    for (const logId of [...batch.logIds, ...single.logIds])
      expect(doseRow(logId)).toBeUndefined();
    expect(undoCaptures(batch.profile.id)).toEqual([
      "administration",
      "administration",
    ]);

    const expected = [
      {
        action: AUDIT_ACTIONS.doseLogDelete,
        target: "the-item",
        detail: batch.date,
      },
      {
        action: AUDIT_ACTIONS.doseLogDelete,
        target: "the-item",
        detail: batch.date,
      },
    ];
    expect(auditTrail(batch.profile.id, batch.itemId)).toEqual(expected);
    expect(auditTrail(single.profile.id, single.itemId)).toEqual(expected);
  });
});

describe("Widening the kind widened nothing else", () => {
  // The upper-bound property (#4118) has to survive the change, and it is the property
  // a kind widening is most likely to break: `selectableOn` is what refuses a foreign
  // row, and it is the clause that moved.
  it("still refuses another profile's medication dose by name and audits nothing for it", async () => {
    const mine = seedArm(3);
    const theirs = seedArm(3);

    act(mine);
    expect(
      await setLedgerSelectionTime(
        fd({
          profile_id: mine.profile.id,
          date: mine.date,
          serving_ids: "",
          dose_log_ids: `${mine.logIds[0]},${theirs.logIds[0]}`,
          time: "21:10",
        })
      )
    ).toEqual({
      ok: true,
      applied: 1,
      refused: [
        { row: `dose:${theirs.logIds[0]}`, reason: "No longer on this day." },
      ],
    });

    // The bystander's row is RE-READ, not assumed: an "applied: 1" that had also
    // re-timed the stranger's dose would satisfy every count above.
    expect(doseRow(theirs.logIds[0])).toEqual({
      date: theirs.date,
      occurredAt: `${theirs.date}T08:00:00Z`,
    });
    expect(auditTrail(theirs.profile.id, theirs.itemId)).toEqual([]);
  });

  // THE ONE REFUSAL ONLY A MEDICATION CAN MEET. `medication_courses` is a medication
  // table, so a batch that could not reach a medication could never reach this arm. The
  // amend core refuses a correction that would carry a SCHEDULED dose outside its
  // course, and the batch has to carry that refusal BY NAME and write no audit row for
  // it — a batch that recorded an amend it did not make is worse than one that made an
  // amend it should not have, because the audit would then disagree with the ledger.
  it("carries the amend core's outside-course refusal and audits nothing for it", async () => {
    const arm = seedArm(3, ["08:00"], "must");
    // A course that opened the day AFTER the dose was given and never stopped: the
    // administration is history and stays amendable, but re-dating it further back
    // walks it out of every course this item has.
    db.prepare(
      `INSERT INTO medication_courses (item_id, started_on, stopped_on)
       VALUES (?, ?, NULL)`
    ).run(arm.itemId, shiftDateStr(arm.date, 1));
    const target = shiftDateStr(arm.date, -10);

    act(arm);
    expect(
      await moveLedgerSelectionToDay(batchForm(arm, { to_date: target }))
    ).toEqual({
      ok: true,
      applied: 0,
      refused: [
        {
          row: `dose:${arm.logIds[0]}`,
          reason: "This medication was not active on that date.",
        },
      ],
    });

    // The row did not move, and nothing claims it did.
    expect(doseRow(arm.logIds[0])).toEqual({
      date: arm.date,
      occurredAt: `${arm.date}T08:00:00Z`,
    });
    expect(auditTrail(arm.profile.id, arm.itemId)).toEqual([]);
  });

  // AND THE PRN ARM OF THAT SAME QUESTION, which does NOT refuse: `updateHistoricalDose`
  // walks a `may` course's start backward to cover a dose amended before it, and the
  // batch inherits that because it inherits the core. Pinned rather than discovered:
  // it is a write to `medication_courses` — a table no supplement has — reachable from
  // a batch verb for the first time, and the amend core is the only thing deciding it.
  it("extends a PRN medication's course backward exactly as the ⋯ amend does", async () => {
    const batch = seedArm(3, ["08:00"], "may");
    const single = seedArm(3, ["08:00"], "may");
    const courseOpens = (arm: Arm) =>
      (
        db
          .prepare(
            "SELECT started_on AS startedOn FROM medication_courses WHERE item_id = ?"
          )
          .get(arm.itemId) as { startedOn: string }
      ).startedOn;

    for (const arm of [batch, single])
      db.prepare(
        `INSERT INTO medication_courses (item_id, started_on, stopped_on)
         VALUES (?, ?, NULL)`
      ).run(arm.itemId, shiftDateStr(arm.date, 1));
    const target = shiftDateStr(batch.date, -10);

    act(batch);
    expect(
      await moveLedgerSelectionToDay(batchForm(batch, { to_date: target }))
    ).toEqual({ ok: true, applied: 1, refused: [] });

    act(single);
    expect(
      await updateHistoricalDose(
        fd({
          id: single.itemId,
          log_id: single.logIds[0],
          date: target,
          time: "08:00",
        })
      )
    ).toEqual({ ok: true });

    expect(courseOpens(batch)).toBe(target);
    expect(courseOpens(single)).toBe(target);
    const expected = [
      {
        action: AUDIT_ACTIONS.doseLogAmend,
        target: "the-item",
        detail: target,
      },
    ];
    expect(auditTrail(batch.profile.id, batch.itemId)).toEqual(expected);
    expect(auditTrail(single.profile.id, single.itemId)).toEqual(expected);
  });

  it("still refuses a SKIPPED medication dose, which no correction core accepts", async () => {
    const arm = seedArm(3);
    db.prepare(
      "UPDATE intake_item_logs SET status = 'skipped' WHERE id = ?"
    ).run(arm.logIds[0]);

    act(arm);
    expect(await deleteLedgerSelection(batchForm(arm))).toEqual({
      ok: false,
      error: "Those rows are no longer on this day. Refresh and try again.",
    });
    expect(doseRow(arm.logIds[0])).toBeDefined();
    expect(auditTrail(arm.profile.id, arm.itemId)).toEqual([]);
  });
});
