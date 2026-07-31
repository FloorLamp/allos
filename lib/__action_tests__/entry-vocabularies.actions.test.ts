// SERVER-ACTION TIER — the write-time canonicalization behind the #1676 pickers.
//
// The allergen and gene fields feed cross-checks that key on the stored STRING, so
// the question the pure tier can't answer is whether the ACTION actually stores a
// spelling those checks can see — and whether the check then fires for real, through
// the query layer, against a live medication stack.

import { describe, it, expect } from "vitest";
import { db } from "@/lib/db";
import {
  addAllergy,
  updateAllergy,
} from "@/app/(app)/records/problems/allergies/actions";
import {
  addGenomicVariant,
  updateGenomicVariant,
} from "@/app/(app)/results/genomics/actions";
import { getAllergies, getGenomicVariants } from "@/lib/queries";
import {
  getDrugAllergyWarnings,
  getPgxWarnings,
} from "@/lib/queries/intake/warnings";
import { actAs, createLogin, createProfile, fd } from "./harness";

function seedMed(profileId: number, name: string): number {
  return Number(
    db
      .prepare(
        `INSERT INTO intake_items
           (profile_id, name, active, kind, condition, obligation)
         VALUES (?, ?, 1, 'medication', 'daily', 'must')`
      )
      .run(profileId, name).lastInsertRowid
  );
}

function actingProfile(name: string) {
  const login = createLogin();
  const profile = createProfile(name, login.id);
  actAs(login, profile);
  return profile;
}

describe("allergen substance canonicalization (#1676)", () => {
  it("stores the vocabulary's spelling for a recognized alias", async () => {
    const profile = actingProfile("allergen-alias");
    expect((await addAllergy(fd({ substance: " soy " }))).ok).toBe(true);
    expect(getAllergies(profile.id)[0].substance).toBe("Soybean");
  });

  it("stores an unrecognized allergen exactly as typed", async () => {
    const profile = actingProfile("allergen-freetext");
    expect((await addAllergy(fd({ substance: "  Blue dye #1 " }))).ok).toBe(
      true
    );
    expect(getAllergies(profile.id)[0].substance).toBe("Blue dye #1");
  });

  it("canonicalizes on edit too, and the drug cross-check then fires", async () => {
    const profile = actingProfile("allergen-crosscheck");
    seedMed(profile.id, "Amoxicillin 500 mg");
    // "PCN" is what people write and what the cross-check cannot see: the allergy is
    // on file, the medication is active, and no warning is produced.
    expect((await addAllergy(fd({ substance: "PCN" }))).ok).toBe(true);
    const allergyId = getAllergies(profile.id)[0].id;
    expect(getDrugAllergyWarnings(profile.id)).toEqual([]);

    // Re-saving with a name the picker offers is the whole fix.
    expect(
      (
        await updateAllergy(
          fd({
            id: String(allergyId),
            substance: "penicillin-class antibiotics",
            status: "active",
          })
        )
      ).ok
    ).toBe(true);
    expect(getAllergies(profile.id)[0].substance).toBe(
      "Penicillin-class antibiotics"
    );
    const hits = getDrugAllergyWarnings(profile.id);
    expect(hits).toHaveLength(1);
    expect(hits[0].medName).toBe("Amoxicillin 500 mg");
  });
});

describe("gene symbol canonicalization (#1676)", () => {
  it("stores the canonical PGx symbol and the cross-check then fires", async () => {
    const profile = actingProfile("gene-crosscheck");
    seedMed(profile.id, "Clopidogrel 75 mg");
    expect(
      (
        await addGenomicVariant(
          fd({
            gene: "cyp 2c19",
            star_allele: "*2/*2",
            result_type: "pharmacogenomic",
            interpretation: "Poor metabolizer",
          })
        )
      ).ok
    ).toBe(true);
    const [stored] = getGenomicVariants(profile.id);
    expect(stored.gene).toBe("CYP2C19");
    const hits = getPgxWarnings(profile.id);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].gene).toBe("CYP2C19");
  });

  it("leaves a non-PGx gene alone on add and on edit", async () => {
    const profile = actingProfile("gene-freetext");
    expect((await addGenomicVariant(fd({ gene: " BRCA1 " }))).ok).toBe(true);
    const [stored] = getGenomicVariants(profile.id);
    expect(stored.gene).toBe("BRCA1");
    expect(
      (
        await updateGenomicVariant(
          fd({ id: String(stored.id), gene: "brca2", result_type: "carrier" })
        )
      ).ok
    ).toBe(true);
    expect(getGenomicVariants(profile.id)[0].gene).toBe("brca2");
  });
});
