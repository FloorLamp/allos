// DB INTEGRATION TIER (not the pure unit suite).
//
// Issue #661 — the ONE shared intake-safety gather (getIntakeSafetyContext), and #657
// — the condition caveat on a UL warning. Both are input-layer concerns the pure tier
// can't see (it takes pre-gathered arrays), so these seed a real fixture and assert the
// gather/annotation end-to-end.

import { describe, it, expect } from "vitest";
import { db } from "@/lib/db";
import { getIntakeSafetyContext, getDietaryLimitWarnings } from "@/lib/queries";

function makeProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

describe("getIntakeSafetyContext (#661)", () => {
  it("gathers non-resolved allergens, active meds, active conditions, situations", () => {
    const profileId = makeProfile("intake-safety");

    // Allergens: one active, one resolved (the resolved one must be excluded).
    db.prepare(
      `INSERT INTO allergies (profile_id, substance, status) VALUES (?, 'fish', 'active')`
    ).run(profileId);
    db.prepare(
      `INSERT INTO allergies (profile_id, substance, status) VALUES (?, 'penicillin', 'resolved')`
    ).run(profileId);

    // A medication (active) and a plain supplement (must not appear as a medication).
    db.prepare(
      `INSERT INTO intake_items (profile_id, name, active, kind, condition, priority, as_needed)
       VALUES (?, 'Warfarin', 1, 'medication', 'daily', 'high', 0)`
    ).run(profileId);
    db.prepare(
      `INSERT INTO intake_items (profile_id, name, active, kind, condition, priority, as_needed)
       VALUES (?, 'Magnesium', 1, 'supplement', 'daily', 'high', 0)`
    ).run(profileId);

    // An active + a resolved condition.
    db.prepare(
      `INSERT INTO conditions (profile_id, name, status) VALUES (?, 'Chronic kidney disease', 'active')`
    ).run(profileId);
    db.prepare(
      `INSERT INTO conditions (profile_id, name, status) VALUES (?, 'Fractured wrist', 'resolved')`
    ).run(profileId);

    const ctx = getIntakeSafetyContext(profileId);
    expect(ctx.allergens).toEqual(["fish"]);
    expect(ctx.medications.map((m) => m.name)).toEqual(["Warfarin"]);
    expect(ctx.conditions).toEqual(["Chronic kidney disease"]);
    expect(Array.isArray(ctx.situations)).toBe(true);
  });
});

describe("getDietaryLimitWarnings — condition caveat (#657)", () => {
  it("annotates an over-UL magnesium warning when CKD is on file", () => {
    const profileId = makeProfile("ul-caveat");

    // A daily magnesium supplement over the 350 mg supplemental UL.
    const itemId = Number(
      db
        .prepare(
          `INSERT INTO intake_items (profile_id, name, active, kind, condition, priority, as_needed)
           VALUES (?, 'Magnesium Glycinate', 1, 'supplement', 'daily', 'high', 0)`
        )
        .run(profileId).lastInsertRowid
    );
    db.prepare(
      `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
       VALUES (?, '400 mg', 'morning', 'any', 0)`
    ).run(itemId);
    db.prepare(
      `INSERT INTO conditions (profile_id, name, status) VALUES (?, 'Chronic kidney disease, stage 3', 'active')`
    ).run(profileId);

    const warnings = getDietaryLimitWarnings(profileId);
    const mag = warnings.find((w) => w.key === "magnesium");
    expect(mag).toBeTruthy();
    expect(mag!.conditionCaveat).toContain("Chronic kidney disease, stage 3");
    expect(mag!.conditionCaveat).toContain("magnesium");
  });

  it("carries no caveat when there is no qualifying condition", () => {
    const profileId = makeProfile("ul-no-caveat");
    const itemId = Number(
      db
        .prepare(
          `INSERT INTO intake_items (profile_id, name, active, kind, condition, priority, as_needed)
           VALUES (?, 'Magnesium Glycinate', 1, 'supplement', 'daily', 'high', 0)`
        )
        .run(profileId).lastInsertRowid
    );
    db.prepare(
      `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
       VALUES (?, '400 mg', 'morning', 'any', 0)`
    ).run(itemId);

    const warnings = getDietaryLimitWarnings(profileId);
    const mag = warnings.find((w) => w.key === "magnesium");
    expect(mag).toBeTruthy();
    expect(mag!.conditionCaveat).toBeNull();
  });
});
