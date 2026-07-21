import { describe, expect, it } from "vitest";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import { formatGivenAtClock } from "@/lib/administration-format";
import { getTimezone } from "@/lib/settings";
import {
  deleteAdministration,
  logHistoricalDose,
  updateHistoricalDose,
} from "@/app/(app)/medications/actions";
import { actAs, fd, seedActor } from "./harness";

function seedMedication(
  profileId: number,
  opts: { asNeeded?: boolean; startedOn?: string; stoppedOn?: string } = {}
): { itemId: number; doseId: number } {
  const itemId = Number(
    db
      .prepare(
        `INSERT INTO intake_items
           (profile_id, name, active, kind, condition, priority, as_needed,
            quantity_on_hand, qty_per_dose)
         VALUES (?, 'History Test Medication', 1, 'medication', 'daily', 'high',
                 ?, 10, 1)`
      )
      .run(profileId, opts.asNeeded ? 1 : 0).lastInsertRowid
  );
  const doseId = Number(
    db
      .prepare(
        `INSERT INTO intake_item_doses
           (item_id, amount, time_of_day, food_timing, sort)
         VALUES (?, '5 mg', 'morning', 'any', 0)`
      )
      .run(itemId).lastInsertRowid
  );
  db.prepare(
    `INSERT INTO medication_courses (item_id, started_on, stopped_on)
     VALUES (?, ?, ?)`
  ).run(itemId, opts.startedOn ?? null, opts.stoppedOn ?? null);
  return { itemId, doseId };
}

