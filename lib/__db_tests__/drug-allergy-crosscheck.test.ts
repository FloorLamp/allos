// DB INTEGRATION TIER — the drug-allergy × medication-stack cross-check builder
// (#1029), per the #448 findings-builder-test discipline.
//
// getDrugAllergyWarnings is a findings BUILDER: it GATHERS DB state (the profile's
// NON-RESOLVED recorded allergies with their codes + its ACTIVE medications, via the
// shared getIntakeSafetyContext) and hands it to the pure engine
// (crossCheckDrugAllergies). The pure tier (lib/__tests__/drug-allergy.test.ts) takes
// pre-gathered arrays and structurally can't see a gather bug (a resolved allergy or
// inactive/supplement row leaking in, the code column not threaded) — so this seeds
// the issue's own fixture ("Penicillin — hives" + tracked amoxicillin) and asserts the
// END-TO-END finding plus its dismissible Upcoming twin (one question, one
// computation) and the id-keyed dedupeKey.
//
// Fixtures are 100% synthetic (a throwaway per-file DB via setup.ts). No AI, no network.

import { describe, it, expect } from "vitest";
import { db, today } from "@/lib/db";
import {
  getDrugAllergyWarnings,
  collectUpcoming,
  dismissFinding,
} from "@/lib/queries";

function makeProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

function addMedication(
  profileId: number,
  name: string,
  active = 1,
  rxcui: string | null = null,
  rxcuiIngredients: string | null = null
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO intake_items (profile_id, name, active, kind, rxcui, rxcui_ingredients)
         VALUES (?, ?, ?, 'medication', ?, ?)`
      )
      .run(profileId, name, active, rxcui, rxcuiIngredients).lastInsertRowid
  );
}

function addAllergy(
  profileId: number,
  substance: string,
  over: {
    status?: string;
    reaction?: string | null;
    code?: string | null;
    codeSystem?: string | null;
  } = {}
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO allergies
           (profile_id, substance, substance_code, substance_code_system, reaction, status)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        profileId,
        substance,
        over.code ?? null,
        over.codeSystem ?? null,
        over.reaction ?? null,
        over.status ?? "active"
      ).lastInsertRowid
  );
}

describe("getDrugAllergyWarnings — recorded allergy × active med (#1029)", () => {
  it("flags the issue fixture ('Penicillin — hives' × tracked amoxicillin) on both surfaces, dismiss silences everywhere", () => {
    const profileId = makeProfile("allergy-penicillin-amoxicillin");
    const allergyId = addAllergy(profileId, "Penicillin", {
      reaction: "hives",
    });
    const medId = addMedication(profileId, "Amoxicillin 500 mg");

    const warnings = getDrugAllergyWarnings(profileId);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].match).toBe("class");
    expect(warnings[0].substance).toBe("Penicillin");
    expect(warnings[0].reaction).toBe("hives");
    expect(warnings[0].dedupeKey).toBe(`allergy-med:${allergyId}-${medId}`);

    // Surface 2: the dismissible Upcoming finding — same dedupeKey, care-tier band.
    const up = collectUpcoming(profileId, today(profileId)).find(
      (i) => i.domain === "allergy-med"
    );
    expect(up?.key).toBe(warnings[0].dedupeKey);
    expect(up?.band).toBe("today"); // care-tier → Needs-attention hero
    expect(up?.detail).toContain("discuss with your prescriber");

    // Dismiss once (the clinician-reviewed, deliberately-continued med case) —
    // silenced on Upcoming AND the intake-strip gather path is bus-filtered by its
    // consumers with the same key.
    dismissFinding(profileId, warnings[0].dedupeKey);
    expect(
      collectUpcoming(profileId, today(profileId)).some(
        (i) => i.domain === "allergy-med"
      )
    ).toBe(false);
  });

  it("matches code-first: an allergen with an RxNorm substance_code hits a med carrying that ingredient CUI", () => {
    const profileId = makeProfile("allergy-code-first");
    // Synthetic CUIs; the med name shares no token with the allergen, so ONLY the
    // code path can match — proving substance_code is no longer dead weight.
    addAllergy(profileId, "Beta-lactam allergen (coded)", {
      code: "999001",
      codeSystem: "2.16.840.1.113883.6.88",
    });
    addMedication(profileId, "Brandomycin XR", 1, "999900", '["999001"]');

    const warnings = getDrugAllergyWarnings(profileId);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].match).toBe("ingredient");
  });

  it("cross-class: penicillin allergy × cephalexin med carries the cross-reactivity wording", () => {
    const profileId = makeProfile("allergy-cross-class");
    addAllergy(profileId, "Penicillin");
    addMedication(profileId, "Cephalexin 250 mg");
    const warnings = getDrugAllergyWarnings(profileId);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].match).toBe("cross-class");
    expect(warnings[0].note.toLowerCase()).toContain("cross-reactivity");
  });

  it("ignores a RESOLVED allergy, an INACTIVE med, a supplement row, and an unrelated med", () => {
    const profileId = makeProfile("allergy-negatives");
    addAllergy(profileId, "Penicillin", { status: "resolved" });
    addMedication(profileId, "Amoxicillin 500 mg"); // only the resolved allergy could match
    expect(getDrugAllergyWarnings(profileId)).toEqual([]);

    const p2 = makeProfile("allergy-negatives-2");
    addAllergy(p2, "Penicillin");
    addMedication(p2, "Penicillin V", 0); // inactive → out of the active stack
    db.prepare(
      `INSERT INTO intake_items (profile_id, name, active, kind)
       VALUES (?, 'Penicillin-name Supplement', 1, 'supplement')`
    ).run(p2); // a supplement is never screened as a medication
    addMedication(p2, "Metformin 500 mg"); // unrelated
    expect(getDrugAllergyWarnings(p2)).toEqual([]);
  });
});
