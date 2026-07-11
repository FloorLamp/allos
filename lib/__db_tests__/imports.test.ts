// DB INTEGRATION TIER — import-log + produced-breakdown query tests.
//
// Proves the new lib/queries/imports.ts reads (a) list a profile's own documents
// AND paste/CSV jobs interleaved, with NO cross-profile bleed, and (b) count what
// a single document import produced, traced through the exact provenance links the
// writer (lib/import-persist.ts) stamps — again strictly per profile. Runs against
// a throwaway DB redirected by lib/__db_tests__/setup.ts.

import { describe, it, expect, beforeAll } from "vitest";
import {
  getImportLog,
  getImportLogDocuments,
  getImportLogJobs,
  getDocumentProduced,
  getMedicalDocument,
  getDocumentVisits,
  getDocumentConditions,
  getDocumentAllergies,
  getDocumentImmunizations,
  getDocumentProcedures,
  getDocumentFamilyHistory,
  getDocumentCarePlanItems,
  getDocumentCareGoals,
  getDocumentMedications,
  getDocumentBodyRows,
} from "@/lib/queries";
import {
  persistDocumentImport,
  countImportedDocumentRows,
} from "@/lib/import-persist";
import { producedTotal } from "@/lib/import-log";
import type { PersistInput } from "@/lib/import-shape";
import { db } from "@/lib/db";

const DATE = "2020-05-01";

// A cross-domain document: at least one row for (almost) every table an import
// writes, so the produced-breakdown counts have something to find in each kind.
function makeInput(): PersistInput {
  return {
    records: [
      {
        category: "lab",
        name: "Glucose",
        canonical: "Glucose",
        value: "95",
        value_num: 95,
        unit: "mg/dL",
        date: DATE,
        reference_range: null,
        flag: null,
        panel: "Metabolic",
        notes: null,
        source: null,
        external_id: "obs:glucose",
        loinc: null,
        provider: null,
      },
      {
        category: "lab",
        name: "HDL",
        canonical: "HDL Cholesterol",
        value: "55",
        value_num: 55,
        unit: "mg/dL",
        date: DATE,
        reference_range: null,
        flag: null,
        panel: "Lipids",
        notes: null,
        source: null,
        external_id: "obs:hdl",
        loinc: null,
        provider: null,
      },
      {
        category: "prescription",
        name: "Lisinopril 10 mg",
        canonical: "Lisinopril 10 mg",
        value: null,
        value_num: null,
        unit: null,
        date: DATE,
        reference_range: null,
        flag: null,
        panel: null,
        notes: "Take 1 tablet by mouth daily",
        source: null,
        external_id: "med:rx",
        loinc: null,
        provider: null,
      },
    ],
    immunizations: [
      {
        date: DATE,
        vaccine: "mmr",
        dose_label: "1",
        notes: null,
        external_id: "imm:mmr",
        provider: null,
      },
    ],
    allergies: [
      {
        substance: "Penicillin",
        substance_code: null,
        substance_code_system: null,
        reaction: "Hives",
        severity: "moderate",
        status: "active",
        onset_date: null,
        external_id: "allergy:penicillin",
      },
    ],
    conditions: [
      {
        name: "Hypertension",
        code: "I10",
        code_system: "ICD-10",
        status: "active",
        onset_date: null,
        resolved_date: null,
        external_id: "condition:htn",
      },
    ],
    encounters: [
      {
        date: DATE,
        end_date: null,
        type: "Office Visit",
        class_code: "AMB",
        reason: "Annual physical",
        diagnoses: ["Hypertension"],
        provider: null,
        location: null,
        notes: null,
        external_id: "encounter:1",
      },
    ],
    procedures: [
      {
        name: "Appendectomy",
        code: "44970",
        code_system: "CPT",
        date: DATE,
        provider: null,
        external_id: "ccda:procedure:44970",
      },
    ],
    familyHistory: [
      {
        relation: "Father",
        condition: "Type 2 diabetes",
        code: "44054006",
        code_system: "SNOMED CT",
        onset_age: 55,
        deceased: 0,
        external_id: "ccda:famhx:father:44054006",
      },
    ],
    carePlanItems: [
      {
        description: "Follow-up lipid panel",
        code: "57698-3",
        code_system: "LOINC",
        category: "observation",
        planned_date: "2020-06-15",
        status: "planned",
        provider: null,
        external_id: "ccda:careplan:57698-3",
      },
    ],
    careGoals: [
      {
        description: "HbA1c below 6.5%",
        code: "4548-4",
        code_system: "LOINC",
        target_date: "2020-09-01",
        status: "active",
        external_id: "ccda:caregoal:4548-4",
      },
    ],
    bodyMetrics: [
      { date: DATE, weight_kg: 82, body_fat_pct: null, resting_hr: null },
    ],
    heights: [{ date: DATE, height_cm: 178 }],
    headCircs: [{ date: DATE, head_circumference_cm: 47 }],
    demographics: null,
    meta: {
      docType: "ccd",
      source: "ccd",
      documentDate: DATE,
      patientName: "Test Patient",
      raw: null,
      model: null,
      importReport: null,
    },
    canonicalNamesToRegister: [],
    providers: [],
  };
}

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

