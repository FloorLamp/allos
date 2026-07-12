// DB INTEGRATION TIER — reprocess-diff.
//
// Proves the PERSISTED-side snapshot reader (getReprocessSnapshot) and the pure
// extraction-side snapshot (snapshotFromPersistInput) line up through the shared
// row builders, and — the key guarantee — that COMMITTING a reprocess
// (persistDocumentImport, the unchanged one-shot writer) leaves the DB in exactly
// the end state the fresh extraction described. So the preview is faithful to what
// confirm will produce.

import { describe, it, expect, beforeAll } from "vitest";
import { getReprocessSnapshot } from "@/lib/queries";
import { persistDocumentImport } from "@/lib/import-persist";
import { snapshotFromPersistInput, computeImportDiff } from "@/lib/import-diff";
import type { PersistInput } from "@/lib/import-shape";
import { db } from "@/lib/db";

const DATE = "2020-05-01";

function makeInput(over: Partial<PersistInput> = {}): PersistInput {
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
        source: "ccda",
        external_id: "obs:glucose",
        loinc: null,
        provider: null,
        courses: null,
      },
      {
        category: "prescription",
        name: "Lisinopril 10 mg",
        canonical: "Lisinopril",
        value: null,
        value_num: null,
        unit: null,
        date: DATE,
        reference_range: null,
        flag: null,
        panel: null,
        notes: "Take one daily",
        source: "ccda",
        external_id: "med:lisinopril",
        loinc: null,
        provider: null,
        courses: null,
      },
    ],
    immunizations: [
      {
        date: DATE,
        vaccine: "influenza",
        dose_label: null,
        notes: null,
        external_id: "imm:flu",
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
        external_id: "alg:pcn",
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
        external_id: "cond:htn",
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
        external_id: "enc:1",
      },
    ],
    procedures: [],
    familyHistory: [],
    carePlanItems: [],
    careGoals: [],
    appointments: [],
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
    ...over,
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

let profileId: number;
let docId: number;

beforeAll(() => {
  profileId = newProfile("DIFF-A");
  docId = newDocument(profileId, "A.ccd");
  persistDocumentImport(profileId, docId, makeInput());
});

describe("getReprocessSnapshot vs snapshotFromPersistInput", () => {
  it("the persisted snapshot equals the fresh extraction's snapshot after an import", () => {
    const current = getReprocessSnapshot(profileId, docId);
    const next = snapshotFromPersistInput(makeInput());
    const diff = computeImportDiff(current, next);
    expect(diff.hasChanges).toBe(false);
    // Every tracked kind produced exactly one unchanged row (records has 2).
    expect(diff.totals.unchanged).toBe(current.records.length + 8);
  });

  it("is profile-scoped: another profile sees an empty snapshot for this doc", () => {
    const other = newProfile("DIFF-B");
    const snap = getReprocessSnapshot(other, docId);
    expect(snap.records).toEqual([]);
    expect(snap.immunizations).toEqual([]);
    expect(snap.bodyMetrics).toEqual([]);
  });
});

describe("reprocess-diff preview then commit", () => {
  it("previews add/remove/change, and committing reaches exactly the fresh state", () => {
    // A reprocess result that: changes Glucose's value, drops the immunization,
    // adds an HDL lab, and keeps everything else.
    const reprocessed = makeInput({
      records: [
        {
          category: "lab",
          name: "Glucose",
          canonical: "Glucose",
          value: "110",
          value_num: 110,
          unit: "mg/dL",
          date: DATE,
          reference_range: null,
          flag: "high",
          panel: "Metabolic",
          notes: null,
          source: "ccda",
          external_id: "obs:glucose",
          loinc: null,
          provider: null,
          courses: null,
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
          source: "ccda",
          external_id: "obs:hdl",
          loinc: null,
          provider: null,
          courses: null,
        },
        {
          category: "prescription",
          name: "Lisinopril 10 mg",
          canonical: "Lisinopril",
          value: null,
          value_num: null,
          unit: null,
          date: DATE,
          reference_range: null,
          flag: null,
          panel: null,
          notes: "Take one daily",
          source: "ccda",
          external_id: "med:lisinopril",
          loinc: null,
          provider: null,
          courses: null,
        },
      ],
      immunizations: [],
    });

    // Preview (no writes): diff persisted vs the fresh extraction.
    const before = getReprocessSnapshot(profileId, docId);
    const next = snapshotFromPersistInput(reprocessed);
    const diff = computeImportDiff(before, next);
    const recs = diff.entities.find((e) => e.entity === "records")!;
    expect(recs.added.map((r) => r.key)).toContain("ext:obs:hdl");
    expect(recs.changed.map((c) => c.after.key)).toContain("ext:obs:glucose");
    const imms = diff.entities.find((e) => e.entity === "immunizations")!;
    expect(imms.removed).toHaveLength(1);
    // The preview did NOT mutate the DB — persisted snapshot is unchanged.
    expect(
      computeImportDiff(getReprocessSnapshot(profileId, docId), before)
        .hasChanges
    ).toBe(false);

    // Commit (the unchanged one-shot writer) and assert the DB now equals `next`.
    persistDocumentImport(profileId, docId, reprocessed);
    const after = getReprocessSnapshot(profileId, docId);
    expect(computeImportDiff(after, next).hasChanges).toBe(false);
  });
});
