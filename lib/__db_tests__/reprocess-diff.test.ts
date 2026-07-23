// DB INTEGRATION TIER — reprocess-diff.
//
// Proves the PERSISTED-side snapshot reader (getReprocessSnapshot) and the pure
// extraction-side snapshot (snapshotFromPersistInput) line up through the shared
// row builders, and — the key guarantee — that COMMITTING a reprocess
// (persistDocumentImport, the unchanged one-shot writer) leaves the DB in exactly
// the end state the fresh extraction described. So the preview is faithful to what
// confirm will produce.

import { describe, it, expect, beforeAll } from "vitest";
import {
  getReprocessSnapshot,
  previewReconcileFlags,
  foldConsolidatedMedsIntoSnapshot,
} from "@/lib/queries";
import {
  persistDocumentImport,
  applyImportFollowups,
} from "@/lib/import-persist";
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

// The two preview-phantom classes: a byte-identical reprocess must preview clean.
//
// (1) Derived flags: applyImportFollowups → reconcileFlags writes app-derived
// flags (canonical ranges) onto persisted rows AFTER the persist boundary, while
// the preview's extraction side carries only source-stated flags — so every
// derived flag read as "changed: flag → none". previewReconcileFlags is the
// preview twin that derives the same flags onto the fresh input.
//
// (2) Consolidated medications (#1204): a drug a later document derives that the
// profile already tracks persists as renewal courses on the EXISTING item — no
// intake_items row carries the later document_id — so the later document's
// preview showed it as a phantom "+ added" med. foldConsolidatedMedsIntoSnapshot
// folds tracked matches into the persisted side.
describe("reprocess preview phantoms", () => {
  it("previewReconcileFlags derives the same flag the commit-side reconcile wrote", () => {
    const pid = newProfile("PHANTOM-FLAGS");
    const did = newDocument(pid, "flags.ccd");
    const glucoseHigh = () =>
      makeInput({
        records: [
          {
            category: "lab",
            name: "Glucose",
            canonical: "Glucose",
            value: "200",
            value_num: 200,
            unit: "mg/dL",
            date: DATE,
            reference_range: null,
            flag: null, // the source states no flag — the app derives one
            panel: "Metabolic",
            notes: null,
            source: "ccda",
            external_id: "obs:glucose-hi",
            loinc: null,
            provider: null,
            courses: null,
          },
        ],
        immunizations: [],
        allergies: [],
        conditions: [],
        encounters: [],
        bodyMetrics: [],
        heights: [],
        headCircs: [],
      });
    const persisted = persistDocumentImport(pid, did, glucoseHigh());
    applyImportFollowups(pid, {
      demographics: null,
      canonicalNames: [],
      insertedRecordIds: persisted.insertedRecordIds,
    });
    // Sanity: the follow-up really derived a flag (else this test is vacuous).
    const storedFlag = db
      .prepare(
        "SELECT flag FROM medical_records WHERE profile_id = ? AND name = 'Glucose'"
      )
      .get(pid) as { flag: string | null };
    expect(storedFlag.flag).toBe("high");

    // Without enrichment: the phantom (flag high → none).
    const raw = glucoseHigh();
    expect(
      computeImportDiff(
        getReprocessSnapshot(pid, did),
        snapshotFromPersistInput(raw)
      ).hasChanges
    ).toBe(true);

    // With the preview twin: clean.
    previewReconcileFlags(pid, raw.records);
    expect(raw.records[0].flag).toBe("high");
    expect(
      computeImportDiff(
        getReprocessSnapshot(pid, did),
        snapshotFromPersistInput(raw)
      ).hasChanges
    ).toBe(false);
  });

  it("foldConsolidatedMedsIntoSnapshot keeps a renewal-consolidated med out of 'added'", () => {
    const pid = newProfile("PHANTOM-MEDS");
    const rx = (name: string, ext: string) => ({
      category: "prescription" as const,
      name,
      canonical: name,
      value: null,
      value_num: null,
      unit: null,
      date: DATE,
      reference_range: null,
      flag: null,
      panel: null,
      notes: null,
      source: "ccda",
      external_id: ext,
      loinc: null,
      provider: null,
      courses: null,
    });
    const bare = {
      immunizations: [],
      allergies: [],
      conditions: [],
      encounters: [],
      bodyMetrics: [],
      heights: [],
      headCircs: [],
    };
    const docA = newDocument(pid, "A.ccd");
    persistDocumentImport(
      pid,
      docA,
      makeInput({ ...bare, records: [rx("Ibuprofen 200 mg", "med:ibu-a")] })
    );
    const inputB = () =>
      makeInput({
        ...bare,
        records: [
          rx("Ibuprofen 200 mg", "med:ibu-b"),
          rx("Cetirizine 10 mg", "med:cet-b"),
        ],
      });
    const docB = newDocument(pid, "B.ccd");
    persistDocumentImport(pid, docB, inputB());

    // The renewal consolidated Ibuprofen onto doc A's item — doc B owns only
    // Cetirizine, so the raw preview shows Ibuprofen as a phantom addition.
    const current = getReprocessSnapshot(pid, docB);
    expect(current.medications.map((m) => m.key)).toEqual(["med:cetirizine"]);
    const next = snapshotFromPersistInput(inputB());
    const rawDiff = computeImportDiff(current, next);
    expect(
      rawDiff.entities
        .find((e) => e.entity === "medications")!
        .added.map((m) => m.key)
    ).toEqual(["med:ibuprofen"]);

    // Folded: the tracked match compares unchanged; nothing added or removed.
    foldConsolidatedMedsIntoSnapshot(pid, current, next.medications);
    const folded = computeImportDiff(current, next);
    const meds = folded.entities.find((e) => e.entity === "medications")!;
    expect(meds.added).toEqual([]);
    expect(meds.removed).toEqual([]);
    expect(meds.unchanged.map((m) => m.key).sort()).toEqual([
      "med:cetirizine",
      "med:ibuprofen",
    ]);

    // A derived drug the profile does NOT track still previews as added.
    const withNew = makeInput({
      ...bare,
      records: [
        rx("Ibuprofen 200 mg", "med:ibu-b"),
        rx("Cetirizine 10 mg", "med:cet-b"),
        rx("Amoxicillin 400 mg", "med:amox-b"),
      ],
    });
    const current2 = getReprocessSnapshot(pid, docB);
    const next2 = snapshotFromPersistInput(withNew);
    foldConsolidatedMedsIntoSnapshot(pid, current2, next2.medications);
    const diff2 = computeImportDiff(current2, next2);
    expect(
      diff2.entities
        .find((e) => e.entity === "medications")!
        .added.map((m) => m.key)
    ).toEqual(["med:amoxicillin"]);
  });
});