function newDocument(profileId: number, filename: string): number {
  return Number(
    db
      .prepare(
        `INSERT INTO medical_documents
           (profile_id, filename, stored_path, extraction_status, doc_type)
         VALUES (?, ?, '', 'processing', 'ccd')`
      )
      .run(profileId, filename).lastInsertRowid
  );
}

let profileA: number;
let profileB: number;
let docA: number;
let docB: number;
let jobA: number;

beforeAll(() => {
  profileA = newProfile("IMPORT-A");
  profileB = newProfile("IMPORT-B");
  docA = newDocument(profileA, "A-labs.pdf");
  docB = newDocument(profileB, "B-labs.pdf");
  persistDocumentImport(profileA, docA, makeInput());
  persistDocumentImport(profileB, docB, makeInput());
  // A paste/CSV job for profile A only.
  jobA = Number(
    db
      .prepare(
        `INSERT INTO import_jobs (profile_id, type, status, summary)
         VALUES (?, 'workouts', 'ready', '2 workouts · 8 sets')`
      )
      .run(profileA).lastInsertRowid
  );
  // A provider stamped onto one of A's document records, so the DISTINCT
  // provider_id count has exactly one to find.
  const providerId = Number(
    db
      .prepare(
        `INSERT INTO providers (name, type, dedup_key) VALUES ('Quest', 'organization', 'quest')`
      )
      .run().lastInsertRowid
  );
  db.prepare(
    "UPDATE medical_records SET provider_id = ? WHERE document_id = ? AND profile_id = ? AND name = 'Glucose'"
  ).run(providerId, docA, profileA);
});

describe("getImportLog / getImportLogDocuments / getImportLogJobs", () => {
  it("lists profile A's document AND paste job, interleaved", () => {
    const log = getImportLog(profileA);
    const docs = log.filter((r) => r.kind === "document");
    const jobs = log.filter((r) => r.kind === "job");
    expect(docs.map((d) => d.id)).toContain(docA);
    expect(jobs.map((j) => j.id)).toContain(jobA);
    // The document row carries its finalized status + patient name for the log.
    const dRow = getImportLogDocuments(profileA).find((d) => d.id === docA)!;
    expect(dRow.extraction_status).toBe("done");
    expect(dRow.patient_name).toBe("Test Patient");
    const jRow = getImportLogJobs(profileA).find((j) => j.id === jobA)!;
    expect(jRow.status).toBe("ready");
    expect(jRow.type).toBe("workouts");
  });

  it("does not bleed profile A's rows into profile B's log (and vice versa)", () => {
    const logB = getImportLog(profileB);
    expect(logB.some((r) => r.kind === "document" && r.id === docA)).toBe(
      false
    );
    expect(logB.some((r) => r.kind === "job" && r.id === jobA)).toBe(false);
    // B has its own document, no jobs.
    expect(logB.filter((r) => r.kind === "document").map((r) => r.id)).toEqual([
      docB,
    ]);
    expect(logB.filter((r) => r.kind === "job")).toHaveLength(0);
    // A never sees B's document.
    expect(
      getImportLog(profileA).some((r) => r.kind === "document" && r.id === docB)
    ).toBe(false);
  });
});

