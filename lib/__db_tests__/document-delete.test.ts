// DB INTEGRATION TIER (npm run test:db). Guards the per-document deletion
// footprint — the bug where deleteMedicalDocument (app/(app)/medical/actions.ts)
// and the reprocess delete-set (lib/import-persist) had drifted, so #182/#183/#196's
// head-circumference samples, allergies, conditions, and encounters were cleared on
// reprocess but ORPHANED on document delete.
//
// Both paths now funnel through the shared clearImportedDocumentRows helper. These
// tests import a cross-domain document (records, an extracted medication,
// body-metrics, height + head-circumference samples, an immunization, an allergy,
// two conditions incl. a social-smoking status, and an encounter), then:
//   1. assert every one of those kinds is present after import,
//   2. run the shared delete helper (the core of deleteMedicalDocument) and assert
//      ALL of them are gone — no orphans left for the profile,
//   3. assert a second profile's identical document is untouched (profile scoping),
//   4. assert reprocess (re-running persistDocumentImport) is still idempotent —
//      the shared helper didn't change reprocess behavior,
//   5. (Finding A) assert the delete never OVER-deletes within the same profile —
//      a manual/integration/other-document row keyed differently must survive,
//   6. (Finding B) drive the real deleteMedicalDocument to prove the FK-ordering
//      invariant (extracted meds dropped before the medical_documents row) and the
//      starred-biomarker cleanup hold end to end.

import { beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  persistDocumentImport,
  clearImportedDocumentRows,
} from "@/lib/import-persist";
import { documentSource } from "@/lib/body-metric-extract";
import type { PersistInput } from "@/lib/import-shape";
import { deleteMedicalDocument } from "@/app/(app)/medical/actions";
import { seedActor, fd } from "@/lib/__action_tests__/harness";

const DATE = "2020-05-01";

interface InputOpts {
  /** Date all this document's readings carry. A second same-profile document
   *  uses a DIFFERENT date so its body-metric / height / head-circ rows aren't
   *  deferred to the first document's same-date rows. */
  date?: string;
  /** Include a social-history smoking-status condition (default true). Off for a
   *  second same-profile document so it never triggers the cross-document smoking
   *  supersession against the first document's status. */
  smoking?: boolean;
  /** Prescription name → its structured medication. A second same-profile
   *  document uses a DIFFERENT name so its med isn't deduped against the first's
   *  already-present med. */
  medName?: string;
}

