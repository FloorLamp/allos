// DB INTEGRATION TIER (#1051 med↔prescriber, #1052 med↔indication). Exercises the
// import tier-1 indication self-heal + reprocess re-derivation, the records-bridge
// provider/source-record carry-through + the transitive "Prescribed at" chain, the
// exact-individual backfill's determinism boundary, the picker two-rows-for-one-person
// trap, provider merge re-keying, and the row-ops NULL-out on record/condition delete.
// Deterministic: :memory: DB via setup.ts; fixed dates.

import { describe, it, expect, beforeEach } from "vitest";
import { db } from "@/lib/db";
import {
  persistDocumentImport,
  clearImportedDocumentRows,
} from "@/lib/import-persist";
import { captureDelete } from "@/lib/undo-delete-db";
import { up as backfillPrescriberLinks } from "@/lib/migrations/versions/088-backfill-prescriber-links";
import type { PersistInput } from "@/lib/import-shape";
import {
  createMedicationFromRecord,
  encounterForRecord,
  linkMedIndication,
  declineMedIndication,
  indicationSuggestionForMed,
  linkMedPrescriber,
  prescriberSuggestionsForProfile,
  getMedicationsForCondition,
} from "@/lib/queries";
import {
  resolveProviderIdByName,
  resolveExactPrescriberId,
  mergeProviders,
} from "@/lib/providers-db";

const DATE = "2026-03-03";

function emptyInput(over: Partial<PersistInput> = {}): PersistInput {
  return {
    records: [],
    immunizations: [],
    allergies: [],
    conditions: [],
    encounters: [],
    procedures: [],
    familyHistory: [],
    carePlanItems: [],
    careGoals: [],
    appointments: [],
    bodyMetrics: [],
    heights: [],
    headCircs: [],
    demographics: null,
    canonicalNamesToRegister: [],
    providers: [],
    meta: {
      docType: "ccd",
      source: "Test Clinic",
      documentDate: DATE,
      patientName: null,
      raw: null,
      model: null,
      importReport: null,
    },
    ...over,
  };
}

