// DB INTEGRATION TIER — canonical-biomarkers framework migration (issue #860 Track B).
//
// canonical-biomarkers is the ONE Track B dataset that is BOOT-SEEDED, not read-only:
// its ranges are UPSERTed into the canonical_biomarkers table on every boot and drive a
// flag reconcile gated by canonicalFlagsSignature(). It was deferred precisely because
// the JSON fixed-point proof the other datasets use can't see that seed path. This test
// is that missing proof — it runs against the REAL schema + boot tasks (the db singleton
// is redirected at a per-file temp DB by setup.ts, and migrate() runs on first import):
//
//   1. SEED PARITY — a fresh boot seeds canonical_biomarkers with exactly the rows the
//      framework read layer (CANONICAL_BIOMARKERS) exposes, field-for-field. This is
//      what makes the read layer and the boot task provably ONE source of truth.
//   2. FLAG-GATE STILL RECOMPUTES — the canonicalFlagsSignature() gate re-derives stored
//      record flags on a (simulated) range change and is a no-op when the signature is
//      unchanged. The migration must not have disturbed that mechanism.

import { describe, it, expect, beforeAll } from "vitest";
import { db, today } from "@/lib/db";
import { CANONICAL_BIOMARKERS } from "@/lib/datasets/canonical-biomarkers";
import { canonicalFlagsSignature } from "@/lib/canonical-flags-version";
import { reconcileFlagsIfCanonicalChanged } from "@/lib/migrations/boot-tasks";

interface SeedRow {
  name: string;
  unit: string | null;
  category: string | null;
  ref_low: number | null;
  ref_high: number | null;
  ref_low_male: number | null;
  ref_high_male: number | null;
  ref_low_female: number | null;
  ref_high_female: number | null;
  optimal_low: number | null;
  optimal_high: number | null;
  direction: string | null;
  source: string;
}

function seededByName(): Map<string, SeedRow> {
  const rows = db
    .prepare(
      `SELECT name, unit, category, ref_low, ref_high,
              ref_low_male, ref_high_male, ref_low_female, ref_high_female,
              optimal_low, optimal_high, direction, source
       FROM canonical_biomarkers`
    )
    .all() as SeedRow[];
  return new Map(rows.map((r) => [r.name.toLowerCase(), r]));
}

// The seed coerces every numeric field through `num()` (non-finite → null), so the
// stored value is the entry's value or null. Mirror that here for the comparison.
const num = (v: unknown) =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

describe("canonical-biomarkers seed parity (fresh boot === framework read layer)", () => {
  it("seeds a canonical_biomarkers row for every framework entry, field-for-field", () => {
    const seeded = seededByName();
    // Every framework entry has a matching seeded row with identical flag-relevant
    // fields — so no value diverges between the read layer and the boot seed.
    for (const b of CANONICAL_BIOMARKERS) {
      const row = seeded.get(b.name.toLowerCase());
      expect(row, `no seeded row for "${b.name}"`).toBeTruthy();
      expect(row!.source).toBe("seed");
      expect(row!.unit, b.name).toBe(b.unit ?? null);
      expect(row!.direction, b.name).toBe(b.direction ?? null);
      expect(row!.ref_low, b.name).toBe(num(b.ref_low));
      expect(row!.ref_high, b.name).toBe(num(b.ref_high));
      expect(row!.ref_low_male, b.name).toBe(num(b.ref_low_male));
      expect(row!.ref_high_male, b.name).toBe(num(b.ref_high_male));
      expect(row!.ref_low_female, b.name).toBe(num(b.ref_low_female));
      expect(row!.ref_high_female, b.name).toBe(num(b.ref_high_female));
      expect(row!.optimal_low, b.name).toBe(num(b.optimal_low));
      expect(row!.optimal_high, b.name).toBe(num(b.optimal_high));
    }
  });

  it("stored the current flag signature after the boot reconcile", () => {
    const stored = db
      .prepare("SELECT value FROM settings WHERE key = 'canonical_flags_sig'")
      .get() as { value?: string } | undefined;
    expect(stored?.value).toBe(canonicalFlagsSignature());
  });
});

describe("canonical-biomarkers flag-version gate still recomputes on a range change", () => {
  let profileId: number;
  let recId: number;

  const flagOf = (id: number): string | null => {
    const r = db
      .prepare("SELECT flag FROM medical_records WHERE id = ?")
      .get(id) as { flag: string | null } | undefined;
    return r?.flag ?? null;
  };

  beforeAll(() => {
    profileId = Number(
      db
        .prepare(
          "INSERT INTO profiles (name) VALUES ('Canonical Seed Patient')"
        )
        .run().lastInsertRowid
    );
    // LDL Cholesterol is lower_better with ref_high 100; 200 mg/dL is above range and
    // must derive to "high". Flag seeded NULL — the gate is what must set it.
    recId = Number(
      db
        .prepare(
          `INSERT INTO medical_records
             (profile_id, date, category, name, value, unit, canonical_name, value_num, flag)
           VALUES (?, ?, 'lab', 'LDL Cholesterol', '200', 'mg/dL', 'LDL Cholesterol', 200, NULL)`
        )
        .run(profileId, today(profileId)).lastInsertRowid
    );
  });

  it("re-derives a stored record's flag when the signature moved (simulated range edit)", () => {
    // Move the stored signature so the gate reconciles once, exactly as a range edit
    // that changes canonicalFlagsSignature() would on the next deploy boot.
    db.prepare(
      "UPDATE settings SET value = 'stale-signature-860' WHERE key = 'canonical_flags_sig'"
    ).run();
    reconcileFlagsIfCanonicalChanged(db);

    expect(flagOf(recId)).toBe("high");
    // …and the gate recorded the current signature, so it runs once per change.
    const stored = db
      .prepare("SELECT value FROM settings WHERE key = 'canonical_flags_sig'")
      .get() as { value?: string } | undefined;
    expect(stored?.value).toBe(canonicalFlagsSignature());
  });

  it("is a no-op when the signature is unchanged (the gate, not a blind rescan)", () => {
    // Corrupt the flag, then call again with a MATCHING signature: the gate must skip
    // the scan, leaving the (now wrong) flag untouched — proving it's genuinely gated.
    db.prepare("UPDATE medical_records SET flag = NULL WHERE id = ?").run(
      recId
    );
    reconcileFlagsIfCanonicalChanged(db);
    expect(flagOf(recId)).toBeNull();
  });
});
