// DB INTEGRATION TIER — the Give door on a medication that has NO dose row (#5981).
//
// The item the "Also for" copy lands when no amount can be derived: active, PRN,
// and with zero `intake_item_doses` rows. The quick-log gather still offers it, so
// the panel draws a live Give chip; before this change the only thing that chip
// could produce was "may have been removed".
//
// This tier is where the whole write is visible: the first dose row and the
// administration are one transaction, so "exactly one row each, or neither" is a
// statement about the database rather than about a return value.

import { describe, it, expect } from "vitest";
import { db, writeTx } from "@/lib/db";
import { createIntakeItemCore } from "@/lib/intake-item-create";
import { alsoForDoseSeeds } from "@/lib/intake-also-for";
import { logAdministration, getPrnMedicationsForQuickLog } from "@/lib/queries";

// The item as the copy writes it when the label chart refused an amount: PRN,
// active, and dose-less. `doses: []` is exactly what `lib/queries/intake/also-for.ts`
// passes `createIntakeItemCore` on that path — see the seeds assertion below.
function seedDoseLessPrnMed(): { profileId: number; itemId: number } {
  const profileId = Number(
    db.prepare("INSERT INTO profiles (name) VALUES ('Dose-less fixture')").run()
      .lastInsertRowid
  );
  const created = writeTx(() =>
    createIntakeItemCore(profileId, {
      name: "Acetaminophen - Kids",
      kind: "medication",
      provenance: { source: "manual" },
      obligation: "may",
      condition: "daily",
      product: "Children's oral suspension (160 mg / 5 mL)",
      doses: [],
      course: { kind: "open", startedOn: null },
    })
  );
  if (!created.ok) throw new Error(created.error);
  return { profileId, itemId: created.id };
}

function doseRows(itemId: number): { id: number; amount: string | null }[] {
  return db
    .prepare(
      "SELECT id, amount FROM intake_item_doses WHERE item_id = ? ORDER BY id"
    )
    .all(itemId) as { id: number; amount: string | null }[];
}

function adminRows(
  itemId: number
): { dose_id: number; amount: string | null; status: string }[] {
  return db
    .prepare(
      "SELECT dose_id, amount, status FROM intake_item_logs WHERE item_id = ? ORDER BY id"
    )
    .all(itemId) as { dose_id: number; amount: string | null; status: string }[];
}

describe("a PRN medication with no dose row (#5981)", () => {
  it("the copy's seeds are empty when no amount was derived, and the item lands dose-less", () => {
    // The premise the issue rests on, asked of the code rather than taken on trust.
    expect(
      alsoForDoseSeeds(
        [
          {
            amount: "400 mg",
            time_of_day: null,
            food_timing: "any",
            weekdays: null,
            start_date: null,
            end_date: null,
          },
        ],
        { kind: "none", reason: "Recorded weight is 22 lb." },
        "2026-09-18"
      )
    ).toEqual([]);
    const { itemId } = seedDoseLessPrnMed();
    expect(doseRows(itemId)).toEqual([]);
  });

  it("REPRODUCTION: the gather offers a live Give chip whose log answers stale-item", () => {
    const { profileId, itemId } = seedDoseLessPrnMed();
    expect(
      getPrnMedicationsForQuickLog(profileId).map((m) => m.id)
    ).toContain(itemId);
    expect(logAdministration(profileId, itemId, "page").kind).toBe("stale-item");
    expect(adminRows(itemId)).toEqual([]);
  });
});
