// DB INTEGRATION TIER — the canonical-flags version gate re-derives stored flags on
// upgrade (issue #150). Pediatric age-banded ranges propagate to EXISTING records
// only because reconcileFlagsIfCanonicalChanged re-runs when the canonical-flags
// signature changes. This proves that gate end-to-end against the real schema:
//   • a child's ALP that a naive ADULT-range import flagged "high" (300 U/L > the
//     adult 129) stays wrongly-flagged while the signature is unchanged (gate skips),
//   • and re-derives to NO flag (300 is normal in the age-1–10 band 140–420) the
//     next time the signature moves — the exact once-per-change propagation the
//     boot tasks perform.
// The db singleton is redirected at a per-file temp DB by setup.ts before import.

import { describe, it, expect, beforeAll } from "vitest";
import { db, today } from "@/lib/db";
import { reconcileFlagsIfCanonicalChanged } from "@/lib/migrations/boot-tasks";
import { canonicalFlagsSignature } from "@/lib/canonical-flags-version";
import { shiftDateStr } from "@/lib/date";

let childId: number;
let recordId: number;
let recordDate: string;

function flagOf(id: number): string | null {
  const r = db
    .prepare("SELECT flag FROM medical_records WHERE id = ?")
    .get(id) as { flag: string | null } | undefined;
  return r?.flag ?? null;
}
function storedSig(): string | undefined {
  return (
    db
      .prepare("SELECT value FROM settings WHERE key = 'canonical_flags_sig'")
      .get() as { value?: string } | undefined
  )?.value;
}

beforeAll(() => {
  childId = Number(
    db.prepare("INSERT INTO profiles (name) VALUES ('Reconcile Child')").run()
      .lastInsertRowid
  );
  const setSetting = db.prepare(
    "INSERT INTO profile_settings (profile_id, key, value) VALUES (?, ?, ?) ON CONFLICT(profile_id, key) DO UPDATE SET value = excluded.value"
  );
  // ~2.5 years old at the record's collection date → the ALP age-1–10 band applies.
  recordDate = today(childId);
  setSetting.run(childId, "sex", "female");
  setSetting.run(
    childId,
    "birthdate",
    shiftDateStr(recordDate, -Math.round(2.5 * 365))
  );

  // ALP 300: a naive adult-range import flags it "high" (adult ref 40–129).
  recordId = Number(
    db
      .prepare(
        `INSERT INTO medical_records
           (profile_id, date, category, name, value, unit, canonical_name, value_num, flag)
         VALUES (?, ?, 'lab', 'Alkaline Phosphatase', '300', 'U/L', 'Alkaline Phosphatase', 300, 'high')`
      )
      .run(childId, recordDate).lastInsertRowid
  );
});

describe("canonical-flags version gate (pediatric re-derivation)", () => {
  it("seeds the ALP age band into canonical_biomarkers on boot", () => {
    const row = db
      .prepare(
        "SELECT ranges_by_age FROM canonical_biomarkers WHERE name = 'Alkaline Phosphatase'"
      )
      .get() as { ranges_by_age: string | null } | undefined;
    expect(row?.ranges_by_age).toBeTruthy();
    expect(String(row!.ranges_by_age)).toContain("420");
  });

  it("leaves the stale flag untouched while the signature is unchanged", () => {
    // Boot already stored the CURRENT signature, so the gate skips: no re-scan.
    expect(storedSig()).toBe(canonicalFlagsSignature());
    reconcileFlagsIfCanonicalChanged(db);
    expect(flagOf(recordId)).toBe("high");
  });

  it("re-derives the flag against the age band when the signature moves", () => {
    // Simulate a dataset/logic change shipping: the stored signature no longer
    // matches, so the gate reconciles once.
    db.prepare(
      "UPDATE settings SET value = 'stale-signature' WHERE key = 'canonical_flags_sig'"
    ).run();

    reconcileFlagsIfCanonicalChanged(db);

    // 300 U/L is IN the age-1–10 band (140–420) → the false "high" clears.
    expect(flagOf(recordId)).toBeNull();
    // …and the gate records the current signature so it runs once per change.
    expect(storedSig()).toBe(canonicalFlagsSignature());
  });
});
