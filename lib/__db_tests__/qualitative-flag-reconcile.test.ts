// DB INTEGRATION TIER — the qualitative-result classifier (#549) reroutes the flag
// reconcile so QUALITATIVE (value_num IS NULL) rows the numeric pass always skipped
// get re-judged. This proves the canonical-flags version gate propagates it to
// EXISTING stored rows on upgrade (exactly like the pediatric age-band reconcile):
//   • a POSITIVE durable-immunity titer the extractor stamped "abnormal" → "immune"
//     (#544) — protective immunity is never a red attention flag,
//   • a context-neutral attribute (blood type) stamped "abnormal" → cleared (#548 §1),
//   • an INFECTION marker (Hep B surface ANTIGEN) positive STAYS "abnormal" — the
//     exclusion discipline never quiets a genuine infection signal,
// and it only happens once the flags signature moves (the gate skips while unchanged).
// The db singleton is redirected at a per-file temp DB by setup.ts before import.

import { describe, it, expect, beforeAll } from "vitest";
import { db } from "@/lib/db";
import { reconcileFlagsIfCanonicalChanged } from "@/lib/migrations/boot-tasks";
import { canonicalFlagsSignature } from "@/lib/canonical-flags-version";

let profileId: number;
let hbsAbId: number; // immune-positive titer (surface ANTIBODY)
let bloodTypeId: number; // immutable neutral attribute
let hbsAgId: number; // infection marker (surface ANTIGEN) — must stay flagged

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
  profileId = Number(
    db
      .prepare("INSERT INTO profiles (name) VALUES ('Qualitative Reconcile')")
      .run().lastInsertRowid
  );
  const insert = db.prepare(
    `INSERT INTO medical_records
       (profile_id, date, category, name, value, canonical_name, notes, flag)
     VALUES (?, '2024-01-01', 'lab', ?, ?, NULL, ?, 'abnormal')`
  );
  // All three arrive stamped "abnormal" by the extractor's one-shot guess.
  hbsAbId = Number(
    insert.run(profileId, "Hepatitis B Surface Antibody", "Positive", "Immune")
      .lastInsertRowid
  );
  bloodTypeId = Number(
    insert.run(profileId, "ABO Blood Group", "A POSITIVE", null).lastInsertRowid
  );
  hbsAgId = Number(
    insert.run(profileId, "Hepatitis B Surface Antigen", "Positive", null)
      .lastInsertRowid
  );
});

describe("qualitative-flag version gate (#549 routing #544 + #548)", () => {
  it("leaves the stale extractor flags untouched while the signature is unchanged", () => {
    // Boot already stored the CURRENT signature, so the gate skips: no re-scan.
    expect(storedSig()).toBe(canonicalFlagsSignature());
    reconcileFlagsIfCanonicalChanged(db);
    expect(flagOf(hbsAbId)).toBe("abnormal");
    expect(flagOf(bloodTypeId)).toBe("abnormal");
  });

  it("re-derives the qualitative flags when the signature moves", () => {
    db.prepare(
      "UPDATE settings SET value = 'stale-signature' WHERE key = 'canonical_flags_sig'"
    ).run();

    reconcileFlagsIfCanonicalChanged(db);

    // Immune-positive surface ANTIBODY → neutral "immune" (#544).
    expect(flagOf(hbsAbId)).toBe("immune");
    // Immutable neutral attribute → cleared to NULL (#548 §1).
    expect(flagOf(bloodTypeId)).toBeNull();
    // Infection marker (surface ANTIGEN) positive → STILL "abnormal" (never quieted).
    expect(flagOf(hbsAgId)).toBe("abnormal");
    // …and the gate records the current signature so it runs once per change.
    expect(storedSig()).toBe(canonicalFlagsSignature());
  });
});
