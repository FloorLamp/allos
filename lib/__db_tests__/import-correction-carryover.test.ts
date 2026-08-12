// DB INTEGRATION TIER — a hand correction to a document-derived reading survives
// the document's own reprocess (issue #2364).
//
// Two independent defects, both proved here against the real persist core:
//
//   1. THE LOCK WAS UNREACHABLE. `updateReadingAt` armed `edited` with
//      `CASE WHEN external_id IS NOT NULL`, and `extractionToPersistInput` sets
//      `external_id: null` unconditionally — so for an AI-extracted reading, the
//      majority of readings in the app, the lock was not merely unset, it was
//      unsettable.
//   2. REPROCESS DISCARDED IT ANYWAY. `IMPORT_FOOTPRINT_TABLES` makes a reprocess a
//      delete-and-reinsert, and nothing in the footprint knew about `edited`, so
//      even a correctly locked row was deleted by a re-extraction, a re-import from
//      the saved raw (#903), or a reprocess-all — silently.
//
// The fixture is deliberately the AI path's shape: `external_id: null` on every
// record, which is what made the old lock a no-op.

import { describe, it, expect } from "vitest";
import { db } from "@/lib/db";
import { persistDocumentImport } from "@/lib/import-persist";
import type { PersistInput } from "@/lib/import-shape";
import { parseImportReport, emptyReport } from "@/lib/import-report";
import { updateReadingAt } from "@/lib/reading-writes";

const DATE = "2026-04-02";

type Rec = PersistInput["records"][number];

function record(over: Partial<Rec> = {}): Rec {
  return {
    category: "lab",
    name: "Glucose",
    canonical: "Glucose",
    value: "95",
    value_num: 95,
    unit: "mg/dL",
    date: DATE,
    reference_range: null,
    flag: null,
    panel: null,
    notes: null,
    source: "ai",
    // THE defect's precondition: the AI path mints no external_id, ever.
    external_id: null,
    loinc: null,
    provider: null,
    courses: null,
    ...over,
  };
}

