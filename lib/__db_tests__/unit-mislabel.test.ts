// DB INTEGRATION TIER — the unit-mislabel cross-check end-to-end (issue #761).
//
// A mislabeled lab unit ("MCHC 33 g/L" whose printed range 31–37 is really g/dL)
// converts faithfully into a confident, spuriously-extreme flag (3.3 g/dL → "low").
// This pins the full chain against the real schema + seeded canonical ranges:
//   • reconcileFlags does NOT derive the false "low" while the stated range reveals
//     the mislabel (the pre-approval suppression),
//   • getUnitMislabelReviews surfaces exactly the mislabeled row (not a correct one,
//     not a genuinely-low one, not one lacking a stated/canonical range),
//   • applyUnitMislabelCorrection corrects the unit to g/dL, sets the `edited` lock,
//     and re-derives the flag to Normal,
//   • undo restores the prior unit AND flag (row-ops side-state),
//   • dismiss records a false positive so the card never re-surfaces,
//   • a genuinely-low MCHC still flags "low".
// The db singleton is redirected at a per-file temp DB by setup.ts before import.

import { describe, it, expect, beforeAll } from "vitest";
import { db, today } from "@/lib/db";
import { reconcileFlags, getUnitMislabelReviews } from "@/lib/queries";
import {
  applyUnitMislabelCorrection,
  undoUnitMislabelCorrection,
  dismissUnitMislabel,
} from "@/lib/unit-mislabel-correction";

let profileId: number;
let mislabeledId: number; // MCHC 33 g/L, stated range 31-37 (really g/dL)
let genuineLowId: number; // MCHC 20 g/dL, genuinely low
let noRangeId: number; // MCHC 33 g/L, no stated range → no signal

function rowOf(id: number): {
  unit: string | null;
  flag: string | null;
  edited: number | null;
} {
  return db
    .prepare("SELECT unit, flag, edited FROM medical_records WHERE id = ?")
    .get(id) as {
    unit: string | null;
    flag: string | null;
    edited: number | null;
  };
}

function insertMchc(
  value: number,
  unit: string,
  reference: string | null,
  flag: string | null
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO medical_records
           (profile_id, date, category, name, value, unit, canonical_name, value_num, reference_range, flag)
         VALUES (?, ?, 'lab', 'MCHC', ?, ?, 'MCHC', ?, ?, ?)`
      )
      .run(
        profileId,
        today(profileId),
        String(value),
        unit,
        value,
        reference,
        flag
      ).lastInsertRowid
  );
}

beforeAll(() => {
  profileId = Number(
    db.prepare("INSERT INTO profiles (name) VALUES ('Mislabel Test')").run()
      .lastInsertRowid
  );
  // The mislabeled row: value 33 g/L, stated range 31-37 (matches g/dL). The
  // extractor saw 33 within 31–37 → no flag.
  mislabeledId = insertMchc(33, "g/L", "31-37", null);
  // A genuinely low reading, correctly labeled g/dL.
  genuineLowId = insertMchc(20, "g/dL", "31.6-35.4", null);
  // Correctly labeled, in range, no stated range → never a mislabel candidate.
  noRangeId = insertMchc(33, "g/dL", null, null);
});

describe("unit-mislabel cross-check (issue #761)", () => {
  it("seeds MCHC into canonical_biomarkers (g/dL, ref 31.6–35.4)", () => {
    const cb = db
      .prepare(
        "SELECT unit, ref_low, ref_high FROM canonical_biomarkers WHERE name = 'MCHC'"
      )
      .get() as { unit: string; ref_low: number; ref_high: number } | undefined;
    expect(cb?.unit).toBe("g/dL");
    expect(cb?.ref_low).toBeCloseTo(31.6, 1);
  });

  it("reconcileFlags does NOT derive a false 'low' for the mislabeled row", () => {
    reconcileFlags(profileId);
    // The mislabel suppression leaves the extractor's (no) flag; NOT a false 'low'.
    expect(rowOf(mislabeledId).flag).toBeNull();
    // The genuinely-low reading still flags 'low'.
    expect(rowOf(genuineLowId).flag).toBe("low");
    // The correct in-range reading is unflagged.
    expect(rowOf(noRangeId).flag).toBeNull();
  });

  it("surfaces exactly the mislabeled row as a Review card", () => {
    const cards = getUnitMislabelReviews(profileId);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      id: mislabeledId,
      name: "MCHC",
      value: 33,
      statedUnit: "g/L",
      correctedUnit: "g/dL",
      statedRange: "31-37",
      factor: 10,
    });
  });

  it("Apply corrects the unit to g/dL, sets the edit-lock, and re-derives Normal", () => {
    const res = applyUnitMislabelCorrection(profileId, mislabeledId);
    expect(res.ok).toBe(true);
    const row = rowOf(mislabeledId);
    expect(row.unit).toBe("g/dL");
    expect(row.edited).toBe(1);
    expect(row.flag).toBeNull(); // 33 g/dL is in range → Normal
    // The card no longer surfaces (unit is now correct).
    expect(getUnitMislabelReviews(profileId)).toHaveLength(0);
  });

  it("undo restores the prior unit AND flag AND edit-lock (row-ops side-state)", () => {
    // Reset to the mislabeled state (the prior test left it corrected), then apply
    // fresh so we hold a real undo token, then undo it.
    db.prepare(
      "UPDATE medical_records SET unit = 'g/L', flag = NULL, edited = 0 WHERE id = ?"
    ).run(mislabeledId);
    const res = applyUnitMislabelCorrection(profileId, mislabeledId);
    if (!res.ok) throw new Error("apply failed");
    const ok = undoUnitMislabelCorrection(profileId, res.undo);
    expect(ok).toBe(true);
    const row = rowOf(mislabeledId);
    expect(row.unit).toBe("g/L"); // prior unit restored
    expect(row.flag).toBeNull(); // prior flag restored
    expect(row.edited).toBe(0); // prior edit-lock restored
    // And the card surfaces again after the undo.
    expect(getUnitMislabelReviews(profileId)).toHaveLength(1);
  });

  it("Dismiss records a false positive so the card never re-surfaces", () => {
    dismissUnitMislabel(profileId, mislabeledId);
    expect(getUnitMislabelReviews(profileId)).toHaveLength(0);
  });

  it("Apply is a no-op error for a row with no detected mislabel", () => {
    const res = applyUnitMislabelCorrection(profileId, genuineLowId);
    expect(res.ok).toBe(false);
    // The genuine low is untouched.
    expect(rowOf(genuineLowId).unit).toBe("g/dL");
  });
});
