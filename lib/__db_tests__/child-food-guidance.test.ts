// DB INTEGRATION TIER — an age-gated food-drug note is threaded end-to-end into the
// dose reminder (#851 item 4). The alcohol rules gate to "adult" (lib/life-stage), so
// a CHILD's medication reminder must never carry a "limit alcohol" line, while an
// ADULT's does. buildSupplementReminder reads the profile's age (getUserAge) and passes
// it through renderWindowMessage → matchFoodInteractions; this pins that whole thread
// against the real DB rather than the pure renderer alone.

import { describe, it, expect } from "vitest";
import { db } from "@/lib/db";
import { setStoredAge } from "@/lib/settings";
import { buildSupplementReminder } from "@/lib/notifications/supplements";

// A scheduled (daily) Acetaminophen with a pending Morning dose, owned by a fresh
// profile of the given age. Acetaminophen's ONLY food-drug rule is the adult-gated
// alcohol one, so the reminder tail carries "alcohol" for an adult and nothing for a
// child.
function seedAcetaminophenFor(age: number): number {
  const profileId = Number(
    db.prepare("INSERT INTO profiles (name) VALUES ('Age Fixture')").run()
      .lastInsertRowid
  );
  setStoredAge(profileId, age);
  const itemId = Number(
    db
      .prepare(
        `INSERT INTO intake_items
           (profile_id, name, active, kind, condition, priority)
         VALUES (?, 'Acetaminophen', 1, 'medication', 'daily', 'high')`
      )
      .run(profileId).lastInsertRowid
  );
  db.prepare(
    `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
     VALUES (?, '500 mg', 'Morning', 'any', 0)`
  ).run(itemId);
  return profileId;
}

describe("age-gated alcohol note in the dose reminder (#851 item 4)", () => {
  it("a child's (age 8) Morning reminder carries NO alcohol note", () => {
    const profileId = seedAcetaminophenFor(8);
    const msg = buildSupplementReminder(profileId, "Morning");
    expect(msg).not.toBeNull();
    const text = `${msg!.title}\n${msg!.body}`;
    expect(text.toLowerCase()).not.toContain("alcohol");
    // No ⚠️ food-guidance line at all (the alcohol rule was its only match).
    expect(text).not.toContain("⚠️");
  });

  it("an adult's (age 40) Morning reminder DOES carry the alcohol note", () => {
    const profileId = seedAcetaminophenFor(40);
    const msg = buildSupplementReminder(profileId, "Morning");
    expect(msg).not.toBeNull();
    const text = `${msg!.title}\n${msg!.body}`;
    expect(text.toLowerCase()).toContain("alcohol");
    expect(text).toContain("⚠️");
  });
});
