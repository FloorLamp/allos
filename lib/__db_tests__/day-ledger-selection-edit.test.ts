// DB INTEGRATION TIER — the Day ledger's selection edit (#4118).
//
// The claim under test is a claim about ROWS: which ones moved, which ones did not, and
// what the batch SAID about each. So it runs against a real SQLite handle, through the
// same cores the single-row ⋯ menu uses.
//
// THE THREE PROPERTIES THAT MATTER, and each has a converse here:
//
//   1. A mixed selection reaches BOTH tables. A batch that silently covered only food
//      would pass any "the servings moved" assertion, so every mixed case asserts the
//      dose row's own columns too.
//   2. The named ids are an UPPER BOUND. The core re-derives the day's rows and writes
//      only the intersection — so a bystander profile's row id, a skipped dose, a
//      `__protein__` event and a stale id are all refused BY NAME rather than dropped
//      silently, and the bystander's row is re-read afterwards to prove nothing moved.
//   3. Every bound is the core's, not the surface's. A future day, a day past the
//      picker's span, and a time that has not happened yet are refused here with
//      nothing written, because a forged POST never sees the surface's markup.
//
// Every value is synthetic.

import { afterEach, describe, it, expect, vi } from "vitest";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import { logFoodServingCore } from "@/lib/food-log-write";
import { addProteinGramsCore } from "@/lib/protein-daily-totals-write";
import { PROTEIN_NUDGE_KEY } from "@/lib/protein-nudge";
import { logHistoricalDose, markDoseSkipped } from "@/lib/queries";
import {
  editDayLedgerSelectionCore,
  type LedgerSelectionOutcome,
} from "@/lib/day-ledger-edit";

let unique = 0;

afterEach(() => {
  vi.useRealTimers();
});

function newProfile(): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(`dls${++unique}`)
      .lastInsertRowid
  );
}

function seedSupplement(profileId: number): { itemId: number; doseId: number } {
  const itemId = Number(
    db
      .prepare(
        `INSERT INTO intake_items
           (profile_id, name, active, kind, condition, obligation,
            quantity_on_hand, qty_per_dose, critical)
         VALUES (?, ?, 1, 'supplement', 'daily', 'must', 30, 1, 0)`
      )
      .run(profileId, `Magnesium ${++unique}`).lastInsertRowid
  );
  const doseId = Number(
    db
      .prepare(
        `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
         VALUES (?, '400 mg', 'morning', 'any', 0)`
      )
      .run(itemId).lastInsertRowid
  );
  return { itemId, doseId };
}

/** `date` at `hh:mm` UTC — every profile here keeps the default timezone. */
function at(date: string, hhmm: string): Date {
  return new Date(`${date}T${hhmm}:00.000Z`);
}

function servingRow(id: number) {
  return db
    .prepare(
      "SELECT date, occurred_at AS occurredAt, time_source AS timeSource FROM food_log_events WHERE id = ?"
    )
    .get(id) as
    | { date: string; occurredAt: string | null; timeSource: string | null }
    | undefined;
}

function doseRow(id: number) {
  return db
    .prepare(
      "SELECT date, occurred_at AS occurredAt FROM intake_item_logs WHERE id = ?"
    )
    .get(id) as { date: string; occurredAt: string | null } | undefined;
}

/** One profile with a serving and a taken dose on the same past day. */
function seedDay(back = 2) {
  const profileId = newProfile();
  const date = shiftDateStr(today(profileId), -back);
  const { itemId, doseId } = seedSupplement(profileId);
  const logged = logFoodServingCore(profileId, "berries", date, "page");
  if (logged.kind !== "logged") throw new Error(logged.kind);
  const dose = logHistoricalDose(
    profileId,
    itemId,
    doseId,
    at(date, "08:30"),
    null,
    false,
    "page"
  );
  if (dose.kind !== "logged") throw new Error(dose.kind);
  const logId = (
    db
      .prepare(
        "SELECT id FROM intake_item_logs WHERE item_id = ? ORDER BY id DESC LIMIT 1"
      )
      .get(itemId) as { id: number }
  ).id;
  return { profileId, date, itemId, doseId, servingId: logged.eventId, logId };
}

function applied(outcome: LedgerSelectionOutcome) {
  if (outcome.kind !== "applied") throw new Error(outcome.kind);
  return outcome;
}