describe("getDocumentProduced", () => {
  it("counts every kind the import produced, per category", () => {
    const p = getDocumentProduced(profileA, docA);
    const byCat = Object.fromEntries(
      p.recordsByCategory.map((r) => [r.category, r.count])
    );
    expect(byCat["lab"]).toBe(2);
    expect(byCat["prescription"]).toBe(1);
    expect(p.immunizations).toBe(1);
    expect(p.allergies).toBe(1);
    expect(p.conditions).toBe(1);
    expect(p.encounters).toBe(1);
    expect(p.procedures).toBe(1);
    expect(p.familyHistory).toBe(1);
    expect(p.carePlanItems).toBe(1);
    expect(p.careGoals).toBe(1);
    // The prescription record was projected into a structured medication row.
    expect(p.medications).toBe(1);
    expect(p.bodyMetrics).toBe(1);
    expect(p.heightSamples).toBe(1);
    expect(p.headCircSamples).toBe(1);
    // One distinct provider referenced by this document's rows.
    expect(p.providers).toBe(1);
  });

  it("agrees with extracted_count: the tab counts and the toast tally share one total (#271/#212)", () => {
    // producedTotal over getDocumentProduced (what the tab strip shows) must
    // equal BOTH the live footprint count and the stored extracted_count for a
    // fixture that writes every footprint table — so the browser can never
    // count differently from the toast/Review feed.
    const total = producedTotal(getDocumentProduced(profileA, docA));
    expect(total).toBe(countImportedDocumentRows(profileA, docA));
    const row = db
      .prepare(
        "SELECT extracted_count AS n FROM medical_documents WHERE id = ? AND profile_id = ?"
      )
      .get(docA, profileA) as { n: number };
    expect(total).toBe(row.n);
  });

  it("is profile-scoped: asking A about B's document finds nothing", () => {
    const cross = getDocumentProduced(profileA, docB);
    expect(cross.recordsByCategory).toEqual([]);
    expect(cross.immunizations).toBe(0);
    expect(cross.allergies).toBe(0);
    expect(cross.conditions).toBe(0);
    expect(cross.encounters).toBe(0);
    expect(cross.procedures).toBe(0);
    expect(cross.familyHistory).toBe(0);
    expect(cross.carePlanItems).toBe(0);
    expect(cross.careGoals).toBe(0);
    expect(cross.medications).toBe(0);
    expect(cross.bodyMetrics).toBe(0);
    expect(cross.heightSamples).toBe(0);
    expect(cross.headCircSamples).toBe(0);
    expect(cross.providers).toBe(0);
  });

  it("the detail-page lookup rejects a cross-profile document id", () => {
    // getMedicalDocument backs /import/[id]; profile A must never resolve
    // profile B's document (WHERE id = ? AND profile_id = ?).
    expect(getMedicalDocument(profileA, docB)).toBeUndefined();
    // Sanity: A's own document still resolves for A.
    expect(getMedicalDocument(profileA, docA)?.id).toBe(docA);
  });
});

// #212: extracted_count — the ONE number the toast + Review feed report — must
// total every per-profile row an import writes, not just immunizations + records.
describe("extracted_count (toast + Review-feed tally)", () => {
  it("stores the full footprint total on the document row, not immCount+recCount", () => {
    // The cross-domain makeInput() writes: 3 medical_records (2 lab + 1
    // prescription) + 1 immunization + 1 allergy + 1 condition + 1 encounter +
    // 1 procedure + 1 family-history + 1 care-plan item + 1 care goal + 1
    // structured medication (the prescription projected into intake_items) +
    // 1 body-metric + 1 height + 1 head-circ = 15.
    // The old tally (immCount + recCount = 1 + 3 = 4) missed the rest.
    const row = db
      .prepare(
        "SELECT extracted_count AS n FROM medical_documents WHERE id = ? AND profile_id = ?"
      )
      .get(docA, profileA) as { n: number };
    expect(row.n).toBe(15);
    // And it equals the live footprint count the writer derives off
    // IMPORT_FOOTPRINT_TABLES, so the stored value can't silently drift.
    expect(countImportedDocumentRows(profileA, docA)).toBe(15);
  });

  it("counts an encounter-only import as 1 item (the reported repro)", () => {
    // A CCD carrying a single Visit and nothing else — no labs, no immunizations.
    // The old tally read 0; the fix must report 1.
    const profile = newProfile("ENCOUNTER-ONLY");
    const doc = newDocument(profile, "visit-only.ccd");
    const outcome = persistDocumentImport(profile, doc, {
      records: [],
      immunizations: [],
      allergies: [],
      conditions: [],
      encounters: [
        {
          date: DATE,
          end_date: null,
          type: "Office Visit",
          class_code: "AMB",
          reason: "Annual physical",
          diagnoses: [],
          provider: null,
          location: null,
          notes: null,
          external_id: "encounter:solo",
        },
      ],
      procedures: [],
      familyHistory: [],
      carePlanItems: [],
      careGoals: [],
      bodyMetrics: [],
      heights: [],
      headCircs: [],
      demographics: null,
      meta: {
        docType: "ccd",
        source: "ccd",
        documentDate: DATE,
        patientName: "Test Patient",
        raw: null,
        model: null,
        importReport: null,
      },
      canonicalNamesToRegister: [],
      providers: [],
    });
    expect(outcome.immCount).toBe(0);
    expect(outcome.recCount).toBe(0);
    expect(outcome.extractedCount).toBe(1);
    const row = db
      .prepare(
        "SELECT extracted_count AS n FROM medical_documents WHERE id = ? AND profile_id = ?"
      )
      .get(doc, profile) as { n: number };
    expect(row.n).toBe(1);
  });
});