// A bundle: one condition (Otitis media) + a prescription record that names it as the
// indication (reasonReference-resolved external_id) AND carries an encounter link.
function bundleWithIndication(): PersistInput {
  return emptyInput({
    encounters: [
      {
        date: DATE,
        end_date: null,
        type: "Office Visit",
        code: null,
        code_system: null,
        class_code: "AMB",
        reason: "Ear pain",
        diagnoses: [],
        provider: null,
        location: null,
        notes: null,
        external_id: "ccda:encounter:v1",
      },
    ],
    conditions: [
      {
        name: "Otitis media",
        code: "H66.9",
        code_system: "ICD-10-CM",
        status: "active",
        onset_date: DATE,
        resolved_date: null,
        external_id: "ccda:condition:otitis",
      },
    ],
    records: [
      {
        category: "prescription",
        name: "Amoxicillin 500 mg",
        canonical: "Amoxicillin 500 mg",
        value: null,
        value_num: null,
        unit: null,
        date: DATE,
        reference_range: null,
        flag: null,
        panel: null,
        notes: "Take 1 capsule by mouth twice daily",
        source: null,
        external_id: "med:amox",
        loinc: null,
        provider: null,
        encounter_external_id: "ccda:encounter:v1",
        indication_condition_external_id: "ccda:condition:otitis",
      },
    ],
  });
}

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}
function newDocument(profileId: number): number {
  return Number(
    db
      .prepare(
        `INSERT INTO medical_documents (profile_id, filename, stored_path, extraction_status)
         VALUES (?, 'r.xml', '/tmp/r.xml', 'pending')`
      )
      .run(profileId).lastInsertRowid
  );
}
function individualProvider(name: string, npi: string | null = null): number {
  return Number(
    db
      .prepare(
        `INSERT INTO providers (name, type, npi, dedup_key)
         VALUES (?, 'individual', ?, ?)`
      )
      .run(
        name,
        npi,
        npi ? `npi:${npi}` : `name:individual:${name.toLowerCase()}`
      ).lastInsertRowid
  );
}
function orgProvider(name: string): number {
  return Number(
    db
      .prepare(
        `INSERT INTO providers (name, type, dedup_key)
         VALUES (?, 'organization', ?)`
      )
      .run(name, `name:organization:${name.toLowerCase()}`).lastInsertRowid
  );
}
function insertMed(
  profileId: number,
  over: {
    name?: string;
    prescriber?: string | null;
    provider_id?: number | null;
    notes?: string | null;
  } = {}
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO intake_items
           (name, kind, condition, priority, active, prescriber, provider_id, notes, source, profile_id)
         VALUES (?, 'medication', 'daily', 'high', 1, ?, ?, ?, 'manual', ?)`
      )
      .run(
        over.name ?? "Amoxicillin",
        over.prescriber ?? null,
        over.provider_id ?? null,
        over.notes ?? null,
        profileId
      ).lastInsertRowid
  );
}

let profileId: number;
beforeEach(() => {
  // providers is a GLOBAL table (not profile-scoped), so a name inserted by one test
  // would collide on dedup_key or pollute another test's registryRows(). Reset the
  // whole graph per test for isolation (FK off during the wipe).
  db.pragma("foreign_keys = OFF");
  for (const t of [
    "med_link_decisions",
    "intake_item_doses",
    "intake_item_logs",
    "medication_courses",
    "intake_item_side_effects",
    "intake_items",
    "medical_records",
    "conditions",
    "encounters",
    "medical_documents",
    "providers",
  ]) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
  db.pragma("foreign_keys = ON");
  profileId = newProfile(`ML-${Math.random()}`);
});

describe("#1052 tier-1 indication (import reasonReference)", () => {
  it("links the projected med to the imported condition end-to-end", () => {
    const doc = newDocument(profileId);
    persistDocumentImport(profileId, doc, bundleWithIndication());
    const med = db
      .prepare(
        `SELECT indication_condition_id FROM intake_items WHERE profile_id = ? AND kind = 'medication'`
      )
      .get(profileId) as { indication_condition_id: number | null };
    const cond = db
      .prepare(
        `SELECT id FROM conditions WHERE profile_id = ? AND name = 'Otitis media'`
      )
      .get(profileId) as { id: number };
    expect(med.indication_condition_id).toBe(cond.id);
    // Inverse view (the projected med's name is cleaned to "Amoxicillin").
    expect(
      getMedicationsForCondition(profileId, cond.id).map((m) => m.name)
    ).toContain("Amoxicillin");
  });

  it("re-derives the link on reprocess (delete-and-reinsert)", () => {
    const doc = newDocument(profileId);
    persistDocumentImport(profileId, doc, bundleWithIndication());
    persistDocumentImport(profileId, doc, bundleWithIndication());
    const med = db
      .prepare(
        `SELECT indication_condition_id FROM intake_items WHERE profile_id = ? AND kind = 'medication'`
      )
      .get(profileId) as { indication_condition_id: number | null };
    expect(med.indication_condition_id).not.toBeNull();
  });
});

describe("#1052 tier-2 suggest-and-accept + decline memory", () => {
  it("proposes a text-match condition without linking, and accept persists", () => {
    db.prepare(
      `INSERT INTO conditions (name, code, status, source, profile_id) VALUES ('Migraine','G43.9','active',NULL,?)`
    ).run(profileId);
    const cond = db
      .prepare(`SELECT id FROM conditions WHERE profile_id = ?`)
      .get(profileId) as { id: number };
    const medId = insertMed(profileId, {
      notes: "Prescribed for migraine relief",
    });
    const suggestion = indicationSuggestionForMed(profileId, medId);
    expect(suggestion?.id).toBe(cond.id);
    // Still unlinked until accepted.
    expect(
      (
        db
          .prepare(
            `SELECT indication_condition_id FROM intake_items WHERE id = ?`
          )
          .get(medId) as {
          indication_condition_id: number | null;
        }
      ).indication_condition_id
    ).toBeNull();
    expect(linkMedIndication(profileId, medId, cond.id)).toBe(true);
    expect(
      (
        db
          .prepare(
            `SELECT indication_condition_id FROM intake_items WHERE id = ?`
          )
          .get(medId) as {
          indication_condition_id: number | null;
        }
      ).indication_condition_id
    ).toBe(cond.id);
  });

  it("a declined suggestion is not re-proposed", () => {
    db.prepare(
      `INSERT INTO conditions (name, code, status, source, profile_id) VALUES ('Migraine','G43.9','active',NULL,?)`
    ).run(profileId);
    const cond = db
      .prepare(`SELECT id FROM conditions WHERE profile_id = ?`)
      .get(profileId) as {
      id: number;
    };
    const medId = insertMed(profileId, { notes: "for migraine" });
    expect(indicationSuggestionForMed(profileId, medId)?.id).toBe(cond.id);
    declineMedIndication(profileId, medId, cond.id);
    expect(indicationSuggestionForMed(profileId, medId)).toBeNull();
  });

  it("deleting the source document's condition NULLs the med's indication (row-ops)", () => {
    const doc = newDocument(profileId);
    persistDocumentImport(profileId, doc, bundleWithIndication());
    // Deleting the whole document clears its footprint incl. the condition, NULLing the
    // med's indication link first (no FK trip).
    clearImportedDocumentRows(profileId, doc);
    const med = db
      .prepare(
        `SELECT indication_condition_id FROM intake_items WHERE profile_id = ?`
      )
      .get(profileId) as { indication_condition_id: number | null } | undefined;
    // The extracted med is a footprint row too, so it's deleted; assert no FK error
    // was thrown (the delete completed) and nothing dangles.
    expect(med).toBeUndefined();
  });
});

describe("#1051 records bridge carries provider_id + source_record_id", () => {
  it("carries the record's individual provider + its OWN visit link (no source_record_id since #1178)", () => {
    const providerId = individualProvider("Dr. Rivera");
    const doc = newDocument(profileId);
    // A prescription record linked to an encounter + the individual prescriber.
    const encounterId = Number(
      db
        .prepare(
          `INSERT INTO encounters (date, type, source, document_id, external_id, profile_id)
           VALUES (?, 'Office Visit', 'Clinic', ?, 'clinic|enc1', ?)`
        )
        .run(DATE, doc, profileId).lastInsertRowid
    );
    const recordId = Number(
      db
        .prepare(
          `INSERT INTO medical_records
             (date, category, name, provider_id, encounter_id, document_id, source, profile_id)
           VALUES (?, 'prescription', 'Amoxicillin 500 mg', ?, ?, ?, 'Clinic', ?)`
        )
        .run(DATE, providerId, encounterId, doc, profileId).lastInsertRowid
    );
    const created = createMedicationFromRecord(profileId, recordId);
    expect(created).not.toBeNull();
    const med = db
      .prepare(`SELECT provider_id, encounter_id FROM intake_items WHERE id = ?`)
      .get(created!.id) as {
      provider_id: number | null;
      encounter_id: number | null;
    };
    expect(med.provider_id).toBe(providerId);
    // Since #1178 the med carries the record's OWN encounter link directly — no
    // source_record_id chain — so "Prescribed at" resolves off the med itself.
    expect(med.encounter_id).toBe(encounterId);
    const via = encounterForRecord(profileId, "medication", created!.id);
    expect(via?.id).toBe(encounterId);
  });

  it("falls back to text-resolving the prescriber when the record's provider is an org", () => {
    const orgId = orgProvider("Sample Care East");
    const drId = individualProvider("Dr. Rivera");
    const doc = newDocument(profileId);
    const recordId = Number(
      db
        .prepare(
          `INSERT INTO medical_records
             (date, category, name, notes, provider_id, document_id, source, profile_id)
           VALUES (?, 'prescription', 'Amoxicillin', 'Prescriber: Dr. Rivera', ?, ?, 'Clinic', ?)`
        )
        .run(DATE, orgId, doc, profileId).lastInsertRowid
    );
    const created = createMedicationFromRecord(profileId, recordId);
    const med = db
      .prepare(`SELECT provider_id FROM intake_items WHERE id = ?`)
      .get(created!.id) as { provider_id: number | null };
    // The org link is NOT carried into the prescriber slot; the free-text prescriber
    // resolves to the individual instead.
    expect(med.provider_id).toBe(drId);
  });
});

describe("#1051 backfill (migration 085) — determinism boundary", () => {
  it("links exact individual matches, leaves near-miss / org-typed / ambiguous / occupied", () => {
    const dr = individualProvider("Sarah Chen");
    orgProvider("Dr. Rivera"); // org-only name → not linked
    individualProvider("John Doe", "1111111111");
    individualProvider("John Doe", "2222222222"); // two distinct rows, same name → ambiguous
    const occupyingOrg = orgProvider("Occupied Clinic");

    const exact = insertMed(profileId, { prescriber: "Sarah Chen" });
    const orgOnly = insertMed(profileId, { prescriber: "Dr. Rivera" });
    const nearMiss = insertMed(profileId, { prescriber: "S. Chen" });
    const ambiguous = insertMed(profileId, { prescriber: "John Doe" });
    const occupied = insertMed(profileId, {
      prescriber: "Sarah Chen",
      provider_id: occupyingOrg,
    });

    backfillPrescriberLinks(db);

    const pid = (id: number) =>
      (
        db
          .prepare(`SELECT provider_id FROM intake_items WHERE id = ?`)
          .get(id) as {
          provider_id: number | null;
        }
      ).provider_id;
    expect(pid(exact)).toBe(dr);
    expect(pid(orgOnly)).toBeNull();
    expect(pid(nearMiss)).toBeNull();
    expect(pid(ambiguous)).toBeNull();
    // An already-occupied (org) link is never clobbered.
    expect(pid(occupied)).toBe(occupyingOrg);
  });
});

describe("#1051 picker two-rows-for-one-person trap closed", () => {
  it("resolveProviderIdByName(type:'individual') reuses an import-created individual", () => {
    const drId = individualProvider("Dr. Rivera");
    // The med form picker now passes 'individual', so it dedups onto the existing row.
    expect(resolveProviderIdByName("Dr. Rivera", "individual")).toBe(drId);
    // resolveExactPrescriberId finds the INDIVIDUAL and ignores a same-named org
    // entirely (semantics decision (a): an org never occupies the prescriber link).
    orgProvider("Dr. Rivera");
    expect(resolveExactPrescriberId("Dr. Rivera")).toBe(drId);
  });
});

describe("#1051 provider merge re-keys the prescriber FK; text stays fallback", () => {
  it("moves intake_items.provider_id from the absorbed row to the survivor", () => {
    const keep = individualProvider("Dr. Rivera");
    const dup = individualProvider("Doctor Rivera");
    const medId = insertMed(profileId, {
      prescriber: "Doctor Rivera",
      provider_id: dup,
    });
    mergeProviders(keep, dup);
    const med = db
      .prepare(`SELECT provider_id, prescriber FROM intake_items WHERE id = ?`)
      .get(medId) as { provider_id: number | null; prescriber: string | null };
    expect(med.provider_id).toBe(keep);
    // The free-text prescriber is untouched (fallback only).
    expect(med.prescriber).toBe("Doctor Rivera");
  });
});

describe("#1204 manual track-from-record attaches a course on a match", () => {
  it("adds a course to the existing med instead of a duplicate item", () => {
    const doc = newDocument(profileId);
    // Track a first prescription → a new med.
    const rec1 = Number(
      db
        .prepare(
          `INSERT INTO medical_records (date, category, name, document_id, source, profile_id)
           VALUES (?, 'prescription', 'Amoxicillin', ?, 'Clinic', ?)`
        )
        .run(DATE, doc, profileId).lastInsertRowid
    );
    const first = createMedicationFromRecord(profileId, rec1);
    expect(first).not.toBeNull();

    // A second prescription of the SAME drug (a later document) tracked by hand →
    // attaches a COURSE to the existing med, not a duplicate item.
    const doc2 = newDocument(profileId);
    const rec2 = Number(
      db
        .prepare(
          `INSERT INTO medical_records (date, category, name, document_id, source, profile_id)
           VALUES (?, 'prescription', 'Amoxicillin 500 mg', ?, 'Clinic', ?)`
        )
        .run("2026-06-01", doc2, profileId).lastInsertRowid
    );
    const second = createMedicationFromRecord(profileId, rec2);
    expect(second!.id).toBe(first!.id); // SAME item, not a duplicate

    const items = db
      .prepare(
        `SELECT COUNT(*) AS n FROM intake_items
          WHERE profile_id = ? AND kind = 'medication' AND lower(name) = 'amoxicillin'`
      )
      .get(profileId) as { n: number };
    expect(items.n).toBe(1);
    const courses = db
      .prepare(
        `SELECT COUNT(*) AS n FROM medication_courses WHERE item_id = ?`
      )
      .get(first!.id) as { n: number };
    expect(courses.n).toBe(2); // the initial course + the renewal course
  });
});

describe("#1051 prescriber suggest-and-accept surfacing", () => {
  it("surfaces a near-miss suggestion and accept links + remembers", () => {
    const dr = individualProvider("Sarah Chen, MD");
    const medId = insertMed(profileId, { prescriber: "S. Chen" });
    const suggestions = prescriberSuggestionsForProfile(profileId);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].cls.providerId).toBe(dr);
    expect(linkMedPrescriber(profileId, medId, dr)).toBe(true);
    expect(
      (
        db
          .prepare(`SELECT provider_id FROM intake_items WHERE id = ?`)
          .get(medId) as {
          provider_id: number | null;
        }
      ).provider_id
    ).toBe(dr);
    // Linked → no longer surfaced (provider_id set).
    expect(prescriberSuggestionsForProfile(profileId)).toHaveLength(0);
  });
});
