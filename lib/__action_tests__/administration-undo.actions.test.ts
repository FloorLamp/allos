// SERVER-ACTION TIER — undoable PRN administration delete (#851 item 11).
//
// A mis-tapped "Log" on a PRN med permanently decrements supply, advances the redose
// window, and counts toward the daily max. deleteAdministration removes the ledger row
// (re-crediting supply) and returns an { undoId }; undoDelete(undoId) restores the row
// (NEW id) and re-decrements supply. These drive the REAL actions
// (logMedicationAdministration → deleteAdministration → undoDelete) end-to-end against
// the throwaway temp DB, pinning the supply/count round-trip.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { revalidatePath } from "next/cache";
import { db, today } from "@/lib/db";
import { getAdministrationsForItemOnDate } from "@/lib/queries";
import {
  logMedicationAdministration,
  deleteAdministration,
} from "@/app/(app)/medications/actions";
import { undoDelete } from "@/app/(app)/undo/actions";
import { seedActor, fd, type TestProfile } from "./harness";

vi.mocked(revalidatePath);

// A PRN medication owned by `profile`, with tracked supply and one dose row.
function seedPrnMed(profile: TestProfile, onHand = 20): number {
  const itemId = Number(
    db
      .prepare(
        `INSERT INTO intake_items
           (profile_id, name, active, kind, condition, priority, as_needed,
            quantity_on_hand, qty_per_dose)
         VALUES (?, 'Ibuprofen', 1, 'medication', 'daily', 'high', 1, ?, 1)`
      )
      .run(profile.id, onHand).lastInsertRowid
  );
  db.prepare(
    `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
     VALUES (?, '200 mg', NULL, 'any', 0)`
  ).run(itemId);
  return itemId;
}

function onHand(itemId: number): number | null {
  return (
    db
      .prepare("SELECT quantity_on_hand AS q FROM intake_items WHERE id = ?")
      .get(itemId) as { q: number | null }
  ).q;
}

// The taken administration ids for an item, oldest first.
function adminIds(itemId: number): number[] {
  return (
    db
      .prepare(
        "SELECT id FROM intake_item_logs WHERE item_id = ? AND status = 'taken' ORDER BY id"
      )
      .all(itemId) as { id: number }[]
  ).map((r) => r.id);
}

let profile: TestProfile;
beforeEach(() => {
  ({ profile } = seedActor());
});

describe("logMedicationAdministration → deleteAdministration → undoDelete round-trip", () => {
  it("delete removes the administration and re-credits supply; undo restores both", async () => {
    const itemId = seedPrnMed(profile, 20);
    const date = today(profile.id);

    // Log one administration → supply 20 → 19, one ledger row today.
    const logged = await logMedicationAdministration(
      fd({ id: itemId, offset: "now" })
    );
    expect(logged.ok).toBe(true);
    expect(onHand(itemId)).toBe(19);
    expect(
      getAdministrationsForItemOnDate(profile.id, itemId, date)
    ).toHaveLength(1);

    const logId = adminIds(itemId)[0];

    // Delete it → row GONE, supply re-credited 19 → 20, an undo token returned.
    const { undoId } = await deleteAdministration(fd({ log_id: logId }));
    expect(typeof undoId).toBe("number");
    expect(
      getAdministrationsForItemOnDate(profile.id, itemId, date)
    ).toHaveLength(0);
    expect(onHand(itemId)).toBe(20);

    // Undo → administration RESTORED (a new id) and supply decremented again 20 → 19.
    const res = await undoDelete(undoId!);
    expect(res.ok).toBe(true);
    const after = getAdministrationsForItemOnDate(profile.id, itemId, date);
    expect(after).toHaveLength(1);
    expect(after[0].id).not.toBe(logId); // re-inserted with a NEW id
    expect(onHand(itemId)).toBe(19);
  });

  it("deleteAdministration returns { undoId: null } for a missing log_id (no-op)", async () => {
    const itemId = seedPrnMed(profile, 5);
    const { undoId } = await deleteAdministration(fd({ log_id: 999999 }));
    expect(undoId).toBeNull();
    expect(onHand(itemId)).toBe(5); // untouched
  });
});
