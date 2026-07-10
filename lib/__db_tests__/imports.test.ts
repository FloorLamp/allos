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
} from "@/lib/queries";
import { persistDocumentImport } from "@/lib/import-persist";
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
    carePlanItems: [],
    careGoals: [],
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
    // The prescription record was projected into a structured medication row.
    expect(p.medications).toBe(1);
    expect(p.bodyMetrics).toBe(1);
    expect(p.heightSamples).toBe(1);
    expect(p.headCircSamples).toBe(1);
    // One distinct provider referenced by this document's rows.
    expect(p.providers).toBe(1);
  });

  it("is profile-scoped: asking A about B's document finds nothing", () => {
    const cross = getDocumentProduced(profileA, docB);
    expect(cross.recordsByCategory).toEqual([]);
    expect(cross.immunizations).toBe(0);
    expect(cross.allergies).toBe(0);
    expect(cross.conditions).toBe(0);
    expect(cross.encounters).toBe(0);
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
