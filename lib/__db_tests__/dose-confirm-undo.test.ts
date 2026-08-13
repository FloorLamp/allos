// DB INTEGRATION TIER — taking BACK a dose confirm (#2642).
//
// `undoDoseConfirm` is the inverse behind the act→undo toast. It is deliberately
// narrower than the tri-state's `setDoseStatusCore(…, "clear")`: an undo may remove only
// the row the confirm it is undoing WROTE, so it re-derives the day's ledger under the
// write lock and refuses the moment that is no longer what stands.
//
// What this file pins:
//   1. THE INVERSE IS COMPLETE — the taken row is gone, the supply it consumed is handed
//      back, and the dose is due again (markDoseTaken logs it afresh).
//   2. THE INVERSE RE-DERIVES — a day flipped to skipped, a second row landed on the same
//      (dose, date), or nothing standing at all, each refuse with their own word and
//      leave every row exactly as they found it. The middle case matters most: the one
//      core's clear is a DELETE by (dose_id, date), so a blind undo would take a PRN
//      administration with it.
//   3. THE INVERSE IS SCOPED — another profile's dose id reads zero rows through the
//      parent-item join and is refused without reaching the writer.
//
// The db singleton is redirected at a per-file temp DB by setup.ts.

import { describe, it, expect } from "vitest";
import { db, today } from "@/lib/db";
import {
  markDoseTaken,
  setDoseStatusCore,
  undoDoseConfirm,
} from "@/lib/queries";

let seq = 0;

function seedProfileRow(): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(`Undo P${++seq}`)
      .lastInsertRowid
  );
}

function seedTracked(qty: number | null = 10) {
  const profileId = seedProfileRow();
  const itemId = Number(
    db
      .prepare(
        `INSERT INTO intake_items
           (profile_id, name, active, kind, condition, obligation, quantity_on_hand, qty_per_dose)
         VALUES (?, ?, 1, 'supplement', 'daily', 'should', ?, 1)`
      )
      .run(profileId, `Undo Item ${++seq}`, qty).lastInsertRowid
  );
  const doseId = Number(
    db
      .prepare(
        `INSERT INTO intake_item_doses
           (item_id, amount, time_of_day, food_timing, sort, retired)
         VALUES (?, '2 caps', 'morning', 'any', 0, 0)`
      )
      .run(itemId).lastInsertRowid
  );
  // The core bounds the date to a small window around today (#614), so a fixed calendar
  // literal would drift out of that window as wall-clock time moves.
  return { profileId, itemId, doseId, date: today(profileId) };
}

function logRows(doseId: number, date: string) {
  return db
    .prepare(
      `SELECT id, status, supply_adjusted
         FROM intake_item_logs WHERE dose_id = ? AND date = ? ORDER BY id`
    )
    .all(doseId, date) as {
    id: number;
    status: string;
    supply_adjusted: number;
  }[];
}

function onHand(itemId: number): number | null {
  return (
    db
      .prepare("SELECT quantity_on_hand AS q FROM intake_items WHERE id = ?")
      .get(itemId) as { q: number | null }
  ).q;
}

describe("undoDoseConfirm is a complete, local inverse", () => {
  it("removes the row the confirm wrote, hands back the supply, and leaves the dose due", () => {
    const { profileId, itemId, doseId, date } = seedTracked(10);

    expect(markDoseTaken(profileId, doseId, null, date)).toBe("logged");
    expect(logRows(doseId, date)).toHaveLength(1);
    expect(onHand(itemId)).toBe(9);

    expect(undoDoseConfirm(profileId, doseId, date)).toBe("undone");
    expect(logRows(doseId, date)).toEqual([]);
    expect(onHand(itemId)).toBe(10);

    // Due again, in the strongest sense available: the confirm is accepted afresh and
    // reports a NEW log, not "already-taken".
    expect(markDoseTaken(profileId, doseId, null, date)).toBe("logged");
    expect(logRows(doseId, date)).toHaveLength(1);
    expect(onHand(itemId)).toBe(9);
  });

  it("never hands back units an unadjusted historical row never took", () => {
    const { profileId, itemId, doseId, date } = seedTracked(10);
    // A backfilled taken row that deliberately did NOT decrement (#1933).
    db.prepare(
      `INSERT INTO intake_item_logs (dose_id, item_id, date, amount, status, supply_adjusted)
       VALUES (?, ?, ?, '2 caps', 'taken', 0)`
    ).run(doseId, itemId, date);

    expect(undoDoseConfirm(profileId, doseId, date)).toBe("undone");
    expect(logRows(doseId, date)).toEqual([]);
    expect(onHand(itemId)).toBe(10);
  });
});