describe("Day-ledger selection edit — the batch reaches both tables", () => {
  it("Set time stamps a mixed selection on the day it already sits on", () => {
    const day = seedDay();
    const outcome = applied(
      editDayLedgerSelectionCore(
        day.profileId,
        day.date,
        { servings: [day.servingId], doses: [day.logId] },
        { kind: "set-time", hhmm: "19:45" }
      )
    );
    expect(outcome).toMatchObject({ applied: 2, refused: [] });
    // The dose half is audited by ITEM, and the batch has to hand the boundary the ids.
    expect(outcome.auditedItemIds).toEqual([day.itemId]);
    expect(servingRow(day.servingId)).toEqual({
      date: day.date,
      occurredAt: `${day.date}T19:45:00Z`,
      timeSource: "stated",
    });
    expect(doseRow(day.logId)).toEqual({
      date: day.date,
      occurredAt: `${day.date}T19:45:00Z`,
    });
  });

  it("Move to day re-dates both rows and carries each row's own wall clock", () => {
    const day = seedDay(2);
    // Give the serving a stated instant so the move has a clock to carry. The dose
    // already carries 08:30 from its backfill.
    applied(
      editDayLedgerSelectionCore(
        day.profileId,
        day.date,
        { servings: [day.servingId], doses: [] },
        { kind: "set-time", hhmm: "12:15" }
      )
    );
    const target = shiftDateStr(day.date, -1);
    const outcome = applied(
      editDayLedgerSelectionCore(
        day.profileId,
        day.date,
        { servings: [day.servingId], doses: [day.logId] },
        { kind: "move-day", date: target }
      )
    );
    expect(outcome).toMatchObject({ applied: 2, refused: [] });
    // THE CONVERSE OF A BARE RE-DATE: a move that left the instant behind would put a
    // stated time on a day it does not belong to — exactly what judgeStatedAt refuses —
    // so the wall clock is asserted, not just the date.
    expect(servingRow(day.servingId)).toEqual({
      date: target,
      occurredAt: `${target}T12:15:00Z`,
      timeSource: "stated",
    });
    expect(doseRow(day.logId)).toEqual({
      date: target,
      occurredAt: `${target}T08:30:00Z`,
    });
  });

  it("Delete removes both rows and leaves each an undo capture", () => {
    const day = seedDay();
    const outcome = applied(
      editDayLedgerSelectionCore(
        day.profileId,
        day.date,
        { servings: [day.servingId], doses: [day.logId] },
        { kind: "delete" }
      )
    );
    expect(outcome).toMatchObject({ applied: 2, refused: [] });
    expect(servingRow(day.servingId)).toBeUndefined();
    expect(doseRow(day.logId)).toBeUndefined();
    // Both deletes go through the domains' UNDOABLE cores, which is what lets one
    // confirmation replace the per-row Undo toast: the rows are in the Trash.
    const kinds = db
      .prepare(
        "SELECT kind FROM deleted_rows WHERE profile_id = ? ORDER BY kind"
      )
      .all(day.profileId) as { kind: string }[];
    expect(kinds.map((row) => row.kind)).toEqual([
      "administration",
      "food-serving",
    ]);
  });
});

describe("Day-ledger selection edit — the named ids are an upper bound", () => {
  it("refuses another profile's rows by name and writes nothing for them", () => {
    const mine = seedDay();
    const theirs = seedDay();
    const outcome = applied(
      editDayLedgerSelectionCore(
        mine.profileId,
        mine.date,
        {
          servings: [mine.servingId, theirs.servingId],
          doses: [mine.logId, theirs.logId],
        },
        { kind: "delete" }
      )
    );
    expect(outcome.applied).toBe(2);
    expect(outcome.refused).toEqual([
      { row: `serving:${theirs.servingId}`, reason: "No longer on this day." },
      { row: `dose:${theirs.logId}`, reason: "No longer on this day." },
    ]);
    // The bystander's rows are RE-READ, not assumed: an "applied: 2" that had quietly
    // deleted four rows would satisfy every count above.
    expect(servingRow(theirs.servingId)).toBeDefined();
    expect(doseRow(theirs.logId)).toBeDefined();
  });

  // Each of these is a row that IS on the day and still may not be batch-edited. Named
  // beside one legitimately selectable serving, so the assertion sees a batch that half
  // applies — "applied: 0" would also be produced by a batch that refused everything.
  it.each([
    [
      "a skipped dose, which is re-answered on its own control",
      (day: ReturnType<typeof seedDay>) => {
        const other = seedSupplement(day.profileId);
        markDoseSkipped(
          day.profileId,
          other.doseId,
          other.itemId,
          day.date,
          "page"
        );
        return {
          field: "doses" as const,
          id: (
            db
              .prepare(
                "SELECT id FROM intake_item_logs WHERE item_id = ? AND status = 'skipped'"
              )
              .get(other.itemId) as { id: number }
          ).id,
        };
      },
    ],
    [
      "the reserved __protein__ ranking event, whose truth is the grams total",
      (day: ReturnType<typeof seedDay>) => {
        addProteinGramsCore(day.profileId, day.date, 25, "page");
        return {
          field: "servings" as const,
          id: (
            db
              .prepare(
                "SELECT id FROM food_log_events WHERE profile_id = ? AND group_key = ? ORDER BY id DESC LIMIT 1"
              )
              .get(day.profileId, PROTEIN_NUDGE_KEY) as { id: number }
          ).id,
        };
      },
    ],
  ])("refuses %s", (_why, seed) => {
    const day = seedDay();
    const { field, id } = seed(day);
    const selection = {
      servings: field === "servings" ? [day.servingId, id] : [day.servingId],
      doses: field === "doses" ? [id] : [],
    };
    const outcome = applied(
      editDayLedgerSelectionCore(day.profileId, day.date, selection, {
        kind: "delete",
      })
    );
    expect(outcome.applied).toBe(1);
    expect(outcome.refused).toEqual([
      {
        row: `${field === "doses" ? "dose" : "serving"}:${id}`,
        reason: "No longer on this day.",
      },
    ]);
    // Re-read, not assumed: the excluded row is still there.
    if (field === "doses") expect(doseRow(id)).toBeDefined();
    else expect(servingRow(id)).toBeDefined();
  });

  it("refuses a row of another DAY — the half of the intersection nothing else checks", () => {
    // Both cores would happily accept this id: it is the profile's own row, and neither
    // `updateFoodLogEventCore` nor `updateHistoricalDose` asks which day the CALLER was
    // looking at. Only the day re-derivation above does, and this is the case that says
    // so — a batch named "set 19:45 on the rows of the 28th" must not reach the 29th.
    const day = seedDay(2);
    const neighbour = shiftDateStr(day.date, -1);
    const elsewhere = logFoodServingCore(
      day.profileId,
      "legumes",
      neighbour,
      "page"
    );
    if (elsewhere.kind !== "logged") throw new Error(elsewhere.kind);
    const outcome = applied(
      editDayLedgerSelectionCore(
        day.profileId,
        day.date,
        { servings: [day.servingId, elsewhere.eventId], doses: [] },
        { kind: "set-time", hhmm: "19:45" }
      )
    );
    expect(outcome.applied).toBe(1);
    expect(outcome.refused).toEqual([
      { row: `serving:${elsewhere.eventId}`, reason: "No longer on this day." },
    ]);
    expect(servingRow(elsewhere.eventId)).toEqual({
      date: neighbour,
      occurredAt: null,
      timeSource: null,
    });
  });

  it("answers nothing-selected when not one named row is on the day", () => {
    const day = seedDay();
    expect(
      editDayLedgerSelectionCore(
        day.profileId,
        day.date,
        { servings: [900001], doses: [900002] },
        { kind: "delete" }
      )
    ).toEqual({ kind: "nothing-selected" });
  });
});

