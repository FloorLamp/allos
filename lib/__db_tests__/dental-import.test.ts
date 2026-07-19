// DB INTEGRATION TIER — dental-procedure AI-extraction + import footprint (#705).
// Drives the real extraction→persist path (extractionToPersistInput → the ONE persist
// core persistDocumentImport), then reads it back through the document queries the
// import-detail UI uses. Pins that (a) each extracted dental record lands with status/
// tooth-system normalized to the CHECK sets, (b) they count into getDocumentProduced /
// producedTotal, and (c) they honor the import footprint contract — cleared on document
// delete, MOVED on reassign (#201/#212) — since dental_procedures joins
// IMPORT_FOOTPRINT_TABLES. Fixtures are 100% synthetic. No AI, no network.

import { describe, it, expect, beforeAll } from "vitest";
import {
  getDocumentDentalProcedures,
  getDocumentProduced,
} from "@/lib/queries";
import { producedTotal } from "@/lib/import-log";
import {
  persistDocumentImport,
  clearImportedDocumentRows,
  moveImportedDocumentRows,
} from "@/lib/import-persist";
import { extractionToPersistInput } from "@/lib/import-shape";
import type { ExtractionResult } from "@/lib/medical-extract";
import { db } from "@/lib/db";

// A synthetic dental after-visit summary: a completed filling, a planned extraction,
// and a caries-watch finding — plus one empty (no-name) record that must drop. Loose
// status/tooth-system phrasings exercise the normalizer.
function dentalExtraction(): Extract<ExtractionResult, { status: "done" }> {
  return {
    status: "done",
    model: "claude-test",
    raw: "RAW",
    meta: {
      document_type: "other",
      source: "Test Family Dental",
      patient_name: "Test Patient",
      patient_sex: null,
      patient_birthdate: null,
      patient_age: null,
      document_date: "2026-05-01",
    },
    results: [],
    immunizations: [],
    conditions: [],
    allergies: [],
    procedures: [],
    encounters: [],
    familyHistory: [],
    carePlanItems: [],
    careGoals: [],
    genomicVariants: [],
    imagingStudies: [],
    dentalProcedures: [
      {
        name: "Composite filling",
        status: "completed",
        tooth: "14",
        tooth_system: "Universal",
        surface: "mod",
        cdt_code: "D2392",
        procedure_date: "2026-05-01",
        finding: null,
        follow_up_interval_days: null,
      },
      {
        name: "Extraction of tooth #17",
        status: "treatment plan",
        tooth: "17",
        tooth_system: "ADA",
        surface: null,
        cdt_code: "D7140",
        procedure_date: null,
        finding: "Non-restorable",
        follow_up_interval_days: null,
      },
      {
        name: "Caries watch",
        status: "watch",
        tooth: "30",
        tooth_system: null,
        surface: null,
        cdt_code: null,
        procedure_date: "2026-05-01",
        finding: "watch mesial #30, recheck 6mo",
        follow_up_interval_days: 180,
      },
      // Empty record — no name — must drop.
      {
        name: null,
        status: null,
        tooth: null,
        tooth_system: null,
        surface: null,
        cdt_code: null,
        procedure_date: null,
        finding: null,
        follow_up_interval_days: null,
      },
    ],
    drops: [],
  };
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
        `INSERT INTO medical_documents
           (profile_id, filename, stored_path, extraction_status, doc_type)
         VALUES (?, 'dental-summary.pdf', '', 'processing', 'other')`
      )
      .run(profileId).lastInsertRowid
  );
}

let profile: number;
let doc: number;

beforeAll(() => {
  profile = newProfile("DENTAL");
  doc = newDocument(profile);
  persistDocumentImport(
    profile,
    doc,
    extractionToPersistInput(dentalExtraction(), "2026-05-01")
  );
});

describe("AI extraction lands dental procedures through the persist core", () => {
  it("persists each record with status/tooth-system normalized to the CHECK sets", () => {
    const rows = getDocumentDentalProcedures(profile, doc);
    expect(rows).toHaveLength(3); // the empty record dropped
    const filling = rows.find((r) => r.name === "Composite filling")!;
    expect(filling.status).toBe("completed");
    expect(filling.tooth).toBe("14");
    expect(filling.surface).toBe("MOD");
    expect(filling.cdt_code).toBe("D2392");
    const extraction = rows.find((r) => r.name.startsWith("Extraction"))!;
    expect(extraction.status).toBe("planned"); // "treatment plan" → planned
    const watch = rows.find((r) => r.name === "Caries watch")!;
    expect(watch.status).toBe("watch");
    expect(watch.finding).toContain("watch mesial");
  });

  it("counts dental records into getDocumentProduced + producedTotal (#212)", () => {
    const counts = getDocumentProduced(profile, doc);
    expect(counts.dentalProcedures).toBe(3);
    // producedTotal includes the dental records (3 here, nothing else in this doc).
    expect(producedTotal(counts)).toBe(3);
  });
});

describe("import footprint: dental_procedures is cleared / moved by document (#201)", () => {
  it("clearImportedDocumentRows removes them on document delete", () => {
    const p = newProfile("DENTAL-CLEAR");
    const d = newDocument(p);
    persistDocumentImport(
      p,
      d,
      extractionToPersistInput(dentalExtraction(), "2026-05-01")
    );
    expect(getDocumentDentalProcedures(p, d)).toHaveLength(3);
    clearImportedDocumentRows(p, d);
    expect(getDocumentDentalProcedures(p, d)).toHaveLength(0);
  });

  it("moveImportedDocumentRows re-points them to the destination profile", () => {
    const src = newProfile("DENTAL-SRC");
    const dest = newProfile("DENTAL-DEST");
    const d = newDocument(src);
    persistDocumentImport(
      src,
      d,
      extractionToPersistInput(dentalExtraction(), "2026-05-01")
    );
    expect(getDocumentDentalProcedures(src, d)).toHaveLength(3);
    moveImportedDocumentRows(src, dest, d);
    expect(getDocumentDentalProcedures(src, d)).toHaveLength(0);
    expect(getDocumentDentalProcedures(dest, d)).toHaveLength(3);
  });
});
