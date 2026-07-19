// DB INTEGRATION TIER — cycle-phase-aware reference ranges (issue #718). Proves the
// gather + reconcile path end-to-end against the real schema:
//   • the boot seed populates canonical_biomarkers.ranges_by_cycle_phase for the
//     phase-dependent hormones (Progesterone shown here),
//   • reconcileFlags loads the profile's logged periods and derives each hormone
//     record's cycle phase from ITS OWN collection date, so the SAME 15 ng/mL
//     progesterone flags "high" on a follicular date but stays unflagged on a luteal
//     date (the issue's motivating case),
//   • with NO cycle log the base envelope applies and the value is byte-identically
//     unflagged (the back-compat pin), and
//   • the canonical-flags signature gate (reconcileFlagsIfCanonicalChanged) re-derives
//     the phase flag on the boot path too.
// The db singleton is redirected at a per-file temp DB by setup.ts before import.

import { describe, it, expect, beforeAll } from "vitest";
import { db } from "@/lib/db";
import { reconcileFlags } from "@/lib/queries";
import { reconcileFlagsIfCanonicalChanged } from "@/lib/migrations/boot-tasks";
import { canonicalFlagsSignature } from "@/lib/canonical-flags-version";

let cyclingId: number;
let noCycleId: number;
let follicularRecId: number;
let lutealRecId: number;
let noCycleRecId: number;

function flagOf(id: number): string | null {
  const r = db
    .prepare("SELECT flag FROM medical_records WHERE id = ?")
    .get(id) as { flag: string | null } | undefined;
  return r?.flag ?? null;
}

function insertProgesterone(profileId: number, date: string): number {
  return Number(
    db
      .prepare(
        `INSERT INTO medical_records
           (profile_id, date, category, name, value, unit, canonical_name, value_num, flag)
         VALUES (?, ?, 'lab', 'Progesterone', '15', 'ng/mL', 'Progesterone', 15, NULL)`
      )
      .run(profileId, date).lastInsertRowid
  );
}

beforeAll(() => {
  const setSetting = db.prepare(
    "INSERT INTO profile_settings (profile_id, key, value) VALUES (?, ?, ?) ON CONFLICT(profile_id, key) DO UPDATE SET value = excluded.value"
  );

  // A female profile WITH a logged cycle: two periods 28 days apart. The completed
  // cycle (2024-01-01 → 2024-01-29) splits follicular vs luteal at 14 days before the
  // next start (= 2024-01-15). So a 2024-01-06 draw is follicular, 2024-01-20 luteal.
  cyclingId = Number(
    db.prepare("INSERT INTO profiles (name) VALUES ('Cycling Subject')").run()
      .lastInsertRowid
  );
  setSetting.run(cyclingId, "sex", "female");
  const insertPeriod = db.prepare(
    `INSERT INTO cycles (profile_id, period_start, period_end, flow, note)
     VALUES (?, ?, ?, NULL, NULL)`
  );
  insertPeriod.run(cyclingId, "2024-01-01", "2024-01-05");
  insertPeriod.run(cyclingId, "2024-01-29", "2024-02-02");
  follicularRecId = insertProgesterone(cyclingId, "2024-01-06");
  lutealRecId = insertProgesterone(cyclingId, "2024-01-20");

  // A female profile with NO cycle log — the back-compat control.
  noCycleId = Number(
    db.prepare("INSERT INTO profiles (name) VALUES ('No Cycle Subject')").run()
      .lastInsertRowid
  );
  setSetting.run(noCycleId, "sex", "female");
  noCycleRecId = insertProgesterone(noCycleId, "2024-01-06");
});

describe("cycle-phase-aware reference ranges (#718)", () => {
  it("seeds ranges_by_cycle_phase for Progesterone on boot", () => {
    const row = db
      .prepare(
        "SELECT ranges_by_cycle_phase FROM canonical_biomarkers WHERE name = 'Progesterone'"
      )
      .get() as { ranges_by_cycle_phase: string | null } | undefined;
    expect(row?.ranges_by_cycle_phase).toBeTruthy();
    const parsed = JSON.parse(String(row!.ranges_by_cycle_phase));
    expect(parsed.follicular.ref_high).toBe(1.5);
    expect(parsed.luteal.ref_high).toBe(23.9);
  });

  it("flags the follicular-date 15 ng/mL but not the luteal-date one (same value)", () => {
    reconcileFlags(cyclingId);
    // 2024-01-06 is follicular → 15 > the ≤1.5 follicular ceiling → 'high'.
    expect(flagOf(follicularRecId)).toBe("high");
    // 2024-01-20 is luteal → 15 is within the ≤23.9 luteal range → no flag.
    expect(flagOf(lutealRecId)).toBeNull();
  });

  it("leaves the no-cycle profile's 15 ng/mL unflagged (base envelope, back-compat)", () => {
    reconcileFlags(noCycleId);
    // No cycle log → the base ≤23.9 envelope → the pre-#718 behavior (no flag).
    expect(flagOf(noCycleRecId)).toBeNull();
  });

  it("derives the phase flag on the boot signature-gate path too", () => {
    // Reset the follicular record to unflagged, then move the stored signature so the
    // gate re-runs the boot-time reconcile (which loads periods per profile).
    db.prepare("UPDATE medical_records SET flag = NULL WHERE id = ?").run(
      follicularRecId
    );
    db.prepare(
      "UPDATE settings SET value = 'stale-signature' WHERE key = 'canonical_flags_sig'"
    ).run();

    reconcileFlagsIfCanonicalChanged(db);

    expect(flagOf(follicularRecId)).toBe("high");
    expect(flagOf(lutealRecId)).toBeNull();
    // The gate records the current signature so it runs once per change.
    const sig = (
      db
        .prepare("SELECT value FROM settings WHERE key = 'canonical_flags_sig'")
        .get() as { value?: string } | undefined
    )?.value;
    expect(sig).toBe(canonicalFlagsSignature());
  });
});
