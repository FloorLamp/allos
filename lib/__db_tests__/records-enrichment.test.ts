// DB INTEGRATION TIER — the records-surface enrichment gathers (#1354 bidirectional
// safety cross-links + #1355 encounter link lines), per the #448 findings-builder-test
// discipline.
//
// #1354: getAllergyMedCrossLinks / getPgxMedCrossLinks are the RECORD-SIDE inverses of
// the meds-side getDrugAllergyWarnings / getPgxWarnings builders — the SAME findings,
// the SAME dedupeKeys, filtered through the SAME suppression bus and grouped by record
// id so the Allergies / Genomics surfaces show, on each row, the active meds it
// contraindicates / affects. This seeds the issue fixtures and asserts the grouped
// output, plus the "dismiss once, silence everywhere" contract (a dismiss on the shared
// bus key — the SAME key the meds board's activeByKey filter reads — hides the
// record-side line) and profile isolation.
//
// #1355: encountersForRecords is the batch inverse of encounterForRecord — the linked
// encounter for every procedure/condition row, keyed by record id — powering the
// "Performed at: …" / "Diagnosed at: …" lines. Seeds a linked + an unlinked row and
// asserts the map (with provider name + date + type) and profile scope.
//
// Fixtures are 100% synthetic (a throwaway per-file DB via setup.ts). No AI, no network.

import { describe, it, expect } from "vitest";
import { db } from "@/lib/db";
import {
  getAllergyMedCrossLinks,
  getPgxMedCrossLinks,
  getDrugAllergyWarnings,
  getPgxWarnings,
  encountersForRecords,
  dismissFinding,
} from "@/lib/queries";
import { pgxSignalKey } from "@/lib/pgx";

function makeProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

function addMedication(profileId: number, name: string): number {
  return Number(
    db
      .prepare(
        `INSERT INTO intake_items (profile_id, name, active, kind)
         VALUES (?, ?, 1, 'medication')`
      )
      .run(profileId, name).lastInsertRowid
  );
}

