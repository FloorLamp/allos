// DB INTEGRATION TIER — the modern gut panel reaches rows that were ingested BEFORE it
// existed (#2787).
//
// Adding a curated entry is only half the point of that issue. The other half is
// retroactive: a stool report imported last year stored its calprotectin as an
// unclassifiable result — kept and reported, never guessed — with no band to judge it
// and therefore no flag. Adding the entry has to reach that row, and the mechanism is
// the boot gate: `name`, `ref_*`, `optimal_*` and `direction` are all
// FLAG_RELEVANT_FIELDS, so three new rows move `canonicalFlagsSignature()` on their own
// and `reconcileFlagsIfCanonicalChanged` re-derives every stored record once. No
// FLAG_LOGIC_VERSION bump rides with this, deliberately — the version is for a
// derivation-LOGIC change with the dataset held still (v10, v11), and claiming one here
// would assert a logic change nobody made.
//
// So this test is the version bump's REPLACEMENT, not its companion: it exercises the
// propagation end-to-end rather than asserting a constant. Each row is inserted with
// flag NULL, exactly as it sits on disk today, the stored signature is staled to
// simulate the deploy boot, and the reconcile is what must set the flag.
//
// It also pins the two curation decisions the issue called out as not mechanical:
//   • Pancreatic Elastase-1 is LOW-abnormal. The registry expresses that with
//     direction `higher_better` + a one-sided `ref_low`, and the three published bands
//     land on the app's three states — >200 clean, 100–200 `non-optimal-low`
//     (moderate insufficiency), <100 `low` (severe).
//   • H. pylori Stool Antigen is QUALITATIVE, so it carries NO numeric band and is
//     judged by the #549/#629 classifier instead. Its name contains "antigen", so
//     INFECTION_MARKER already resolves a positive to bad polarity — the dipstick
//     discipline, not a second convention.
//
// The db singleton is redirected at a per-file temp DB by setup.ts before import.

import { describe, it, expect, beforeAll } from "vitest";
import { db } from "@/lib/db";
import { reconcileFlagsIfCanonicalChanged } from "@/lib/migrations/boot-tasks";
import { canonicalFlagsSignature } from "@/lib/canonical-flags-version";

let profileId: number;
// Fecal Calprotectin (lower_better, optimal ≤50, reference ≤120).
let calproRaisedId: number; // 260 ug/g — raised
let calproBorderlineId: number; // 75 ug/g — the 50–120 grey zone
let calproNormalId: number; // 22 ug/g — clean
// Pancreatic Elastase-1, Stool (higher_better, reference ≥100, optimal ≥200).
let elastaseSevereId: number; // 40 ug/g — severe insufficiency
let elastaseModerateId: number; // 150 ug/g — moderate insufficiency
let elastaseSufficientId: number; // 420 ug/g — sufficient
// H. pylori Stool Antigen — qualitative, no numeric band.
let hpyloriPositiveId: number;
let hpyloriNegativeId: number;

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
    db.prepare("INSERT INTO profiles (name) VALUES ('Gut Panel')").run()
      .lastInsertRowid
  );
  // Numeric rows, stored the way a pre-entry import left them: a real value, a real
  // unit, and NO flag, because nothing published a band for the name at the time.
  const num = db.prepare(
    `INSERT INTO medical_records
       (profile_id, date, category, name, value, unit, canonical_name, value_num, flag)
     VALUES (?, '2024-03-04', 'lab', ?, ?, ?, ?, ?, NULL)`
  );
  const insertNum = (name: string, value: number, unit: string) =>
    Number(
      num.run(profileId, name, String(value), unit, name, value).lastInsertRowid
    );

  calproRaisedId = insertNum("Fecal Calprotectin", 260, "ug/g");
  calproBorderlineId = insertNum("Fecal Calprotectin", 75, "ug/g");
  calproNormalId = insertNum("Fecal Calprotectin", 22, "ug/g");
  elastaseSevereId = insertNum("Pancreatic Elastase-1, Stool", 40, "ug/g");
  elastaseModerateId = insertNum("Pancreatic Elastase-1, Stool", 150, "ug/g");
  elastaseSufficientId = insertNum("Pancreatic Elastase-1, Stool", 420, "ug/g");

  // Qualitative rows: value_num IS NULL, so the numeric pass has nothing to judge and
  // the classifier is the only thing that can answer.
  const qual = db.prepare(
    `INSERT INTO medical_records
       (profile_id, date, category, name, value, canonical_name, flag)
     VALUES (?, '2024-03-04', 'lab', 'H. pylori Stool Antigen', ?, 'H. pylori Stool Antigen', NULL)`
  );
  hpyloriPositiveId = Number(qual.run(profileId, "Positive").lastInsertRowid);
  hpyloriNegativeId = Number(qual.run(profileId, "Negative").lastInsertRowid);
});

describe("the gut panel reaches rows stored before its entries existed", () => {
  it("leaves every row unflagged while the signature has not moved (the gate, not a blind rescan)", () => {
    // The boot on import already stored the current signature, so this call must do
    // nothing at all. Without this the assertions below would pass for the wrong
    // reason — any unconditional rescan would also flag them.
    expect(storedSig()).toBe(canonicalFlagsSignature());
    reconcileFlagsIfCanonicalChanged(db);
    expect(flagOf(calproRaisedId)).toBeNull();
    expect(flagOf(elastaseSevereId)).toBeNull();
    expect(flagOf(hpyloriPositiveId)).toBeNull();
  });

  it("derives the flags for the already-stored rows once the signature moves", () => {
    db.prepare(
      "UPDATE settings SET value = 'stale-signature-2787' WHERE key = 'canonical_flags_sig'"
    ).run();
    reconcileFlagsIfCanonicalChanged(db);

    // Calprotectin — lower_better across the three published bands.
    expect(flagOf(calproRaisedId)).toBe("high");
    expect(flagOf(calproBorderlineId)).toBe("non-optimal-high");
    expect(flagOf(calproNormalId)).toBeNull();

    // Elastase — the LOW direction really is the abnormal one, and the range shape
    // expresses it: a one-sided ref_low judged by referenceStatus's "below" branch.
    expect(flagOf(elastaseSevereId)).toBe("low");
    expect(flagOf(elastaseModerateId)).toBe("non-optimal-low");
    expect(flagOf(elastaseSufficientId)).toBeNull();

    // H. pylori — no numeric band; the qualitative classifier resolves the positive as
    // an infection marker and leaves the negative clean.
    expect(flagOf(hpyloriPositiveId)).toBe("abnormal");
    expect(flagOf(hpyloriNegativeId)).toBeNull();

    // …and the gate recorded the current signature, so it runs once per change.
    expect(storedSig()).toBe(canonicalFlagsSignature());
  });
});
