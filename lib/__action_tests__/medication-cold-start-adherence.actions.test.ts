// SERVER-ACTION TIER — the cold-start adherence boundary (#1442), driven through
// the REAL write path. Quick-add a medication, then read the medications page's own
// gather (loadMedicationsData) and summarize the card's strip exactly as the shared
// AdherenceSummaryLine does.
//
// The bug this pins: seconds after "Add medication → Quick add", the new
// Current-medications card read "0% adherence" — the worst possible number for "no
// history yet" (the #1433 cold-start mislabeling class). The mechanism was upstream
// of the component's null-guard: the fixed 14-day lookback scored the thirteen days
// before the item existed as outright misses, so the denominator was never empty.
//
// This lives in the action/DB tier on purpose. The pure tier takes a pre-built strip
// and structurally cannot see the builder's INPUT layer — which is exactly where
// every confirmed adherence-window defect has lived (#430, #448). Both halves of the
// boundary are asserted: no elapsed slot → no history; an elapsed, untaken slot →
// an honest 0%. Every value is synthetic.

import { describe, it, expect } from "vitest";
import { db, today } from "@/lib/db";
import { addIntakeItem } from "@/app/(app)/nutrition/intake-actions";
import { quickAddMedicationFormData } from "@/lib/quick-add-medication";
import { loadMedicationsData } from "@/app/(app)/medications/med-data";
import { adherenceSummary } from "@/lib/intake-adherence";
import { shiftDateStr } from "@/lib/date";
import { seedActor } from "./harness";

function medIdNamed(profileId: number, name: string): number {
  const row = db
    .prepare(
      `SELECT id FROM intake_items
        WHERE profile_id = ? AND name = ? ORDER BY id DESC LIMIT 1`
    )
    .get(profileId, name) as { id: number };
  return row.id;
}

// Summarize the card's strip the way components/AdherenceRefill renders it.
function cardAdherence(profileId: number, name: string) {
  const card = loadMedicationsData(profileId).current.find(
    (c) => c.med.name === name
  );
  expect(card, `no current-medications card for ${name}`).toBeTruthy();
  return adherenceSummary(card!.strip);
}

// Backdate an item + its doses so a scheduled slot has genuinely elapsed. Written
// as UTC SQL, the shape `datetime('now')` stores.
function backdateCreation(
  profileId: number,
  itemId: number,
  days: number
): void {
  const at = `${shiftDateStr(today(profileId), -days)} 08:00:00`;
  db.prepare("UPDATE intake_items SET created_at = ? WHERE id = ?").run(
    at,
    itemId
  );
  db.prepare(
    "UPDATE intake_item_doses SET created_at = ? WHERE item_id = ?"
  ).run(at, itemId);
}

describe("medication cold-start adherence (#1442)", () => {
  it("a just-quick-added medication reports NO HISTORY, never 0%", async () => {
    const { profile } = seedActor();
    const res = await addIntakeItem(
      quickAddMedicationFormData({
        name: "Ibuprofen (test)",
        amount: "200 mg",
        asNeeded: false, // scheduled, so it has a daily slot at all
      })
    );
    expect(res.ok).toBe(true);

    const a = cardAdherence(profile.id, "Ibuprofen (test)");
    // No applicable slot has elapsed: every earlier day predates the item, and
    // today is still pending. The card hides the line instead of printing a number.
    expect(a.applicableDays).toBe(0);
    expect(a.pct).toBeNull();
    expect(a.skippedDays).toBe(0);
  });

  it("keeps the honest 0% once a slot has elapsed untaken", async () => {
    const { profile } = seedActor();
    await addIntakeItem(
      quickAddMedicationFormData({
        name: "Lisinopril (test)",
        amount: "10 mg",
        asNeeded: false,
      })
    );
    const itemId = medIdNamed(profile.id, "Lisinopril (test)");
    // Started three days ago and never logged — three settled, missed days.
    backdateCreation(profile.id, itemId, 3);

    const a = cardAdherence(profile.id, "Lisinopril (test)");
    expect(a.applicableDays).toBe(3); // today stays pending, not counted
    expect(a.pct).toBe(0);
  });

  it("scores only the days since the item existed, not the whole lookback", async () => {
    const { profile } = seedActor();
    await addIntakeItem(
      quickAddMedicationFormData({
        name: "Metformin (test)",
        amount: "500 mg",
        asNeeded: false,
      })
    );
    const itemId = medIdNamed(profile.id, "Metformin (test)");
    backdateCreation(profile.id, itemId, 2);
    // Log both elapsed days as taken. If the window still reached back before the
    // item existed, the extra phantom misses would drag this well under 100%.
    const doseId = (
      db
        .prepare("SELECT id FROM intake_item_doses WHERE item_id = ?")
        .get(itemId) as { id: number }
    ).id;
    const ins = db.prepare(
      `INSERT INTO intake_item_logs (dose_id, item_id, date, taken_at, status)
       VALUES (?, ?, ?, ?, 'taken')`
    );
    for (const d of [2, 1]) {
      const date = shiftDateStr(today(profile.id), -d);
      ins.run(doseId, itemId, date, `${date} 08:05:00`);
    }

    const a = cardAdherence(profile.id, "Metformin (test)");
    expect(a.applicableDays).toBe(2);
    expect(a.takenDays).toBe(2);
    expect(a.pct).toBe(100);
  });

  it("keeps a backfilled history visible when the row is newer than its logs", async () => {
    // The reconciled/imported shape (and the shape both seeders write): the
    // intake_items row is created TODAY but carries weeks of real adherence. A log
    // is proof the dose existed on its date, so the window widens to cover it —
    // clamping strictly on created_at would blank a history the user really has.
    const { profile } = seedActor();
    await addIntakeItem(
      quickAddMedicationFormData({
        name: "Levothyroxine (test)",
        amount: "50 mcg",
        asNeeded: false,
      })
    );
    const itemId = medIdNamed(profile.id, "Levothyroxine (test)");
    const doseId = (
      db
        .prepare("SELECT id FROM intake_item_doses WHERE item_id = ?")
        .get(itemId) as { id: number }
    ).id;
    const ins = db.prepare(
      `INSERT INTO intake_item_logs (dose_id, item_id, date, taken_at, status)
       VALUES (?, ?, ?, ?, 'taken')`
    );
    for (let d = 1; d <= 5; d++) {
      const date = shiftDateStr(today(profile.id), -d);
      ins.run(doseId, itemId, date, `${date} 07:30:00`);
    }

    const a = cardAdherence(profile.id, "Levothyroxine (test)");
    expect(a.applicableDays).toBe(5);
    expect(a.takenDays).toBe(5);
    expect(a.pct).toBe(100);
  });
});
