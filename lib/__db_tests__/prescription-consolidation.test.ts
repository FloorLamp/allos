// DB INTEGRATION TIER (#1178 + #1204): the imported-prescription consolidation.
// An imported prescription is the SINGLE medication entity (intake_items) — never a
// paired medical_records prescription — and a cross-document re-prescription attaches
// a new COURSE (renewal) instead of the old skip-to-records-fallback or a duplicate
// item. Also covers the one-shot migration 092 consolidation of legacy paired rows.
// Deterministic: :memory: DB via setup.ts; fixed dates.

import { describe, it, expect, beforeEach } from "vitest";
import { db } from "@/lib/db";
import { persistDocumentImport } from "@/lib/import-persist";
import type { PersistInput, PersistRecord } from "@/lib/import-shape";
import {
  getUnlinkedRecords,
  linkRecordToEncounter,
  encounterForRecord,
} from "@/lib/queries";
import { up as migration092 } from "@/lib/migrations/versions/092-consolidate-imported-prescriptions";

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

function prescription(over: Partial<PersistRecord>): PersistRecord {
  return {
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
    external_id: "med:lisinopril",
    loinc: null,
    provider: null,
    ...over,
  } as PersistRecord;
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

let profileId: number;
beforeEach(() => {
  profileId = newProfile(`PC-${Math.random()}`);
});

describe("#1178 a CCD prescription imports as the single medication entity", () => {
  it("creates ONE medication, ZERO prescription records, carrying its metadata", () => {
    const doc = newDocument(profileId);
    persistDocumentImport(
      profileId,
      doc,
      emptyInput({
        records: [
          prescription({ prescriber: "Dr. Alice Green", pharmacy: "MainRx" }),
        ],
      })
    );

    const meds = db
      .prepare(
        `SELECT name, prescriber, pharmacy, source FROM intake_items
          WHERE profile_id = ? AND kind = 'medication'`
      )
      .all(profileId) as {
      name: string;
      prescriber: string | null;
      pharmacy: string | null;
      source: string | null;
    }[];
    expect(meds).toHaveLength(1);
    expect(meds[0].name).toBe("Lisinopril");
    expect(meds[0].prescriber).toBe("Dr. Alice Green");
    expect(meds[0].pharmacy).toBe("MainRx");
    expect(meds[0].source).toBe("extracted");

    // ZERO paired medical_records prescription rows.
    const recCount = db
      .prepare(
        `SELECT COUNT(*) AS n FROM medical_records
          WHERE profile_id = ? AND category = 'prescription'`
      )
      .get(profileId) as { n: number };
    expect(recCount.n).toBe(0);

    // The med has a course carrying the prescriber + a dose snapshot.
    const course = db
      .prepare(
        `SELECT c.prescriber AS prescriber, c.dose_snapshot AS dose_snapshot
           FROM medication_courses c
           JOIN intake_items ii ON ii.id = c.item_id
          WHERE ii.profile_id = ?`
      )
      .get(profileId) as {
      prescriber: string | null;
      dose_snapshot: string | null;
    };
    expect(course.prescriber).toBe("Dr. Alice Green");
    expect(course.dose_snapshot).not.toBeNull();
  });

  it("lists each prescription ONCE as a visit-link candidate (no cross-domain double-count)", () => {
    const doc = newDocument(profileId);
    persistDocumentImport(
      profileId,
      doc,
      emptyInput({
        records: [
          prescription({ name: "Lisinopril 10 mg", external_id: "med:lis" }),
          prescription({
            name: "Metformin 500 mg",
            canonical: "Metformin 500 mg",
            external_id: "med:met",
          }),
        ],
      })
    );
    const unlinked = getUnlinkedRecords(profileId);
    // Two candidates, each a `medication` — never a duplicated (record + medication)
    // pair for one prescription (the #1178 double-listing symptom, fixed at the root).
    expect(unlinked).toHaveLength(2);
    expect(unlinked.every((r) => r.domain === "medication")).toBe(true);
    expect(new Set(unlinked.map((r) => r.label))).toEqual(
      new Set(["Lisinopril", "Metformin"])
    );
  });
});

describe("#1204 cross-document re-prescription attaches a course", () => {
  it("a second document renewing the same drug adds a course (no dup item), with prescriber + snapshot", () => {
    const doc1 = newDocument(profileId);
    persistDocumentImport(
      profileId,
      doc1,
      emptyInput({
        records: [prescription({ prescriber: "Dr. Alice Green" })],
      })
    );
    const doc2 = newDocument(profileId);
    persistDocumentImport(
      profileId,
      doc2,
      emptyInput({
        records: [
          prescription({
            date: "2026-06-01",
            external_id: "med:lisinopril-2",
            prescriber: "Dr. Bob Stone",
          }),
        ],
      })
    );

    const meds = db
      .prepare(
        `SELECT id, name FROM intake_items WHERE profile_id = ? AND kind = 'medication'`
      )
      .all(profileId) as { id: number; name: string }[];
    expect(meds).toHaveLength(1); // NOT a duplicate item

    const courses = db
      .prepare(
        `SELECT prescriber, dose_snapshot FROM medication_courses
          WHERE item_id = ? ORDER BY id`
      )
      .all(meds[0].id) as {
      prescriber: string | null;
      dose_snapshot: string | null;
    }[];
    expect(courses).toHaveLength(2); // initial + the renewal course
    // The renewal course carries the second prescriber + a dose snapshot.
    expect(courses.some((c) => c.prescriber === "Dr. Bob Stone")).toBe(true);
    expect(courses.every((c) => c.dose_snapshot != null)).toBe(true);
  });

  it("#1027 boundary: a CONCURRENT different-strength order stays a SEPARATE item", () => {
    const doc1 = newDocument(profileId);
    persistDocumentImport(
      profileId,
      doc1,
      emptyInput({
        records: [
          prescription({
            name: "Ibuprofen 200 mg",
            canonical: "Ibuprofen 200 mg",
            external_id: "med:ibu200",
            notes: null, // as-needed → keeps an OPEN course
          }),
        ],
      })
    );
    const doc2 = newDocument(profileId);
    persistDocumentImport(
      profileId,
      doc2,
      emptyInput({
        records: [
          prescription({
            name: "Ibuprofen 800 mg",
            canonical: "Ibuprofen 800 mg",
            external_id: "med:ibu800",
            notes: null,
          }),
        ],
      })
    );
    const meds = db
      .prepare(
        `SELECT id FROM intake_items WHERE profile_id = ? AND kind = 'medication'
           AND lower(name) = 'ibuprofen'`
      )
      .all(profileId) as { id: number }[];
    // Two SEPARATE items (200 mg + 800 mg taken concurrently) — the #1027 carve-out.
    expect(meds).toHaveLength(2);
  });
});

describe("#1178 reprocess re-applies an accepted visit link to the medication", () => {
  it("survives a delete-and-reinsert via the med's stable import_key", () => {
    const doc = newDocument(profileId);
    // A prescription with NO encounter reference (so no tier-1 link) + a same-day
    // encounter — the med starts unlinked, then the user accepts the suggestion.
    const bundle = () =>
      emptyInput({
        encounters: [
          {
            date: DATE,
            end_date: null,
            type: "Office Visit",
            code: null,
            code_system: null,
            class_code: "AMB",
            reason: null,
            diagnoses: [],
            provider: null,
            location: null,
            notes: null,
            external_id: "ccda:encounter:v1",
          },
        ],
        records: [prescription({})],
      });
    persistDocumentImport(profileId, doc, bundle());
    const eid = (
      db
        .prepare(`SELECT id FROM encounters WHERE profile_id = ? LIMIT 1`)
        .get(profileId) as { id: number }
    ).id;
    const medId = (
      db
        .prepare(
          `SELECT id FROM intake_items WHERE profile_id = ? AND kind = 'medication'`
        )
        .get(profileId) as { id: number }
    ).id;
    // Accept the medication↔visit link (records a durable decision on import_key).
    expect(linkRecordToEncounter(profileId, "medication", medId, eid)).toBe(
      true
    );

    // Reprocess: the med is deleted-and-reinserted under a NEW id, but the accepted
    // link re-applies via its stable import_key.
    persistDocumentImport(profileId, doc, bundle());
    const newMedId = (
      db
        .prepare(
          `SELECT id FROM intake_items WHERE profile_id = ? AND kind = 'medication'`
        )
        .get(profileId) as { id: number }
    ).id;
    expect(newMedId).not.toBe(medId); // fresh row after reprocess
    // The encounter was also re-created (new id) under its stable external_id; the
    // accepted decision re-resolves both sides by stable token and re-links the med.
    const newEid = (
      db
        .prepare(`SELECT id FROM encounters WHERE profile_id = ? LIMIT 1`)
        .get(profileId) as { id: number }
    ).id;
    expect(encounterForRecord(profileId, "medication", newMedId)?.id).toBe(
      newEid
    );
  });
});

describe("migration 092 consolidates legacy paired + unpaired prescription rows", () => {
  it("consolidates a paired row onto the med, re-keys decisions, and projects an unpaired one", () => {
    const doc = newDocument(profileId);
    const eid = Number(
      db
        .prepare(
          `INSERT INTO encounters (profile_id, date, type, source, document_id, external_id)
           VALUES (?, ?, 'Visit', 'doc', ?, 'doc|enc')`
        )
        .run(profileId, DATE, doc).lastInsertRowid
    );

    // A legacy PAIRED prescription record + its projected med (source_record_id).
    const pairedRec = Number(
      db
        .prepare(
          `INSERT INTO medical_records
             (profile_id, date, category, name, document_id, source, external_id, encounter_id)
           VALUES (?, ?, 'prescription', 'Lisinopril 10 mg', ?, 'document:1', 'document:1|rx1', ?)`
        )
        .run(profileId, DATE, doc, eid).lastInsertRowid
    );
    const pairedMed = Number(
      db
        .prepare(
          `INSERT INTO intake_items
             (profile_id, name, kind, active, source, document_id, source_record_id)
           VALUES (?, 'Lisinopril', 'medication', 1, 'extracted', ?, ?)`
        )
        .run(profileId, doc, pairedRec).lastInsertRowid
    );
    // A durable 'record'-domain accepted visit-link decision on the paired record.
    db.prepare(
      `INSERT INTO visit_link_decisions
         (profile_id, domain, encounter_key, target_key, decision)
       VALUES (?, 'record', 'ext:doc|enc', 'ext:document:1|rx1', 'linked')`
    ).run(profileId);

    // A legacy UNPAIRED prescription record (the old cross-doc-duplicate / AI fallback).
    db.prepare(
      `INSERT INTO medical_records
         (profile_id, date, category, name, document_id, source, external_id)
       VALUES (?, ?, 'prescription', 'Atorvastatin', ?, 'document:1', 'document:1|rx2')`
    ).run(profileId, DATE, doc);

    migration092(db);

    // Every prescription record is gone.
    expect(
      (
        db
          .prepare(
            `SELECT COUNT(*) AS n FROM medical_records WHERE profile_id = ? AND category = 'prescription'`
          )
          .get(profileId) as { n: number }
      ).n
    ).toBe(0);

    // The paired med kept its data, gained the record's encounter link, and nulled
    // source_record_id; its decision re-keyed to the medication domain.
    const med = db
      .prepare(
        `SELECT source_record_id, encounter_id, import_key FROM intake_items WHERE id = ?`
      )
      .get(pairedMed) as {
      source_record_id: number | null;
      encounter_id: number | null;
      import_key: string | null;
    };
    expect(med.source_record_id).toBeNull();
    expect(med.encounter_id).toBe(eid);
    const decisions = db
      .prepare(
        `SELECT domain, target_key FROM visit_link_decisions WHERE profile_id = ?`
      )
      .all(profileId) as { domain: string; target_key: string }[];
    expect(decisions.every((d) => d.domain === "medication")).toBe(true);
    expect(
      decisions.some((d) => d.target_key === `ext:${med.import_key}`)
    ).toBe(true);

    // The unpaired record was projected into a NEW med.
    const projected = db
      .prepare(
        `SELECT id FROM intake_items WHERE profile_id = ? AND kind = 'medication' AND lower(name) = 'atorvastatin'`
      )
      .get(profileId) as { id: number } | undefined;
    expect(projected).toBeDefined();
    // …and it carries an initial course.
    expect(
      (
        db
          .prepare(
            `SELECT COUNT(*) AS n FROM medication_courses WHERE item_id = ?`
          )
          .get(projected!.id) as { n: number }
      ).n
    ).toBeGreaterThanOrEqual(1);
  });
});