function addAllergy(
  profileId: number,
  substance: string,
  reaction: string | null = null
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO allergies (profile_id, substance, reaction, status)
         VALUES (?, ?, ?, 'active')`
      )
      .run(profileId, substance, reaction).lastInsertRowid
  );
}

function addVariant(profileId: number, gene: string, interp: string): number {
  return Number(
    db
      .prepare(
        `INSERT INTO genomic_variants
           (profile_id, gene, star_allele, result_type, interpretation)
         VALUES (?, ?, '*2/*2', 'pharmacogenomic', ?)`
      )
      .run(profileId, gene, interp).lastInsertRowid
  );
}

describe("getAllergyMedCrossLinks — record-side allergy → contraindicated meds (#1354)", () => {
  it("groups the SAME drug-allergy hits by allergy row id (Penicillin × amoxicillin)", () => {
    const profileId = makeProfile("allergy-crosslink");
    const allergyId = addAllergy(profileId, "Penicillin", "hives");
    const medId = addMedication(profileId, "Amoxicillin 500 mg");

    const byAllergy = getAllergyMedCrossLinks(profileId);
    const hits = byAllergy[allergyId];
    expect(hits).toHaveLength(1);
    expect(hits[0].medId).toBe(medId);
    expect(hits[0].medName).toBe("Amoxicillin 500 mg");
    // Same finding as the meds-side builder — same key namespace, no second computation.
    expect(hits[0].dedupeKey).toBe(
      getDrugAllergyWarnings(profileId)[0].dedupeKey
    );
  });

  it("dismiss on the shared bus hides the record-side line too (silence everywhere)", () => {
    const profileId = makeProfile("allergy-crosslink-dismiss");
    const allergyId = addAllergy(profileId, "Penicillin", "hives");
    addMedication(profileId, "Amoxicillin 500 mg");
    const key = getAllergyMedCrossLinks(profileId)[allergyId][0].dedupeKey;

    // The record surface uses the SAME activeByKey filter the /medications board uses,
    // so a dismiss on the shared key silences both calm management surfaces.
    dismissFinding(profileId, key);
    expect(getAllergyMedCrossLinks(profileId)[allergyId]).toBeUndefined();
  });

  it("absent-pillar + profile isolation: no hit → no entry, and one profile never leaks", () => {
    const a = makeProfile("allergy-none");
    addAllergy(a, "Peanut", "anaphylaxis"); // no contraindicated med on file
    addMedication(a, "Metformin 500 mg");
    expect(getAllergyMedCrossLinks(a)).toEqual({});

    const b = makeProfile("allergy-other");
    const bAllergy = addAllergy(b, "Penicillin");
    addMedication(b, "Amoxicillin 500 mg");
    // a's map must not carry b's row.
    expect(getAllergyMedCrossLinks(a)[bAllergy]).toBeUndefined();
    expect(getAllergyMedCrossLinks(b)[bAllergy]).toBeDefined();
  });
});

describe("getPgxMedCrossLinks — record-side variant → affected meds (#1354)", () => {
  it("groups the SAME PGx hits by variant row id (CYP2C19 poor × clopidogrel)", () => {
    const profileId = makeProfile("pgx-crosslink");
    const variantId = addVariant(profileId, "CYP2C19", "Poor metabolizer");
    const medId = addMedication(profileId, "Clopidogrel");

    const byVariant = getPgxMedCrossLinks(profileId);
    const hits = byVariant[variantId];
    expect(hits).toHaveLength(1);
    expect(hits[0].medId).toBe(medId);
    expect(hits[0].gene).toBe("CYP2C19");
    expect(hits[0].phenotype).toBe("poor");
    expect(hits[0].dedupeKey).toBe(pgxSignalKey(medId, "CYP2C19", "poor"));
    expect(hits[0].dedupeKey).toBe(getPgxWarnings(profileId)[0].dedupeKey);
  });

  it("dismiss on the shared bus hides the record-side variant line too", () => {
    const profileId = makeProfile("pgx-crosslink-dismiss");
    const variantId = addVariant(profileId, "CYP2C19", "Poor metabolizer");
    const medId = addMedication(profileId, "Clopidogrel");
    const key = pgxSignalKey(medId, "CYP2C19", "poor");

    expect(getPgxMedCrossLinks(profileId)[variantId]).toBeDefined();
    dismissFinding(profileId, key);
    expect(getPgxMedCrossLinks(profileId)[variantId]).toBeUndefined();
  });
});

describe("encountersForRecords — record → linked visit (#1355)", () => {
  it("keys the linked encounter (with provider) by record id; unlinked rows are absent; profile-scoped", () => {
    const profileId = makeProfile("enc-links");
    const providerId = Number(
      db
        .prepare(
          "INSERT INTO providers (name, type, dedup_key) VALUES (?, 'individual', ?)"
        )
        .run("Dr. Ng", "dk:dr-ng").lastInsertRowid
    );
    const encId = Number(
      db
        .prepare(
          `INSERT INTO encounters (profile_id, date, type, class_code, provider_id)
           VALUES (?, '2026-05-04', 'Office Visit', 'AMB', ?)`
        )
        .run(profileId, providerId).lastInsertRowid
    );
    const linkedProc = Number(
      db
        .prepare(
          `INSERT INTO procedures (profile_id, name, date, encounter_id)
           VALUES (?, 'Appendectomy', '2026-05-04', ?)`
        )
        .run(profileId, encId).lastInsertRowid
    );
    const unlinkedProc = Number(
      db
        .prepare(
          `INSERT INTO procedures (profile_id, name, date) VALUES (?, 'Colonoscopy', '2025-01-02')`
        )
        .run(profileId).lastInsertRowid
    );
    const linkedCond = Number(
      db
        .prepare(
          `INSERT INTO conditions (profile_id, name, status, encounter_id)
           VALUES (?, 'Appendicitis', 'active', ?)`
        )
        .run(profileId, encId).lastInsertRowid
    );

    const procMap = encountersForRecords(profileId, "procedure");
    expect(procMap[linkedProc]).toBeDefined();
    expect(procMap[linkedProc].id).toBe(encId);
    expect(procMap[linkedProc].providerName).toBe("Dr. Ng");
    expect(procMap[linkedProc].date).toBe("2026-05-04");
    expect(procMap[linkedProc].type).toBe("Office Visit");
    expect(procMap[unlinkedProc]).toBeUndefined();

    const condMap = encountersForRecords(profileId, "condition");
    expect(condMap[linkedCond]?.id).toBe(encId);

    // Profile isolation: another profile's map is empty.
    const other = makeProfile("enc-links-other");
    expect(encountersForRecords(other, "procedure")).toEqual({});
  });
});
