// DB INTEGRATION TIER — per-record extraction confidence (#1601) end to end:
// the AI adapter's summary is PERSISTED on the document's import_report by the real
// persist path, read back by the detail surface's parser, and projected as the Review
// feed's "N to check" badge by the profile-scoped feed query.
//
// Why this tier: the badge is a SQL projection of a stored, precomputed total, so the
// only honest proof is a real write followed by a real read — including the failure
// modes the pure tier can't reach (a garbled stored report, another profile's rows).

import { describe, it, expect } from "vitest";
import {
  getImportLogDocuments,
  getImportDocumentsFeed,
  getMedicalDocument,
} from "@/lib/queries";
import { persistDocumentImport } from "@/lib/import-persist";
import { extractionToPersistInput } from "@/lib/import-shape";
import { parseImportReport } from "@/lib/import-report";
import type { ExtractionResult } from "@/lib/medical-extract";
import { db } from "@/lib/db";

const DATE = "2021-04-05";

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
         VALUES (?, ?, '', 'processing', 'lab')`
      )
      .run(profileId, filename).lastInsertRowid
  );
}

// A done AI extraction with three lab rows whose certainty the model reported.
function extraction(
  confidences: (string | null)[]
): Extract<ExtractionResult, { status: "done" }> {
  return {
    status: "done",
    model: "model-1",
    raw: "{}",
    meta: {
      document_type: "lab",
      source: "Sample Labs",
      patient_name: "Test Patient",
      patient_sex: null,
      patient_birthdate: null,
      patient_age: null,
      document_date: DATE,
    },
    results: confidences.map((confidence, i) => ({
      category: "lab" as const,
      panel: null,
      name: `Confidence Marker ${i + 1}`,
      canonical_name: `Confidence Marker ${i + 1}`,
      value: "1",
      value_num: 1,
      unit: "mg/dL",
      reference_range: null,
      flag: null,
      collected_date: DATE,
      notes: null,
      confidence: confidence as never,
      confidence_reason: confidence === "high" ? null : "figure unclear",
    })),
    immunizations: [],
    conditions: [],
    allergies: [],
    procedures: [],
    encounters: [],
    familyHistory: [],
    carePlanItems: [],
    careGoals: [],
    drops: [],
  };
}

// Import a document for `profileId` from an AI extraction with the given per-row
// confidences, through the SAME adapter + persist path the upload flow uses.
function importWithConfidences(
  profileId: number,
  filename: string,
  confidences: (string | null)[]
): number {
  const docId = newDocument(profileId, filename);
  persistDocumentImport(
    profileId,
    docId,
    extractionToPersistInput(extraction(confidences), DATE)
  );
  return docId;
}

function feedScrutiny(profileId: number, docId: number): number | undefined {
  return getImportLogDocuments(profileId).find((d) => d.id === docId)
    ?.confidence_scrutiny;
}

describe("extraction confidence: persisted on the report, projected onto the feed", () => {
  it("stores the ranked summary and badges the document with its scrutiny total", () => {
    const profileId = newProfile("CONF-A");
    const docId = importWithConfidences(profileId, "conf-labs.pdf", [
      "high",
      "medium",
      "low",
    ]);

    // Persisted where the OTHER review signals live — on the document's report, with
    // no per-row schema column involved.
    const doc = getMedicalDocument(profileId, docId)!;
    const confidence = parseImportReport(doc.import_report)?.confidence;
    expect(confidence?.counts).toEqual({
      high: 1,
      medium: 1,
      low: 1,
      unknown: 0,
    });
    expect(confidence?.scrutiny).toBe(2);
    // Lowest first, so the detail card opens on the row to check first.
    expect(confidence?.flags.map((f) => f.confidence)).toEqual([
      "low",
      "medium",
    ]);

    // The Review feed badge reads the SAME precomputed total out of SQL.
    expect(feedScrutiny(profileId, docId)).toBe(2);
    const entry = getImportDocumentsFeed(profileId).find(
      (e) => e.stream === "document" && e.doc.id === docId
    );
    expect(
      entry && entry.stream === "document"
        ? entry.doc.confidence_scrutiny
        : null
    ).toBe(2);
  });

  it("badges nothing when the extraction reported no confidence at all", () => {
    // The keyless / offline / pre-#1601 shape: rows import exactly as before and the
    // report simply carries no confidence — the feed shows no badge rather than a 0.
    const profileId = newProfile("CONF-LEGACY");
    const docId = importWithConfidences(profileId, "legacy-labs.pdf", [
      null,
      null,
    ]);
    const doc = getMedicalDocument(profileId, docId)!;
    expect(parseImportReport(doc.import_report)?.confidence).toBeNull();
    expect(feedScrutiny(profileId, docId)).toBe(0);
  });

  it("survives a garbled or missing stored report instead of failing the feed", () => {
    const profileId = newProfile("CONF-GARBLED");
    const docId = importWithConfidences(profileId, "garbled.pdf", ["low"]);
    expect(feedScrutiny(profileId, docId)).toBe(1);

    // A truncated write / hand-edited row: SQLite's json_extract raises on malformed
    // JSON, so the guard is what keeps the whole Review tab from 500-ing.
    db.prepare(
      "UPDATE medical_documents SET import_report = ? WHERE id = ? AND profile_id = ?"
    ).run('{"confidence":{"scrutiny":2', docId, profileId);
    expect(() => getImportLogDocuments(profileId)).not.toThrow();
    expect(feedScrutiny(profileId, docId)).toBe(0);

    // A well-formed report from before the field existed reads as no signal.
    db.prepare(
      "UPDATE medical_documents SET import_report = ? WHERE id = ? AND profile_id = ?"
    ).run(
      '{"drops":[],"coverage":[],"imported":1,"considered":1}',
      docId,
      profileId
    );
    expect(feedScrutiny(profileId, docId)).toBe(0);

    // As does a document with no report at all.
    db.prepare(
      "UPDATE medical_documents SET import_report = NULL WHERE id = ? AND profile_id = ?"
    ).run(docId, profileId);
    expect(feedScrutiny(profileId, docId)).toBe(0);
  });

  it("keeps the badge inside its own profile", () => {
    const mine = newProfile("CONF-MINE");
    const theirs = newProfile("CONF-THEIRS");
    const myDoc = importWithConfidences(mine, "mine.pdf", ["low", "low"]);
    const theirDoc = importWithConfidences(theirs, "theirs.pdf", ["medium"]);

    expect(feedScrutiny(mine, myDoc)).toBe(2);
    // No bleed in either direction — the other profile's document isn't even listed.
    expect(feedScrutiny(mine, theirDoc)).toBeUndefined();
    expect(feedScrutiny(theirs, myDoc)).toBeUndefined();
    expect(feedScrutiny(theirs, theirDoc)).toBe(1);
  });

  it("rewrites the summary on a re-import of the same document", () => {
    // A reprocess funnels through the same persist chokepoint, so the confidence
    // signal tracks the CURRENT extraction rather than accumulating stale flags.
    const profileId = newProfile("CONF-REPROCESS");
    const docId = importWithConfidences(profileId, "reprocess.pdf", [
      "low",
      "low",
      "low",
    ]);
    expect(feedScrutiny(profileId, docId)).toBe(3);

    persistDocumentImport(
      profileId,
      docId,
      extractionToPersistInput(extraction(["high", "high", "medium"]), DATE)
    );
    expect(feedScrutiny(profileId, docId)).toBe(1);
  });
});
