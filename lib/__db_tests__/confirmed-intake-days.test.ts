// DB INTEGRATION TIER — the cross-item DayHistory gather keeps item identity.
// Display names are user-owned and need not be unique; grouping by one would
// silently merge independently managed supplements or medications.

import { describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { getConfirmedIntakeDosesInRange } from "@/lib/queries/nutrition";

function newProfile(): number {
  return Number(
    db
      .prepare("INSERT INTO profiles (name) VALUES ('Dose identity fixture')")
      .run().lastInsertRowid
  );
}

function insertItem(
  profileId: number,
  kind: "supplement" | "medication",
  product: string
): { itemId: number; doseId: number } {
  const itemId = Number(
    db
      .prepare(
        `INSERT INTO intake_items
           (profile_id, name, kind, product, active, condition, obligation)
         VALUES (?, 'Magnesium', ?, ?, 1, 'daily', 'should')`
      )
      .run(profileId, kind, product).lastInsertRowid
  );
  const doseId = Number(
    db
      .prepare(
        `INSERT INTO intake_item_doses
           (item_id, amount, time_of_day, food_timing, sort)
         VALUES (?, '200 mg', 'morning', 'any', 0)`
      )
      .run(itemId).lastInsertRowid
  );
  return { itemId, doseId };
}

describe("getConfirmedIntakeDosesInRange", () => {
  it("returns item identity and disambiguating metadata for duplicate names", () => {
    const profileId = newProfile();
    const citrate = insertItem(profileId, "supplement", "Citrate");
    const glycinate = insertItem(profileId, "supplement", "Glycinate");

    db.prepare(
      `INSERT INTO intake_item_logs (dose_id, item_id, date, status, amount)
       VALUES (?, ?, '2026-08-01', 'taken', '200 mg'),
              (?, ?, '2026-08-01', 'taken', '300 mg')`
    ).run(citrate.doseId, citrate.itemId, glycinate.doseId, glycinate.itemId);

    const rows = getConfirmedIntakeDosesInRange(profileId, "2026-08-01");
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.itemId))).toEqual(
      new Set([citrate.itemId, glycinate.itemId])
    );
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          itemId: citrate.itemId,
          name: "Magnesium",
          product: "Citrate",
          amount: "200 mg",
        }),
        expect.objectContaining({
          itemId: glycinate.itemId,
          name: "Magnesium",
          product: "Glycinate",
          amount: "300 mg",
        }),
      ])
    );
  });
});