// #271: the per-tab listing reads behind the import-detail records browser.
// Each must return exactly the document's own rows (traced via the writer's
// provenance link) and NOTHING for a cross-profile document id.
describe("per-tab document listings", () => {
  it("lists each kind the import produced, with its display fields", () => {
    const visits = getDocumentVisits(profileA, docA);
    expect(visits).toHaveLength(1);
    expect(visits[0]).toMatchObject({
      date: DATE,
      type: "Office Visit",
      reason: "Annual physical",
    });
    expect(visits[0].id).toBeGreaterThan(0);

    expect(getDocumentConditions(profileA, docA)).toMatchObject([
      { name: "Hypertension", status: "active", code: "I10" },
    ]);
    expect(getDocumentAllergies(profileA, docA)).toMatchObject([
      { substance: "Penicillin", reaction: "Hives", severity: "moderate" },
    ]);
    expect(getDocumentImmunizations(profileA, docA)).toMatchObject([
      { date: DATE, vaccine: "mmr", dose_label: "1" },
    ]);
    expect(getDocumentProcedures(profileA, docA)).toMatchObject([
      { name: "Appendectomy", code: "44970", date: DATE },
    ]);
    expect(getDocumentFamilyHistory(profileA, docA)).toMatchObject([
      { relation: "Father", condition: "Type 2 diabetes", onset_age: 55 },
    ]);
    expect(getDocumentCarePlanItems(profileA, docA)).toMatchObject([
      { description: "Follow-up lipid panel", planned_date: "2020-06-15" },
    ]);
    expect(getDocumentCareGoals(profileA, docA)).toMatchObject([
      { description: "HbA1c below 6.5%", status: "active" },
    ]);
    // The auto-structured medication row (from the prescription record).
    const meds = getDocumentMedications(profileA, docA);
    expect(meds).toHaveLength(1);
    expect(meds[0].kind).toBe("medication");

    const body = getDocumentBodyRows(profileA, docA);
    expect(body.bodyMetrics).toMatchObject([{ date: DATE, weight_kg: 82 }]);
    expect(body.heights).toMatchObject([{ date: DATE, value: 178 }]);
    expect(body.headCircs).toMatchObject([{ date: DATE, value: 47 }]);
  });

  it("every listing is profile-scoped: A sees nothing of B's document", () => {
    expect(getDocumentVisits(profileA, docB)).toEqual([]);
    expect(getDocumentConditions(profileA, docB)).toEqual([]);
    expect(getDocumentAllergies(profileA, docB)).toEqual([]);
    expect(getDocumentImmunizations(profileA, docB)).toEqual([]);
    expect(getDocumentProcedures(profileA, docB)).toEqual([]);
    expect(getDocumentFamilyHistory(profileA, docB)).toEqual([]);
    expect(getDocumentCarePlanItems(profileA, docB)).toEqual([]);
    expect(getDocumentCareGoals(profileA, docB)).toEqual([]);
    expect(getDocumentMedications(profileA, docB)).toEqual([]);
    const body = getDocumentBodyRows(profileA, docB);
    expect(body.bodyMetrics).toEqual([]);
    expect(body.heights).toEqual([]);
    expect(body.headCircs).toEqual([]);
  });
});