describe("undoDoseConfirm re-derives before it writes", () => {
  it("refuses `not-taken` when nothing stands for the day", () => {
    const { profileId, itemId, doseId, date } = seedTracked(10);
    expect(undoDoseConfirm(profileId, doseId, date)).toBe("not-taken");
    expect(logRows(doseId, date)).toEqual([]);
    expect(onHand(itemId)).toBe(10);
  });

  it("refuses `changed` when the day was flipped to skipped in between, and keeps the skip", () => {
    const { profileId, itemId, doseId, date } = seedTracked(10);
    expect(markDoseTaken(profileId, doseId, null, date)).toBe("logged");
    expect(setDoseStatusCore(profileId, doseId, date, "skipped")).toBe(
      "skipped"
    );

    expect(undoDoseConfirm(profileId, doseId, date)).toBe("changed");
    const rows = logRows(doseId, date);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("skipped");
    // The skip already handed the unit back; the refused undo moved nothing further.
    expect(onHand(itemId)).toBe(10);
  });

  it("refuses `changed` when a SECOND row landed on the same (dose, date) — the clear would take both", () => {
    const { profileId, itemId, doseId, date } = seedTracked(10);
    expect(markDoseTaken(profileId, doseId, null, date)).toBe("logged");
    // A PRN administration of the same dose on the same day: the one core's clear is a
    // DELETE by (dose_id, date), so a blind undo would delete this row too.
    db.prepare(
      `INSERT INTO intake_item_logs (dose_id, item_id, date, amount, status, supply_adjusted)
       VALUES (?, ?, ?, '2 caps', 'taken', 1)`
    ).run(doseId, itemId, date);

    expect(undoDoseConfirm(profileId, doseId, date)).toBe("changed");
    expect(logRows(doseId, date)).toHaveLength(2);
    expect(onHand(itemId)).toBe(9);
  });

  it("refuses `stale-dose` once the dose has been retired, and keeps the row", () => {
    const { profileId, itemId, doseId, date } = seedTracked(10);
    expect(markDoseTaken(profileId, doseId, null, date)).toBe("logged");
    db.prepare("UPDATE intake_item_doses SET retired = 1 WHERE id = ?").run(
      doseId
    );

    expect(undoDoseConfirm(profileId, doseId, date)).toBe("stale-dose");
    expect(logRows(doseId, date)).toHaveLength(1);
    expect(onHand(itemId)).toBe(9);
  });

  it("refuses `stale-dose` while the parent item is paused, and keeps the row", () => {
    const { profileId, itemId, doseId, date } = seedTracked(10);
    expect(markDoseTaken(profileId, doseId, null, date)).toBe("logged");
    db.prepare("UPDATE intake_items SET active = 0 WHERE id = ?").run(itemId);

    expect(undoDoseConfirm(profileId, doseId, date)).toBe("stale-dose");
    expect(logRows(doseId, date)).toHaveLength(1);
    expect(onHand(itemId)).toBe(9);
  });
});

describe("undoDoseConfirm is profile-scoped", () => {
  it("refuses another profile's dose id without touching its row", () => {
    const owner = seedTracked(10);
    const stranger = seedProfileRow();

    expect(markDoseTaken(owner.profileId, owner.doseId, null, owner.date)).toBe(
      "logged"
    );
    // The parent-item join reads zero rows for the stranger, so the writer is never
    // reached and the answer is the same one an unknown dose gets.
    expect(undoDoseConfirm(stranger, owner.doseId, owner.date)).toBe(
      "not-taken"
    );
    expect(logRows(owner.doseId, owner.date)).toHaveLength(1);
    expect(onHand(owner.itemId)).toBe(9);
  });
});
