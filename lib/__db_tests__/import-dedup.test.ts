// DB INTEGRATION TIER — cross-source read-layer de-duplication (import assessment
// P1-1). Storage stays per-document (lib/import-persist scopes external_id with the
// document source, so each document keeps its own physical row and a per-document
// delete never orphans another document's reading). These tests prove the READ
// layer (lib/queries/medical) collapses identical readings across separately
// uploaded documents — and against a manual entry — to ONE representative in lists,
// series, and counts, while keeping genuinely differing values BOTH visible, and
// prove the collapse survives correct per-document delete semantics.
//
// Runs against a throwaway DB redirected by lib/__db_tests__/setup.ts.

import { describe, it, expect, beforeEach } from "vitest";
import {
  getMedicalRecords,
  getBiomarkerSeries,
  getImmunizations,
  getEncounters,
  getEncounter,
  findRecordsByContentIdentity,
} from "@/lib/queries";
import { getTimelineEvents } from "@/lib/timeline";
import {
  persistDocumentImport,
  clearImportedDocumentRows,
} from "@/lib/import-persist";
import type { PersistInput, PersistRecord } from "@/lib/import-shape";
import { db } from "@/lib/db";

const DATE = "2021-03-01";

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

// A minimal document carrying a single Glucose lab, one MMR immunization, and one
// office-visit encounter — all with a fixed raw external_id, so re-importing the
// SAME id into two different documents exercises the cross-document duplicate the
// per-document source-scoping otherwise leaves as two physical rows.
function glucoseInput(overrides?: {
  value?: string;
  value_num?: number;
}): PersistInput {
  const rec: PersistRecord = {
    category: "lab",
    name: "Glucose",
    canonical: "Glucose",
    value: overrides?.value ?? "95",
    value_num: overrides?.value_num ?? 95,
    unit: "mg/dL",
    date: DATE,
    reference_range: null,
    flag: null,
    panel: "Metabolic",
    notes: null,
    source: "ccd",
    external_id: "obs:glucose",
    loinc: null,
    provider: null,
  };
  return {
    records: [rec],
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
    allergies: [],
    conditions: [],
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
      patientName: "Dedup Patient",
      raw: null,
      model: null,
      importReport: null,
    },
    canonicalNamesToRegister: ["Glucose"],
    providers: [],
  };
}

function glucoseRows(profileId: number) {
  return getMedicalRecords(profileId, { category: "lab" }).filter(
    (r) => r.name === "Glucose"
  );
}

