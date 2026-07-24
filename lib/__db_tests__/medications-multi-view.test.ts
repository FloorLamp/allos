// DB INTEGRATION TIER — the multi-view Medications boards (issue #1373 Part 1).
//
// The page loop-composes loadMedicationsData PER in-view member (no set-based SQL —
// dueness/adherence/refill/warnings are per-member derivations). This tier proves the
// two things the pure model test structurally can't see (it takes pre-gathered arrays):
//   (a) each member's board is derived in that member's OWN timezone/today() — the
//       per-profile-context trap: two ~25h-apart zones yield different todayStr; and
//   (b) each member's safety strip is that member's OWN warnings — a drug-allergy hit
//       planted on ONE member never leaks onto the other's board (warnings isolation),
//       and neither does the current-med list.
//
// Fixtures are 100% synthetic (a throwaway per-file DB via setup.ts). No AI, no network.

import { describe, it, expect } from "vitest";
import { db } from "@/lib/db";
import { loadMedicationsData } from "@/app/(app)/medications/med-data";

function makeProfile(name: string, timezone: string): number {
  const id = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
  db.prepare(
    "INSERT INTO profile_settings (profile_id, key, value) VALUES (?, 'timezone', ?)"
  ).run(id, timezone);
  return id;
}

// A daily scheduled (non-PRN) medication with one 'any'-time dose, so it is due today.
function addScheduledMed(profileId: number, name: string): number {
  const itemId = Number(
    db
      .prepare(
        `INSERT INTO intake_items
           (profile_id, name, active, kind, condition, priority, as_needed)
         VALUES (?, ?, 1, 'medication', 'daily', 'high', 0)`
      )
      .run(profileId, name).lastInsertRowid
  );
  db.prepare(
    `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
     VALUES (?, '1 tablet', 'any', 'any', 0)`
  ).run(itemId);
  return itemId;
}

// A recorded allergy + a same-class active med, so getDrugAllergyWarnings fires.
function seedAllergyWarning(profileId: number): void {
  db.prepare(
    `INSERT INTO allergies (profile_id, substance, reaction, status)
     VALUES (?, 'Penicillin', 'hives', 'active')`
  ).run(profileId);
  db.prepare(
    `INSERT INTO intake_items (profile_id, name, active, kind)
     VALUES (?, 'Amoxicillin 500 mg', 1, 'medication')`
  ).run(profileId);
}

describe("multi-view Medications boards (#1373)", () => {
  it("resolves each member's board today() in its OWN timezone (per-profile-context trap)", () => {
    // ~25h apart (UTC+13 vs UTC−12) → the two local calendar dates ALWAYS differ,
    // regardless of the wall-clock instant the test runs at.
    const east = makeProfile("MV Med East", "Etc/GMT-13");
    const west = makeProfile("MV Med West", "Etc/GMT+12");
    addScheduledMed(east, "East Med");
    addScheduledMed(west, "West Med");

    const eastData = loadMedicationsData(east);
    const westData = loadMedicationsData(west);

    expect(eastData.tz).toBe("Etc/GMT-13");
    expect(westData.tz).toBe("Etc/GMT+12");
    expect(eastData.todayStr).not.toBe(westData.todayStr);
    // East is ahead of West.
    expect(eastData.todayStr > westData.todayStr).toBe(true);
  });

  it("isolates each member's current meds and safety warnings to their own board", () => {
    const sam = makeProfile("MV Med Sam", "UTC");
    const riley = makeProfile("MV Med Riley", "UTC");
    addScheduledMed(sam, "Sam Only Med");
    addScheduledMed(riley, "Riley Only Med");
    // The allergy contraindication lives on Sam only.
    seedAllergyWarning(sam);

    const samData = loadMedicationsData(sam);
    const rileyData = loadMedicationsData(riley);

    // Current-med lists don't bleed across members.
    const samNames = samData.current.map((m) => m.med.name);
    const rileyNames = rileyData.current.map((m) => m.med.name);
    expect(samNames).toContain("Sam Only Med");
    expect(samNames).not.toContain("Riley Only Med");
    expect(rileyNames).toContain("Riley Only Med");
    expect(rileyNames).not.toContain("Sam Only Med");

    // The safety strip is per-member: Sam has the allergy warning, Riley has none.
    expect(samData.allergyWarnings.length).toBeGreaterThan(0);
    expect(rileyData.allergyWarnings.length).toBe(0);
  });

  it("each member's scheduled med is due on its own board's Today panel input", () => {
    const a = makeProfile("MV Med Due A", "UTC");
    addScheduledMed(a, "Due Med A");
    const data = loadMedicationsData(a);
    const card = data.current.find((m) => m.med.name === "Due Med A");
    expect(card).toBeTruthy();
    expect(card!.due).toBe(true);
    expect(card!.doses.length).toBe(1);
  });
});
