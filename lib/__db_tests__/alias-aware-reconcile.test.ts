// DB INTEGRATION TIER — alias-aware flag reconciliation.
//
// reconcileFlags looks a stored row's canonical_name up by exact name against the
// canonical_biomarkers table. A row whose canonical_name is a LEGACY spelling or a
// bare abbreviation the dataset no longer uses verbatim (e.g. "RDW" after the entry
// was renamed to "Red Cell Distribution Width (RDW)") would MISS its entry and lose
// its reference band. flagReconcileProfileContext now snaps the name through the
// canonical alias index first, so such a row resolves without a data migration.
// The db singleton is redirected at a per-file temp DB by setup.ts before import.

import { describe, it, expect, beforeAll } from "vitest";
import { db, today } from "@/lib/db";
import { reconcileFlags } from "@/lib/queries";

let profileId: number;

function insertRow(canonicalName: string, valueNum: number): number {
  return Number(
    db
      .prepare(
        `INSERT INTO medical_records
           (profile_id, date, category, name, canonical_name, value, value_num, unit, flag)
         VALUES (?, ?, 'lab', ?, ?, ?, ?, '%', NULL)`
      )
      .run(
        profileId,
        today(profileId),
        canonicalName,
        canonicalName,
        String(valueNum),
        valueNum
      ).lastInsertRowid
  );
}
function flagOf(id: number): string | null {
  return (
    (
      db.prepare("SELECT flag FROM medical_records WHERE id = ?").get(id) as
        { flag: string | null } | undefined
    )?.flag ?? null
  );
}

beforeAll(() => {
  profileId = Number(
    db.prepare("INSERT INTO profiles (name) VALUES ('Alias Reconcile')").run()
      .lastInsertRowid
  );
});

describe("reconcileFlags resolves legacy / abbreviation canonical_names via aliases", () => {
  it("derives a band for a row stored under the bare abbreviation 'RDW'", () => {
    // RDW canonical entry is "Red Cell Distribution Width (RDW)", ref ~11.5–14.5%.
    // A stored row keyed by the OLD bare "RDW" (as an un-migrated row would be) must
    // still pick up the band and flag high at 18%.
    const high = insertRow("RDW", 18);
    const inRange = insertRow("RDW", 13);
    reconcileFlags(profileId);
    expect(flagOf(high)).toBe("high");
    expect(flagOf(inRange)).not.toBe("high");
  });

  it("still derives correctly for the current full name (idempotent)", () => {
    const high = insertRow("Red Cell Distribution Width (RDW)", 18);
    reconcileFlags(profileId);
    expect(flagOf(high)).toBe("high");
  });

  it("leaves an unrecognized name unflagged (no false resolution)", () => {
    const id = insertRow("Definitely Not A Biomarker", 999);
    reconcileFlags(profileId);
    expect(flagOf(id)).toBeNull();
  });
});
