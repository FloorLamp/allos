// DB INTEGRATION TIER (not the pure unit suite).
//
// Issue #661 — the ONE shared intake-safety gather (getIntakeSafetyContext), and #657
// — the condition caveat on a UL warning. Both are input-layer concerns the pure tier
// can't see (it takes pre-gathered arrays), so these seed a real fixture and assert the
// gather/annotation end-to-end.

import { describe, it, expect } from "vitest";
import { db } from "@/lib/db";
import { getIntakeSafetyContext, getDietaryLimitWarnings } from "@/lib/queries";
import { getSuggestSafetyContext } from "@/lib/supplement-suggest";
import { screenSuggestionSafety } from "@/lib/supplement-safety";

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
    // Coded refs since #1030: the gather carries the row's code/code_system so
    // every downstream condition screen can be code-first.
    expect(ctx.conditions).toEqual([
      { name: "Chronic kidney disease", code: null, codeSystem: null },
    ]);
    expect(Array.isArray(ctx.situations)).toBe(true);
  });
});

describe("getSuggestSafetyContext — resolved allergies still block the belt (#691)", () => {
  it("keeps a RESOLVED allergen in the supplement-suggest belt set and drops a fish-oil suggestion", () => {
    const profileId = makeProfile("suggest-belt-resolved");

    // A "fish" allergy the user (or a clinician) marked RESOLVED, plus an active one.
    db.prepare(
      `INSERT INTO allergies (profile_id, substance, status) VALUES (?, 'fish', 'resolved')`
    ).run(profileId);
    db.prepare(
      `INSERT INTO allergies (profile_id, substance, status) VALUES (?, 'penicillin', 'active')`
    ).run(profileId);

    // The shared gather (food engine / prompt) narrows to active-only — fish is gone.
    expect(getIntakeSafetyContext(profileId).allergens).toEqual(["penicillin"]);

    // The suggest belt gather is deliberately broader: resolved fish is still present,
    // so the deterministic screen drops a fish-oil suggestion the model may surface.
    const belt = getSuggestSafetyContext(profileId);
    expect(belt.allergens).toContain("fish");
    expect(belt.allergens).toContain("penicillin");

    const drop = screenSuggestionSafety(
      { name: "Omega-3", product: "Wild Fish Oil" },
      belt
    );
    expect(drop?.field).toBe("allergen");
    expect(drop?.detail).toContain("fish");
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

  it("annotates via a CODED-terse condition ('Stage 3 kidney dz' + N18.30, #1030)", () => {
    const profileId = makeProfile("ul-caveat-coded");
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
    // The label carries no "chronic kidney" substring — the stored code does.
    db.prepare(
      `INSERT INTO conditions (profile_id, name, status, code, code_system)
         VALUES (?, 'Stage 3 kidney dz', 'active', 'N18.30', 'ICD-10-CM')`
    ).run(profileId);

    const warnings = getDietaryLimitWarnings(profileId);
    const mag = warnings.find((w) => w.key === "magnesium");
    expect(mag).toBeTruthy();
    expect(mag!.conditionCaveat).toContain("Stage 3 kidney dz");
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