describe("logHistoricalDose", () => {
  it("logs a scheduled dose older than 30 days within its medication course", async () => {
    const { profile } = seedActor();
    const date = shiftDateStr(today(profile.id), -45);
    const { itemId, doseId } = seedMedication(profile.id, {
      startedOn: shiftDateStr(date, -5),
    });

    const result = await logHistoricalDose(
      fd({
        id: itemId,
        dose_id: doseId,
        date,
        time: "08:30",
        amount: "7.5 mg",
        adjust_supply: "1",
      })
    );
    expect(result.ok).toBe(true);

    const log = db
      .prepare(
        `SELECT date, amount, given_at, status
           FROM intake_item_logs WHERE dose_id = ? AND date = ?`
      )
      .get(doseId, date) as {
      date: string;
      amount: string;
      given_at: string;
      status: string;
    };
    expect(log).toMatchObject({ date, amount: "7.5 mg", status: "taken" });
    expect(formatGivenAtClock(getTimezone(profile.id), log.given_at)).toBe(
      "8:30am"
    );
    expect(
      (
        db
          .prepare("SELECT quantity_on_hand FROM intake_items WHERE id = ?")
          .get(itemId) as { quantity_on_hand: number }
      ).quantity_on_hand
    ).toBe(9);

    const duplicate = await logHistoricalDose(
      fd({ id: itemId, dose_id: doseId, date, time: "09:00" })
    );
    expect(duplicate).toEqual({
      ok: false,
      error: "That scheduled dose is already recorded for this date.",
    });
  });

  it("allows distinct PRN administrations but deduplicates the same time", async () => {
    const { profile } = seedActor();
    const date = shiftDateStr(today(profile.id), -2);
    const { itemId, doseId } = seedMedication(profile.id, {
      asNeeded: true,
      startedOn: shiftDateStr(date, -5),
    });

    expect(
      await logHistoricalDose(
        fd({ id: itemId, dose_id: doseId, date, time: "08:00" })
      )
    ).toEqual({ ok: true });
    expect(
      await logHistoricalDose(
        fd({ id: itemId, dose_id: doseId, date, time: "12:00" })
      )
    ).toEqual({ ok: true });
    const duplicate = await logHistoricalDose(
      fd({ id: itemId, dose_id: doseId, date, time: "12:01" })
    );
    expect(duplicate).toEqual({
      ok: false,
      error: "A dose is already recorded at about this time.",
    });
    expect(
      (
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM intake_item_logs WHERE item_id = ? AND date = ?"
          )
          .get(itemId, date) as { count: number }
      ).count
    ).toBe(2);
  });

  it("moves a PRN course start backward for a dose older than 30 days", async () => {
    const { profile } = seedActor();
    const date = shiftDateStr(today(profile.id), -45);
    const originalStart = shiftDateStr(today(profile.id), -3);
    const { itemId, doseId } = seedMedication(profile.id, {
      asNeeded: true,
      startedOn: originalStart,
    });

    const result = await logHistoricalDose(
      fd({ id: itemId, dose_id: doseId, date, time: "08:00" })
    );

    expect(result).toEqual({ ok: true });
    expect(
      (
        db
          .prepare(
            "SELECT started_on FROM medication_courses WHERE item_id = ?"
          )
          .get(itemId) as { started_on: string | null }
      ).started_on
    ).toBe(date);
    expect(
      (
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM intake_item_logs WHERE item_id = ? AND date = ?"
          )
          .get(itemId, date) as { count: number }
      ).count
    ).toBe(1);
  });

  it("edits a past PRN dose and moves its course start without changing supply", async () => {
    const { profile } = seedActor();
    const originalDate = shiftDateStr(today(profile.id), -2);
    const editedDate = shiftDateStr(today(profile.id), -8);
    const { itemId, doseId } = seedMedication(profile.id, {
      asNeeded: true,
      startedOn: shiftDateStr(today(profile.id), -3),
    });
    expect(
      await logHistoricalDose(
        fd({ id: itemId, dose_id: doseId, date: originalDate, time: "08:00" })
      )
    ).toEqual({ ok: true });
    const logId = (
      db
        .prepare("SELECT id FROM intake_item_logs WHERE item_id = ?")
        .get(itemId) as { id: number }
    ).id;

    const result = await updateHistoricalDose(
      fd({
        id: itemId,
        log_id: logId,
        date: editedDate,
        time: "09:45",
        amount: "7.5 mg",
      })
    );

    expect(result).toEqual({ ok: true });
    const log = db
      .prepare(
        "SELECT date, given_at, amount, supply_adjusted FROM intake_item_logs WHERE id = ?"
      )
      .get(logId) as {
      date: string;
      given_at: string;
      amount: string;
      supply_adjusted: number;
    };
    expect(log).toMatchObject({
      date: editedDate,
      amount: "7.5 mg",
      supply_adjusted: 0,
    });
    expect(formatGivenAtClock(getTimezone(profile.id), log.given_at)).toBe(
      "9:45am"
    );
    expect(
      (
        db
          .prepare(
            "SELECT started_on FROM medication_courses WHERE item_id = ?"
          )
          .get(itemId) as { started_on: string }
      ).started_on
    ).toBe(editedDate);
    expect(
      (
        db
          .prepare("SELECT quantity_on_hand FROM intake_items WHERE id = ?")
          .get(itemId) as { quantity_on_hand: number }
      ).quantity_on_hand
    ).toBe(10);
  });

  it("deleting history restores supply only when that dose originally adjusted it", async () => {
    const { profile } = seedActor();
    const { itemId, doseId } = seedMedication(profile.id, {
      asNeeded: true,
      startedOn: shiftDateStr(today(profile.id), -20),
    });
    const unadjustedDate = shiftDateStr(today(profile.id), -4);
    await logHistoricalDose(
      fd({ id: itemId, dose_id: doseId, date: unadjustedDate, time: "08:00" })
    );
    const unadjustedId = (
      db
        .prepare(
          "SELECT id FROM intake_item_logs WHERE item_id = ? AND date = ?"
        )
        .get(itemId, unadjustedDate) as { id: number }
    ).id;
    await deleteAdministration(fd({ log_id: unadjustedId }));
    expect(
      (
        db
          .prepare("SELECT quantity_on_hand FROM intake_items WHERE id = ?")
          .get(itemId) as { quantity_on_hand: number }
      ).quantity_on_hand
    ).toBe(10);

    const adjustedDate = shiftDateStr(today(profile.id), -3);
    await logHistoricalDose(
      fd({
        id: itemId,
        dose_id: doseId,
        date: adjustedDate,
        time: "08:00",
        adjust_supply: "1",
      })
    );
    expect(
      (
        db
          .prepare("SELECT quantity_on_hand FROM intake_items WHERE id = ?")
          .get(itemId) as { quantity_on_hand: number }
      ).quantity_on_hand
    ).toBe(9);
    const adjustedId = (
      db
        .prepare(
          "SELECT id FROM intake_item_logs WHERE item_id = ? AND date = ?"
        )
        .get(itemId, adjustedDate) as { id: number }
    ).id;
    await deleteAdministration(fd({ log_id: adjustedId }));
    expect(
      (
        db
          .prepare("SELECT quantity_on_hand FROM intake_items WHERE id = ?")
          .get(itemId) as { quantity_on_hand: number }
      ).quantity_on_hand
    ).toBe(10);
  });

  it("rejects dates outside the medication course and cross-profile dose ids", async () => {
    const actor = seedActor();
    const other = seedActor();
    const date = shiftDateStr(today(actor.profile.id), -5);
    const own = seedMedication(actor.profile.id, {
      startedOn: shiftDateStr(date, 1),
    });
    const foreign = seedMedication(other.profile.id, {
      startedOn: shiftDateStr(date, -1),
    });
    actAs(other.login, other.profile);
    expect(
      await logHistoricalDose(
        fd({
          id: foreign.itemId,
          dose_id: foreign.doseId,
          date,
          time: "08:00",
        })
      )
    ).toEqual({ ok: true });
    const foreignLogId = (
      db
        .prepare("SELECT id FROM intake_item_logs WHERE item_id = ?")
        .get(foreign.itemId) as { id: number }
    ).id;
    actAs(actor.login, actor.profile);

    const outside = await logHistoricalDose(
      fd({ id: own.itemId, dose_id: own.doseId, date, time: "08:00" })
    );
    expect(outside).toEqual({
      ok: false,
      error: "This medication was not active on that date.",
    });

    const forged = await logHistoricalDose(
      fd({
        id: foreign.itemId,
        dose_id: foreign.doseId,
        date,
        time: "08:00",
      })
    );
    expect(forged.ok).toBe(false);
    const forgedEdit = await updateHistoricalDose(
      fd({
        id: foreign.itemId,
        log_id: foreignLogId,
        date,
        time: "09:00",
        amount: "99 mg",
      })
    );
    expect(forgedEdit.ok).toBe(false);
    expect(await deleteAdministration(fd({ log_id: foreignLogId }))).toEqual({
      undoId: null,
    });
    expect(
      (
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM intake_item_logs WHERE item_id = ?"
          )
          .get(foreign.itemId) as { count: number }
      ).count
    ).toBe(1);
    expect(
      (
        db
          .prepare("SELECT amount FROM intake_item_logs WHERE id = ?")
          .get(foreignLogId) as { amount: string }
      ).amount
    ).toBe("5 mg");
  });
});