function input(records: Rec[]): PersistInput {
  return {
    records,
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
    meta: {
      docType: "lab_report",
      source: "ai",
      documentDate: DATE,
      patientName: null,
      raw: null,
      model: null,
      importReport: JSON.stringify(emptyReport()),
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
         VALUES (?, ?, '', 'processing', 'lab_report')`
      )
      .run(profileId, filename).lastInsertRowid
  );
}

function readingRows(profileId: number, canonical: string) {
  return db
    .prepare(
      `SELECT id, value, value_num, unit, edited FROM medical_records
        WHERE profile_id = ? AND canonical_name = ? ORDER BY id`
    )
    .all(profileId, canonical) as {
    id: number;
    value: string | null;
    value_num: number | null;
    unit: string | null;
    edited: number | null;
  }[];
}

function storedReport(docId: number) {
  const raw = (
    db
      .prepare("SELECT import_report FROM medical_documents WHERE id = ?")
      .get(docId) as { import_report: string | null }
  ).import_report;
  return parseImportReport(raw);
}

describe("a correction to an AI-extracted reading (#2364)", () => {
  it("sets the edit lock even though the row carries no external_id", () => {
    const profileId = newProfile("CORR-lock");
    const docId = newDocument(profileId, "labs.pdf");
    persistDocumentImport(profileId, docId, input([record()]));

    const [before] = readingRows(profileId, "Glucose");
    expect(before.edited).toBeFalsy();

    const outcome = updateReadingAt(
      profileId,
      { store: "medical_records", id: before.id, identity: "Glucose" },
      104
    );
    expect(outcome.ok).toBe(true);

    const [after] = readingRows(profileId, "Glucose");
    expect(after.value_num).toBe(104);
    expect(after.value).toBe("104");
    // The whole of defect 1: this used to stay 0, forever and by construction.
    expect(after.edited).toBe(1);
  });

  it("survives a reprocess of the same document, under a new row id", () => {
    const profileId = newProfile("CORR-reprocess");
    const docId = newDocument(profileId, "labs.pdf");
    persistDocumentImport(profileId, docId, input([record()]));
    const [imported] = readingRows(profileId, "Glucose");
    updateReadingAt(
      profileId,
      { store: "medical_records", id: imported.id, identity: "Glucose" },
      104
    );

    // A re-import from the saved raw extraction: the SAME parse, re-persisted. The
    // footprint is deleted and re-inserted, so the corrected row is gone and a fresh
    // one carrying the extraction's own 95 takes its place.
    persistDocumentImport(profileId, docId, input([record()]));

    const rows = readingRows(profileId, "Glucose");
    expect(rows).toHaveLength(1);
    // A NEW row (delete-and-reinsert is untouched — no per-table exception)…
    expect(rows[0].id).not.toBe(imported.id);
    // …carrying the user's value, still locked, so the next reprocess keeps it too.
    expect(rows[0].value_num).toBe(104);
    expect(rows[0].value).toBe("104");
    expect(rows[0].edited).toBe(1);
    // Nothing to report: the correction found its subject.
    expect(storedReport(docId)?.drops ?? []).toEqual([]);
  });

  it("carries corrections through a re-extraction that changed OTHER readings", () => {
    const profileId = newProfile("CORR-mixed");
    const docId = newDocument(profileId, "labs.pdf");
    persistDocumentImport(
      profileId,
      docId,
      input([
        record(),
        record({
          name: "Sodium",
          canonical: "Sodium",
          value: "140",
          value_num: 140,
          unit: "mmol/L",
        }),
      ])
    );
    const [glucose] = readingRows(profileId, "Glucose");
    updateReadingAt(
      profileId,
      { store: "medical_records", id: glucose.id, identity: "Glucose" },
      104
    );

    // The re-extraction reads Sodium differently and re-reads Glucose the same.
    persistDocumentImport(
      profileId,
      docId,
      input([
        record(),
        record({
          name: "Sodium",
          canonical: "Sodium",
          value: "138",
          value_num: 138,
          unit: "mmol/L",
        }),
      ])
    );

    // The corrected reading keeps the human's value; the untouched one takes the
    // extraction's new one — a re-apply is not a freeze of the whole document.
    expect(readingRows(profileId, "Glucose")[0]).toMatchObject({
      value_num: 104,
      edited: 1,
    });
    expect(readingRows(profileId, "Sodium")[0]).toMatchObject({
      value_num: 138,
      edited: 0,
    });
  });

  it("reports a correction the new extraction no longer has a subject for", () => {
    const profileId = newProfile("CORR-orphan");
    const docId = newDocument(profileId, "labs.pdf");
    persistDocumentImport(profileId, docId, input([record()]));
    const [imported] = readingRows(profileId, "Glucose");
    updateReadingAt(
      profileId,
      { store: "medical_records", id: imported.id, identity: "Glucose" },
      104
    );

    // The re-extraction drops Glucose entirely.
    persistDocumentImport(
      profileId,
      docId,
      input([
        record({
          name: "Sodium",
          canonical: "Sodium",
          value: "140",
          value_num: 140,
          unit: "mmol/L",
        }),
      ])
    );

    // NOT resurrected — the document stopped claiming the reading, and putting the
    // row back would keep something no source says any more.
    expect(readingRows(profileId, "Glucose")).toEqual([]);
    // Reported instead, so the user learns their correction lost its subject.
    const report = storedReport(docId);
    expect(report?.drops).toEqual([
      { kind: "lab", label: "Glucose", reason: "correction_orphaned" },
    ]);
    // And it does NOT inflate the parse's kept-vs-considered: a lost correction was
    // never a candidate this document offered.
    expect(report?.imported).toBe(1);
    expect(report?.considered).toBe(1);
  });

  it("refuses to paste a correction onto the same analyte in a DIFFERENT unit", () => {
    const profileId = newProfile("CORR-unit");
    const docId = newDocument(profileId, "labs.pdf");
    persistDocumentImport(profileId, docId, input([record()]));
    const [imported] = readingRows(profileId, "Glucose");
    updateReadingAt(
      profileId,
      { store: "medical_records", id: imported.id, identity: "Glucose" },
      104
    );

    // Same analyte, same day, re-read in mmol/L. 104 mg/dL is 5.8 mmol/L — pasting
    // the number across would be corruption dressed as a rescue.
    persistDocumentImport(
      profileId,
      docId,
      input([record({ value: "5.2", value_num: 5.2, unit: "mmol/L" })])
    );

    const rows = readingRows(profileId, "Glucose");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      value_num: 5.2,
      unit: "mmol/L",
      edited: 0,
    });
    expect(storedReport(docId)?.drops).toEqual([
      { kind: "lab", label: "Glucose", reason: "correction_orphaned" },
    ]);
  });
});