describe("cross-source read-layer de-duplication", () => {
  let profileId: number;

  beforeEach(() => {
    profileId = newProfile(`DEDUP-${Math.random().toString(36).slice(2)}`);
  });

  it("collapses an identical lab reading imported from two documents to one", () => {
    const docA = newDocument(profileId, "A.ccd");
    const docB = newDocument(profileId, "B.ccd");
    persistDocumentImport(profileId, docA, glucoseInput());
    persistDocumentImport(profileId, docB, glucoseInput());

    // Two physical rows (per-document storage preserved)…
    const physical = db
      .prepare(
        "SELECT COUNT(*) AS n FROM medical_records WHERE profile_id = ? AND name = 'Glucose'"
      )
      .get(profileId) as { n: number };
    expect(physical.n).toBe(2);

    // …but the read layer shows exactly one, in the list AND the series.
    expect(glucoseRows(profileId)).toHaveLength(1);
    expect(getBiomarkerSeries(profileId, "Glucose")).toHaveLength(1);
    // The single representative is flagged as the current reading.
    expect((glucoseRows(profileId)[0] as { is_latest: number }).is_latest).toBe(
      1
    );
  });

  it("collapses a manual reading and its imported twin, preferring the manual row", () => {
    // Manual entry: no document_id, no external_id.
    const manualId = Number(
      db
        .prepare(
          `INSERT INTO medical_records
             (profile_id, date, category, name, value, unit, canonical_name, value_num, panel)
           VALUES (?, ?, 'lab', 'Glucose', '95', 'mg/dL', 'Glucose', 95, 'Metabolic')`
        )
        .run(profileId, DATE).lastInsertRowid
    );
    const doc = newDocument(profileId, "twin.ccd");
    persistDocumentImport(profileId, doc, glucoseInput());

    const rows = glucoseRows(profileId);
    expect(rows).toHaveLength(1);
    // Representative rule: the MANUAL row wins over the imported twin.
    expect(rows[0].id).toBe(manualId);
    expect(rows[0].document_id).toBeNull();
  });

  it("keeps a genuinely differing value for the same date+analyte visible (not merged)", () => {
    // Manual Glucose 95 vs imported Glucose 99 on the same date — a real conflict.
    db.prepare(
      `INSERT INTO medical_records
         (profile_id, date, category, name, value, unit, canonical_name, value_num, panel)
       VALUES (?, ?, 'lab', 'Glucose', '95', 'mg/dL', 'Glucose', 95, 'Metabolic')`
    ).run(profileId, DATE);
    const doc = newDocument(profileId, "conflict.ccd");
    persistDocumentImport(
      profileId,
      doc,
      glucoseInput({ value: "99", value_num: 99 })
    );

    // Both remain visible in the list and the series.
    expect(glucoseRows(profileId)).toHaveLength(2);
    expect(getBiomarkerSeries(profileId, "Glucose")).toHaveLength(2);
  });

  it("preserves per-document delete semantics for the collapsed reading", () => {
    const docA = newDocument(profileId, "A.ccd");
    const docB = newDocument(profileId, "B.ccd");
    persistDocumentImport(profileId, docA, glucoseInput());
    persistDocumentImport(profileId, docB, glucoseInput());
    expect(glucoseRows(profileId)).toHaveLength(1);

    // Delete document A (its per-document footprint). The reading document B also
    // contributed must still show — the collapse fell back to B's physical row.
    clearImportedDocumentRows(profileId, docA);
    expect(glucoseRows(profileId)).toHaveLength(1);
    expect(getBiomarkerSeries(profileId, "Glucose")).toHaveLength(1);

    // Delete the ONLY remaining contributor → the reading is gone entirely.
    clearImportedDocumentRows(profileId, docB);
    expect(glucoseRows(profileId)).toHaveLength(0);
    expect(getBiomarkerSeries(profileId, "Glucose")).toHaveLength(0);
  });

  it("stays idempotent on re-import of the same document (no growth)", () => {
    const doc = newDocument(profileId, "reimport.ccd");
    persistDocumentImport(profileId, doc, glucoseInput());
    persistDocumentImport(profileId, doc, glucoseInput()); // reprocess

    // One physical row (per-document external_id dedup) and one shown.
    const physical = db
      .prepare(
        "SELECT COUNT(*) AS n FROM medical_records WHERE profile_id = ? AND name = 'Glucose'"
      )
      .get(profileId) as { n: number };
    expect(physical.n).toBe(1);
    expect(glucoseRows(profileId)).toHaveLength(1);
  });

  it("de-dups the same immunization dose imported from two documents", () => {
    const docA = newDocument(profileId, "A.ccd");
    const docB = newDocument(profileId, "B.ccd");
    persistDocumentImport(profileId, docA, glucoseInput());
    persistDocumentImport(profileId, docB, glucoseInput());

    const mmr = getImmunizations(profileId).filter((i) => i.vaccine === "mmr");
    expect(mmr).toHaveLength(1);
    // Delete one contributor → still shown via the other's physical row.
    clearImportedDocumentRows(profileId, docA);
    expect(
      getImmunizations(profileId).filter((i) => i.vaccine === "mmr")
    ).toHaveLength(1);
  });

  it("prefers a manual immunization dose over an imported twin", () => {
    // Manual dose: source NULL.
    const manualId = Number(
      db
        .prepare(
          `INSERT INTO immunizations (profile_id, date, vaccine, dose_label, source)
           VALUES (?, ?, 'mmr', '1', NULL)`
        )
        .run(profileId, DATE).lastInsertRowid
    );
    const doc = newDocument(profileId, "imm-twin.ccd");
    persistDocumentImport(profileId, doc, glucoseInput());

    const mmr = getImmunizations(profileId).filter((i) => i.vaccine === "mmr");
    expect(mmr).toHaveLength(1);
    expect(mmr[0].id).toBe(manualId);
  });

  it("de-dups the same encounter imported from two documents", () => {
    const docA = newDocument(profileId, "A.ccd");
    const docB = newDocument(profileId, "B.ccd");
    persistDocumentImport(profileId, docA, glucoseInput());
    persistDocumentImport(profileId, docB, glucoseInput());

    expect(getEncounters(profileId)).toHaveLength(1);
    clearImportedDocumentRows(profileId, docA);
    expect(getEncounters(profileId)).toHaveLength(1);
  });

  it("de-dups the same encounter on the TIMELINE (the user-visible bug)", () => {
    // Two overlapping CCDs each carry the same visit → two physical rows (storage
    // stays per-document so a delete never orphans the other doc's copy)…
    const docA = newDocument(profileId, "A.ccd");
    const docB = newDocument(profileId, "B.ccd");
    persistDocumentImport(profileId, docA, glucoseInput());
    persistDocumentImport(profileId, docB, glucoseInput());
    const physical = db
      .prepare("SELECT COUNT(*) AS n FROM encounters WHERE profile_id = ?")
      .get(profileId) as { n: number };
    expect(physical.n).toBe(2);

    // …but the timeline shows the visit exactly ONCE (the bug was that it didn't),
    // deep-linked to its detail page — the same collapse the Visits list applies.
    const visits = getTimelineEvents(profileId).filter(
      (e) => e.category === "visit"
    );
    expect(visits).toHaveLength(1);
    expect(visits[0].href).toMatch(/^\/encounters\/\d+$/);

    // Deleting one contributor keeps the visit visible via the survivor.
    clearImportedDocumentRows(profileId, docA);
    expect(
      getTimelineEvents(profileId).filter((e) => e.category === "visit")
    ).toHaveLength(1);
  });

  it("persists the encounter's imported notes and reads them back by id (scoped)", () => {
    const doc = newDocument(profileId, "notes.ccd");
    const input = glucoseInput();
    input.encounters = [
      {
        ...input.encounters[0],
        notes: "Patient advised to rest and hydrate.",
        external_id: "encounter:notes",
      },
    ];
    persistDocumentImport(profileId, doc, input);

    const [enc] = getEncounters(profileId);
    expect(enc.notes).toBe("Patient advised to rest and hydrate.");

    // getEncounter is scoped on BOTH id AND profile_id.
    expect(getEncounter(profileId, enc.id)?.notes).toBe(
      "Patient advised to rest and hydrate."
    );
    const other = newProfile("DEDUP-SCOPE");
    expect(getEncounter(other, enc.id)).toBeNull();
  });

  it("findRecordsByContentIdentity returns all physical rows behind a content-identity, profile-scoped", () => {
    const docA = newDocument(profileId, "A.ccd");
    const docB = newDocument(profileId, "B.ccd");
    persistDocumentImport(profileId, docA, glucoseInput());
    persistDocumentImport(profileId, docB, glucoseInput());

    const matches = findRecordsByContentIdentity(profileId, {
      nameKey: "Glucose",
      date: DATE,
      value: "95",
      value_num: 95,
      unit: "mg/dL",
    });
    // Both physical rows are behind the single representative.
    expect(matches).toHaveLength(2);

    // A differing value is NOT part of this identity.
    expect(
      findRecordsByContentIdentity(profileId, {
        nameKey: "Glucose",
        date: DATE,
        value: "99",
        value_num: 99,
        unit: "mg/dL",
      })
    ).toHaveLength(0);

    // Another profile with the same reading is never returned.
    const other = newProfile("DEDUP-OTHER");
    const otherDoc = newDocument(other, "O.ccd");
    persistDocumentImport(other, otherDoc, glucoseInput());
    expect(
      findRecordsByContentIdentity(profileId, {
        nameKey: "Glucose",
        date: DATE,
        value: "95",
        value_num: 95,
        unit: "mg/dL",
      })
    ).toHaveLength(2); // still only this profile's two rows
  });
});