// A cross-domain document: at least one row for every table an import writes.
function makeInput(opts: InputOpts = {}): PersistInput {
  const date = opts.date ?? DATE;
  const smoking = opts.smoking ?? true;
  const medName = opts.medName ?? "Lisinopril 10 mg";
  const conditions: PersistInput["conditions"] = [
    {
      name: "Hypertension",
      code: "I10",
      code_system: "ICD-10",
      status: "active",
      onset_date: null,
      resolved_date: null,
      external_id: "ccda:condition:hypertension",
    },
  ];
  if (smoking) {
    // A social-history smoking status — its external_id lives in the
    // ccda:social-smoking namespace. It carries the document_id like any other
    // condition, so the shared conditions delete removes it on document delete.
    conditions.push({
      name: "Former smoker",
      code: "8517006",
      code_system: "SNOMED",
      status: "active",
      onset_date: null,
      resolved_date: null,
      external_id: "ccda:social-smoking:8517006",
    });
  }
  return {
    records: [
      {
        category: "lab",
        name: "Glucose",
        canonical: "Glucose",
        value: "95",
        value_num: 95,
        unit: "mg/dL",
        date,
        reference_range: null,
        flag: null,
        panel: "Metabolic",
        notes: null,
        source: null,
        external_id: "ccda:obs:glucose",
        loinc: null,
        provider: null,
      },
      // A prescription record → projected into a structured kind='medication'
      // intake_items row (source='extracted'), so the extracted-meds delete is
      // exercised too.
      {
        category: "prescription",
        name: medName,
        canonical: medName,
        value: null,
        value_num: null,
        unit: null,
        date,
        reference_range: null,
        flag: null,
        panel: null,
        notes: "Take 1 tablet by mouth daily",
        source: null,
        external_id: "ccda:med:rx",
        loinc: null,
        provider: null,
      },
    ],
    immunizations: [
      {
        date,
        vaccine: "mmr",
        dose_label: "1",
        notes: null,
        external_id: "ccda:imm:mmr",
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
        external_id: "ccda:allergy:penicillin",
      },
    ],
    conditions,
    encounters: [
      {
        date,
        end_date: null,
        type: "Office Visit",
        class_code: "AMB",
        reason: "Annual physical",
        diagnoses: ["Hypertension"],
        provider: null,
        location: null,
        notes: null,
        external_id: "ccda:encounter:1",
      },
    ],
    procedures: [],
    familyHistory: [],
    carePlanItems: [],
    careGoals: [],
    bodyMetrics: [
      { date, weight_kg: 82, body_fat_pct: null, resting_hr: null },
    ],
    heights: [{ date, height_cm: 178 }],
    headCircs: [{ date, head_circumference_cm: 47 }],
    demographics: null,
    meta: {
      docType: "ccd",
      source: "ccd",
      documentDate: date,
      patientName: null,
      raw: null,
      model: null,
      importReport: null,
    },
    canonicalNamesToRegister: [],
    providers: [],
  };
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

// Every table + key the shared helper clears, so a test can assert the full
// footprint in one place. Source-keyed tables use documentSource(docId).
function footprintCounts(profileId: number, docId: number) {
  const src = documentSource(docId);
  const one = (sql: string, ...params: unknown[]) =>
    (db.prepare(sql).get(...params) as { n: number }).n;
  return {
    records: one(
      "SELECT COUNT(*) n FROM medical_records WHERE document_id = ? AND profile_id = ?",
      docId,
      profileId
    ),
    meds: one(
      "SELECT COUNT(*) n FROM intake_items WHERE document_id = ? AND profile_id = ? AND source = 'extracted'",
      docId,
      profileId
    ),
    bodyMetrics: one(
      "SELECT COUNT(*) n FROM body_metrics WHERE source = ? AND profile_id = ?",
      src,
      profileId
    ),
    heights: one(
      "SELECT COUNT(*) n FROM metric_samples WHERE source = ? AND metric = 'height_cm' AND profile_id = ?",
      src,
      profileId
    ),
    headCircs: one(
      "SELECT COUNT(*) n FROM metric_samples WHERE source = ? AND metric = 'head_circumference_cm' AND profile_id = ?",
      src,
      profileId
    ),
    immunizations: one(
      "SELECT COUNT(*) n FROM immunizations WHERE source = ? AND profile_id = ?",
      src,
      profileId
    ),
    allergies: one(
      "SELECT COUNT(*) n FROM allergies WHERE document_id = ? AND profile_id = ?",
      docId,
      profileId
    ),
    conditions: one(
      "SELECT COUNT(*) n FROM conditions WHERE document_id = ? AND profile_id = ?",
      docId,
      profileId
    ),
    encounters: one(
      "SELECT COUNT(*) n FROM encounters WHERE document_id = ? AND profile_id = ?",
      docId,
      profileId
    ),
  };
}

// Sum every profile-owned import table for a profile, regardless of key — proves
// NOTHING is orphaned (a row keyed on document_id/source that the footprint query
// wouldn't catch if the key ever drifted).
function totalRowsForProfile(profileId: number) {
  const one = (table: string) =>
    (
      db
        .prepare(`SELECT COUNT(*) n FROM ${table} WHERE profile_id = ?`)
        .get(profileId) as { n: number }
    ).n;
  return {
    records: one("medical_records"),
    meds: (
      db
        .prepare(
          "SELECT COUNT(*) n FROM intake_items WHERE profile_id = ? AND source = 'extracted'"
        )
        .get(profileId) as { n: number }
    ).n,
    bodyMetrics: one("body_metrics"),
    metricSamples: one("metric_samples"),
    immunizations: one("immunizations"),
    allergies: one("allergies"),
    conditions: one("conditions"),
    encounters: one("encounters"),
  };
}

let profileA: number;
let profileB: number;
let docA: number;
let docB: number;

beforeAll(() => {
  profileA = Number(
    db.prepare("INSERT INTO profiles (name) VALUES ('A')").run().lastInsertRowid
  );
  profileB = Number(
    db.prepare("INSERT INTO profiles (name) VALUES ('B')").run().lastInsertRowid
  );
  docA = newDocument(profileA, "a.ccd");
  docB = newDocument(profileB, "b.ccd");
  persistDocumentImport(profileA, docA, makeInput());
  persistDocumentImport(profileB, docB, makeInput());
});

describe("document import footprint", () => {
  it("writes a row for every imported kind", () => {
    const c = footprintCounts(profileA, docA);
    expect(c.records).toBe(2); // Glucose lab + Lisinopril prescription (also projected into intake_items)
    expect(c.meds).toBe(1);
    expect(c.bodyMetrics).toBe(1);
    expect(c.heights).toBe(1);
    expect(c.headCircs).toBe(1);
    expect(c.immunizations).toBe(1);
    expect(c.allergies).toBe(1);
    expect(c.conditions).toBe(2); // hypertension + social-smoking status
    expect(c.encounters).toBe(1);
  });

  it("a document's own social-smoking condition is stored under its document_id", () => {
    const row = db
      .prepare(
        `SELECT document_id FROM conditions
           WHERE profile_id = ? AND external_id LIKE '%ccda:social-smoking:%'`
      )
      .get(profileA) as { document_id: number } | undefined;
    expect(row?.document_id).toBe(docA);
  });
});

describe("clearImportedDocumentRows (the document-delete core)", () => {
  it("removes EVERY imported kind, leaving no orphans", () => {
    clearImportedDocumentRows(profileA, docA);

    const c = footprintCounts(profileA, docA);
    expect(c).toEqual({
      records: 0,
      meds: 0,
      bodyMetrics: 0,
      heights: 0,
      headCircs: 0,
      immunizations: 0,
      allergies: 0,
      conditions: 0, // includes the social-smoking status → removed on delete
      encounters: 0,
    });

    // No orphans of any kind survive for profile A.
    expect(totalRowsForProfile(profileA)).toEqual({
      records: 0,
      meds: 0,
      bodyMetrics: 0,
      metricSamples: 0,
      immunizations: 0,
      allergies: 0,
      conditions: 0,
      encounters: 0,
    });
  });

  it("leaves a second profile's document fully intact (profile scoping)", () => {
    const c = footprintCounts(profileB, docB);
    expect(c.records).toBe(2); // Glucose lab + Lisinopril prescription (also projected into intake_items)
    expect(c.meds).toBe(1);
    expect(c.bodyMetrics).toBe(1);
    expect(c.heights).toBe(1);
    expect(c.headCircs).toBe(1);
    expect(c.immunizations).toBe(1);
    expect(c.allergies).toBe(1);
    expect(c.conditions).toBe(2);
    expect(c.encounters).toBe(1);
  });
});

describe("reprocess stays idempotent through the shared helper", () => {
  it("re-running persistDocumentImport does not duplicate any kind", () => {
    // profileB still has its original import. Reprocess it: the shared helper
    // clears the prior set, then the insert loops re-add exactly one of each.
    persistDocumentImport(profileB, docB, makeInput());
    const c = footprintCounts(profileB, docB);
    expect(c.records).toBe(2); // Glucose lab + Lisinopril prescription (also projected into intake_items)
    expect(c.meds).toBe(1);
    expect(c.bodyMetrics).toBe(1);
    expect(c.heights).toBe(1);
    expect(c.headCircs).toBe(1);
    expect(c.immunizations).toBe(1);
    expect(c.allergies).toBe(1);
    expect(c.conditions).toBe(2);
    expect(c.encounters).toBe(1);
  });
});

// Finding A (review of #203): the delete must not OVER-delete within the same
// profile. The footprint tests above seed only the deleted document's own rows,
// so "no orphans" passes trivially; this proves the per-table keying protects a
// same-profile MANUAL / INTEGRATION / OTHER-DOCUMENT row. It's the assertion that
// would catch a future keying regression (dropping the head_circumference_cm
// metric filter, or changing the document-source scheme) that silently reaches
// past one document.
describe("clearImportedDocumentRows never touches same-profile survivors", () => {
  it("clears only the target document's rows, keeping manual/integration/other-doc rows", () => {
    const profile = Number(
      db.prepare("INSERT INTO profiles (name) VALUES ('survivors')").run()
        .lastInsertRowid
    );
    const survivorDate = "2019-01-01";

    // ---- rows that MUST survive the delete of the target document ----
    // A manual body-metrics weigh-in (source NULL).
    db.prepare(
      "INSERT INTO body_metrics (profile_id, date, weight_kg) VALUES (?, ?, 90)"
    ).run(profile, survivorDate);
    // An integration height sample (source 'health-connect', not a document source).
    db.prepare(
      `INSERT INTO metric_samples
         (profile_id, source, metric, date, start_time, end_time, value)
       VALUES (?, 'health-connect', 'height_cm', ?, ?, ?, 180)`
    ).run(profile, survivorDate, survivorDate, survivorDate);
    // A manual immunization (source NULL).
    db.prepare(
      "INSERT INTO immunizations (profile_id, date, vaccine, dose_label) VALUES (?, ?, 'tdap', '1')"
    ).run(profile, survivorDate);
    // A manual medication (source NULL, document_id NULL) — the extracted-meds
    // delete is keyed on document_id + source='extracted', so this stays.
    db.prepare(
      `INSERT INTO intake_items (profile_id, name, active, kind, condition, priority)
       VALUES (?, 'Manual Aspirin', 1, 'medication', 'daily', 'high')`
    ).run(profile);

    // ---- two same-profile documents; only the FIRST is deleted ----
    const target = newDocument(profile, "target.ccd");
    const keeper = newDocument(profile, "keeper.ccd");
    // The keeper uses a different date (no same-date deferral) and a different med
    // name (no cross-document med dedup); no smoking status so it never supersedes
    // the target's. Import the target first, then the keeper.
    persistDocumentImport(profile, target, makeInput());
    persistDocumentImport(
      profile,
      keeper,
      makeInput({
        date: "2021-09-09",
        smoking: false,
        medName: "Atorvastatin 20 mg",
      })
    );

    // Both documents fully present before the delete.
    expect(footprintCounts(profile, target)).toMatchObject({
      records: 2,
      conditions: 2,
    });
    const keeperBefore = footprintCounts(profile, keeper);
    expect(keeperBefore).toEqual({
      records: 2,
      meds: 1,
      bodyMetrics: 1,
      heights: 1,
      headCircs: 1,
      immunizations: 1,
      allergies: 1,
      conditions: 1, // no smoking status on the keeper
      encounters: 1,
    });

    clearImportedDocumentRows(profile, target);

    // The target document's rows are gone …
    expect(footprintCounts(profile, target)).toEqual({
      records: 0,
      meds: 0,
      bodyMetrics: 0,
      heights: 0,
      headCircs: 0,
      immunizations: 0,
      allergies: 0,
      conditions: 0,
      encounters: 0,
    });

    // … but the KEEPER document is byte-for-byte untouched (different document_id
    // AND different document source) …
    expect(footprintCounts(profile, keeper)).toEqual(keeperBefore);

    // … and every manual / integration survivor is still there.
    const cnt = (sql: string, ...p: unknown[]) =>
      (db.prepare(sql).get(...p) as { n: number }).n;
    expect(
      cnt(
        "SELECT COUNT(*) n FROM body_metrics WHERE profile_id = ? AND source IS NULL",
        profile
      )
    ).toBe(1);
    expect(
      cnt(
        "SELECT COUNT(*) n FROM metric_samples WHERE profile_id = ? AND source = 'health-connect' AND metric = 'height_cm'",
        profile
      )
    ).toBe(1);
    expect(
      cnt(
        "SELECT COUNT(*) n FROM immunizations WHERE profile_id = ? AND source IS NULL",
        profile
      )
    ).toBe(1);
    expect(
      cnt(
        "SELECT COUNT(*) n FROM intake_items WHERE profile_id = ? AND name = 'Manual Aspirin'",
        profile
      )
    ).toBe(1);
  });
});

// Finding B (review of #203): the full deleteMedicalDocument path — not just the
// helper — must hold the FK-ordering invariant. intake_items.document_id →
// medical_documents(id) is NO ACTION (not cascade), so the extracted meds MUST be
// deleted BEFORE the medical_documents row, or SQLite raises a FK violation. The
// helper-only tests never drop the document row, so they'd pass even if a future
// edit reordered the drop ahead of the helper. Driving the real action (with a
// mocked session from the action-test harness) exercises the ordering + the
// starred-biomarker cleanup end to end.
describe("deleteMedicalDocument (full action path)", () => {
  it("deletes the document, its extracted med, and its orphaned star without an FK error", async () => {
    const { profile } = seedActor();
    const docId = newDocument(profile.id, "delete-me.ccd");
    persistDocumentImport(profile.id, docId, makeInput());
    // Star Glucose — its only record is in this document, so the delete's
    // starred-biomarker cleanup should drop the star too.
    db.prepare(
      "INSERT INTO starred_biomarkers (profile_id, canonical_name) VALUES (?, 'Glucose')"
    ).run(profile.id);

    // Sanity: the extracted med + document + star all exist first.
    expect(
      (
        db
          .prepare(
            "SELECT COUNT(*) n FROM intake_items WHERE document_id = ? AND source = 'extracted'"
          )
          .get(docId) as { n: number }
      ).n
    ).toBe(1);

    // The FK-ordering invariant: this must NOT throw (helper clears the extracted
    // meds before the medical_documents row is dropped).
    await expect(
      deleteMedicalDocument(fd({ id: docId }))
    ).resolves.toBeUndefined();

    // Document row gone, extracted med gone, and the now-orphaned star cleaned up.
    expect(
      db.prepare("SELECT id FROM medical_documents WHERE id = ?").get(docId)
    ).toBeUndefined();
    expect(footprintCounts(profile.id, docId)).toEqual({
      records: 0,
      meds: 0,
      bodyMetrics: 0,
      heights: 0,
      headCircs: 0,
      immunizations: 0,
      allergies: 0,
      conditions: 0,
      encounters: 0,
    });
    expect(
      (
        db
          .prepare(
            "SELECT COUNT(*) n FROM starred_biomarkers WHERE profile_id = ? AND canonical_name = 'Glucose'"
          )
          .get(profile.id) as { n: number }
      ).n
    ).toBe(0);
  });
});
