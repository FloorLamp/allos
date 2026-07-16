// SERVER-ACTION TIER — OTC medication quick-add row parity (#843, door C). The
// quick-add is a thin wrapper: it posts its own minimal field set (built by the pure
// lib/quick-add-medication mapping) to the SAME `addSupplement` action the full
// MedicationForm uses. This test proves the ACCEPTANCE requirement — for the same
// inputs, the quick-add creates an intake_items row IDENTICAL to the one the full form
// would create — so there's no second write model. The pure mapping's field shape is
// pinned in lib/__tests__/quick-add-medication.test.ts; this pins the resulting ROW.

import { describe, it, expect } from "vitest";
import { db } from "@/lib/db";
import { addSupplement } from "@/app/(app)/nutrition/supplement-actions";
import { quickAddMedicationFormData } from "@/lib/quick-add-medication";
import { seedActor, fd } from "./harness";

interface MedRow {
  id: number;
  name: string;
  kind: string;
  condition: string;
  priority: string;
  brand: string | null;
  as_needed: number;
  min_interval_hours: number | null;
  max_daily_count: number | null;
  redose_notice: number;
  active: number;
  source: string;
}

function latestMedNamed(profileId: number, name: string): MedRow {
  return db
    .prepare(
      `SELECT id, name, kind, condition, priority, brand, as_needed,
              min_interval_hours, max_daily_count, redose_notice, active, source
         FROM intake_items
        WHERE profile_id = ? AND name = ?
        ORDER BY id DESC LIMIT 1`
    )
    .get(profileId, name) as MedRow;
}

function doseAmount(itemId: number): string | null {
  const row = db
    .prepare(
      "SELECT amount FROM intake_item_doses WHERE item_id = ? ORDER BY sort, id LIMIT 1"
    )
    .get(itemId) as { amount: string | null } | undefined;
  return row?.amount ?? null;
}

// The columns that define "the same medication" — everything the two paths set.
function shape(row: MedRow) {
  return {
    kind: row.kind,
    condition: row.condition,
    priority: row.priority,
    brand: row.brand,
    as_needed: row.as_needed,
    min_interval_hours: row.min_interval_hours,
    max_daily_count: row.max_daily_count,
    redose_notice: row.redose_notice,
    active: row.active,
    source: row.source,
  };
}

describe("OTC quick-add row parity (#843)", () => {
  it("creates a row identical to the full MedicationForm for the same inputs", async () => {
    const { profile } = seedActor();

    // The full MedicationForm's field set for an OTC PRN ibuprofen.
    const fullForm = fd({
      name: "Ibuprofen",
      kind: "medication",
      condition: "daily",
      brand: "Advil",
      as_needed: "1",
      min_interval_hours: "6",
      max_daily_count: "4",
      rxcui: "",
      rxcui_ingredients: "",
    });
    fullForm.set(
      "doses",
      JSON.stringify([
        { amount: "200 mg", food_timing: "any", time_of_day: "" },
      ])
    );
    const fullRes = await addSupplement(fullForm);
    expect(fullRes.ok).toBe(true);
    const fullRow = latestMedNamed(profile.id, "Ibuprofen");

    // The quick-add's field set, built by the shared pure mapping, for the SAME inputs.
    const quickRes = await addSupplement(
      quickAddMedicationFormData({
        name: "Ibuprofen",
        brand: "Advil",
        amount: "200 mg",
        asNeeded: true,
        minIntervalHours: 6,
        maxDailyCount: 4,
      })
    );
    expect(quickRes.ok).toBe(true);
    // The most recent "Ibuprofen" is the quick-add row (two now exist).
    const quickRow = latestMedNamed(profile.id, "Ibuprofen");
    expect(quickRow.id).not.toBe(fullRow.id);

    // Same row shape, same dose strength — the two paths are interchangeable.
    expect(shape(quickRow)).toEqual(shape(fullRow));
    expect(doseAmount(quickRow.id)).toBe(doseAmount(fullRow.id));
    expect(doseAmount(quickRow.id)).toBe("200 mg");

    // And it really is a medication (course opened, PRN), so it lands on Medications.
    expect(quickRow.kind).toBe("medication");
    expect(quickRow.as_needed).toBe(1);
    const courses = db
      .prepare("SELECT COUNT(*) AS c FROM medication_courses WHERE item_id = ?")
      .get(quickRow.id) as { c: number };
    expect(courses.c).toBeGreaterThan(0);
  });

  it("opts in to the redose notice only when both label numbers are confirmed", async () => {
    const { profile } = seedActor();
    await addSupplement(
      quickAddMedicationFormData({
        name: "Acetaminophen",
        amount: "500 mg",
        asNeeded: true,
        minIntervalHours: 6,
        maxDailyCount: 4,
        redoseNotice: true,
      })
    );
    const row = latestMedNamed(profile.id, "Acetaminophen");
    expect(row.redose_notice).toBe(1);
    expect(row.min_interval_hours).toBe(6);
    expect(row.max_daily_count).toBe(4);
  });
});