describe("Day-ledger selection edit — the bounds are the core's", () => {
  // Each row is the whole batch input: a forged POST reaches this function directly, so
  // every one of these has to write NOTHING rather than a prefix of the batch.
  it.each([
    [
      "a day that has not happened yet",
      (day: ReturnType<typeof seedDay>) =>
        ({
          kind: "move-day",
          date: shiftDateStr(today(day.profileId), 1),
        }) as const,
    ],
    [
      "a day beyond the ledger's own picker span",
      (day: ReturnType<typeof seedDay>) =>
        ({
          kind: "move-day",
          date: shiftDateStr(today(day.profileId), -7),
        }) as const,
    ],
    [
      "a wall time that is not a wall time",
      () => ({ kind: "set-time", hhmm: "25:99" }) as const,
    ],
  ])("refuses %s outright, writing nothing", (_why, edit) => {
    const day = seedDay();
    const before = {
      serving: servingRow(day.servingId),
      dose: doseRow(day.logId),
    };
    expect(
      editDayLedgerSelectionCore(
        day.profileId,
        day.date,
        { servings: [day.servingId], doses: [day.logId] },
        edit(day)
      )
    ).toEqual({ kind: "invalid-edit" });
    expect(servingRow(day.servingId)).toEqual(before.serving);
    expect(doseRow(day.logId)).toEqual(before.dose);
  });

  it("refuses a time that has not happened yet, through each row's own gate", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-15T12:00:00Z"));
    // TODAY, at 23:59 — a past day would accept it, and that difference is the point:
    // the refusal comes from judgeStatedAt / isHistoricalDoseTimeAccepted against the
    // server clock, not from a rule this batch invented.
    const profileId = newProfile();
    const date = today(profileId);
    const { itemId, doseId } = seedSupplement(profileId);
    const logged = logFoodServingCore(profileId, "berries", date, "page");
    if (logged.kind !== "logged") throw new Error(logged.kind);
    const dose = logHistoricalDose(
      profileId,
      itemId,
      doseId,
      new Date(),
      null,
      false,
      "page"
    );
    if (dose.kind !== "logged") throw new Error(dose.kind);
    const logId = (
      db
        .prepare(
          "SELECT id FROM intake_item_logs WHERE item_id = ? ORDER BY id DESC LIMIT 1"
        )
        .get(itemId) as { id: number }
    ).id;

    const outcome = applied(
      editDayLedgerSelectionCore(
        profileId,
        date,
        { servings: [logged.eventId], doses: [logId] },
        { kind: "set-time", hhmm: "23:59" }
      )
    );
    expect(outcome.applied).toBe(0);
    expect(outcome.refused.map((r) => r.row)).toEqual([
      `serving:${logged.eventId}`,
      `dose:${logId}`,
    ]);
    expect(servingRow(logged.eventId)?.occurredAt).toBeNull();
  });
});
