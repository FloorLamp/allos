// DB INTEGRATION TIER — structured imaging studies (#702).
//
// Drives a synthetic radiology-report extraction through the REAL adapter
// (extractionToPersistInput) and the ONE persist core (persistDocumentImport), then
// reads it back through the document queries the UI uses. Pins that (a) imaging
// studies land as structured rows with the raw modality/laterality/contrast
// normalized onto the DB CHECK sets, (b) they count toward extracted_count /
// producedTotal, (c) they honor the import footprint contract — cleared on document
// delete, MOVED on reassign (#201) — since imaging_studies joins
// IMPORT_FOOTPRINT_TABLES, and (d) they surface as a first-class Timeline event.
//
// No real AI calls — the fixture is a synthetic ExtractionResult with clearly-fake
// PHI (a fictional "Test Patient"). Runs against a throwaway DB (setup.ts).

import { describe, it, expect, beforeAll } from "vitest";
import {
  getDocumentProduced,
  getDocumentImagingStudies,
  getImagingStudies,
  getMedicalDocument,
} from "@/lib/queries";
import {
  persistDocumentImport,
  countImportedDocumentRows,
  clearImportedDocumentRows,
  moveImportedDocumentRows,
} from "@/lib/import-persist";
import { producedTotal } from "@/lib/import-log";
import { extractionToPersistInput } from "@/lib/import-shape";
import { getTimelineEvents } from "@/lib/timeline";
import type { ExtractionResult } from "@/lib/medical-extract";
import { db } from "@/lib/db";

// A synthetic radiology report: one MRI (with contrast) and one plain chest film,
// plus one empty study that must drop. Loose modality/laterality/contrast phrasings
// exercise the normalizer.
function imagingExtraction(): Extract<ExtractionResult, { status: "done" }> {
  return {
    status: "done",
    model: "claude-test",
    raw: "RAW",
    meta: {
      document_type: "imaging",
      source: "Test Imaging Center",
      patient_name: "Test Patient",
      patient_sex: null,
      patient_birthdate: null,
      patient_age: null,
      document_date: "2024-06-01",
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
    imagingStudies: [
      {
        modality: "Magnetic Resonance Imaging",
        body_region: "Knee",
        laterality: "Left",
        contrast: "with contrast",
        contrast_agent: "gadolinium",
        study_date: "2024-06-01",
        dose_msv: null,
        impression: "Small joint effusion. No meniscal tear.",
        indication: "Knee pain",
        status: "final",
      },
      {
        modality: "X-ray",
        body_region: "Chest",
        laterality: "n/a",
        contrast: "without contrast",
        contrast_agent: null,
        study_date: "2024-06-01",
        dose_msv: "0.1 mSv",
        impression: "No acute cardiopulmonary process.",
        indication: "Cough",
        status: "final",
      },
      // Empty study — no modality, region, OR impression — must drop.
      {
        modality: null,
        body_region: null,
        laterality: null,
        contrast: null,
        contrast_agent: null,
        study_date: null,
        dose_msv: null,
        impression: null,
        indication: null,
        status: null,
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
         VALUES (?, 'radiology-report.pdf', '', 'processing', 'imaging')`
      )
      .run(profileId).lastInsertRowid
  );
}

let profile: number;
let doc: number;

beforeAll(() => {
  profile = newProfile("IMAGING");
  doc = newDocument(profile);
  persistDocumentImport(
    profile,
    doc,
    extractionToPersistInput(imagingExtraction(), "2024-06-01")
  );
});

describe("AI extraction lands imaging studies through the persist core", () => {
  it("persists each study with modality/laterality/contrast normalized to the CHECK sets", () => {
    const rows = getDocumentImagingStudies(profile, doc);
    expect(rows.map((r) => r.modality).sort()).toEqual(["mri", "x-ray"]);

    const all = getImagingStudies(profile);
    const mri = all.find((r) => r.modality === "mri")!;
    expect(mri.body_region).toBe("Knee");
    expect(mri.laterality).toBe("left");
    expect(mri.contrast).toBe(true);
    expect(mri.contrast_agent).toBe("gadolinium");
    expect(mri.impression).toBe("Small joint effusion. No meniscal tear.");
    expect(mri.indication).toBe("Knee pain");

    const cxr = all.find((r) => r.modality === "x-ray")!;
    expect(cxr.laterality).toBe("na");
    expect(cxr.contrast).toBe(false);
    // A printed dose ("0.1 mSv") is parsed to a number on the import path (#703); the
    // MRI, which printed none, stays null and falls back to the typical estimate.
    expect(cxr.dose_msv).toBe(0.1);
    expect(mri.dose_msv).toBeNull();
    // Import provenance is stamped so the footprint can clear/move/count it.
    expect(cxr.document_id).toBe(doc);
    expect(cxr.source).toBe(`document:${doc}`);
  });

  it("drops an empty study (no modality, region, or impression)", () => {
    expect(getDocumentImagingStudies(profile, doc)).toHaveLength(2);
  });

  it("counts the studies toward extracted_count / producedTotal", () => {
    const counts = getDocumentProduced(profile, doc);
    expect(counts.imagingStudies).toBe(2);
    const total = countImportedDocumentRows(profile, doc);
    expect(producedTotal(counts)).toBe(total);
    const docRow = getMedicalDocument(profile, doc)!;
    expect(docRow.extracted_count).toBe(total);
    expect(total).toBeGreaterThanOrEqual(2);
  });

  it("surfaces each study as a first-class Timeline event", () => {
    const events = getTimelineEvents(profile, { category: "imaging" });
    expect(events).toHaveLength(2);
    const mri = events.find((e) => e.title === "MRI Left Knee");
    expect(mri).toBeTruthy();
    expect(mri!.category).toBe("imaging");
    expect(mri!.detail).toBe("Small joint effusion. No meniscal tear.");
    expect(mri!.href).toBe("/results#imaging");
    // Both studies carry the imaging category and link to the passport surface.
    expect(events.every((e) => e.href === "/results#imaging")).toBe(true);
  });
});

describe("import footprint: imaging_studies is cleared / moved by document", () => {
  it("clearImportedDocumentRows removes them on document delete", () => {
    const p = newProfile("IMAGING-CLEAR");
    const d = newDocument(p);
    persistDocumentImport(
      p,
      d,
      extractionToPersistInput(imagingExtraction(), "2024-06-01")
    );
    expect(getDocumentImagingStudies(p, d)).toHaveLength(2);
    clearImportedDocumentRows(p, d);
    expect(getDocumentImagingStudies(p, d)).toHaveLength(0);
  });

  it("moveImportedDocumentRows re-points them to the destination profile (#201)", () => {
    const src = newProfile("IMAGING-SRC");
    const dest = newProfile("IMAGING-DEST");
    const d = newDocument(src);
    persistDocumentImport(
      src,
      d,
      extractionToPersistInput(imagingExtraction(), "2024-06-01")
    );
    expect(getImagingStudies(src).length).toBeGreaterThanOrEqual(2);

    moveImportedDocumentRows(src, dest, d);
    expect(getDocumentImagingStudies(dest, d)).toHaveLength(2);
    expect(getDocumentImagingStudies(src, d)).toHaveLength(0);
    expect(
      getImagingStudies(dest)
        .map((r) => r.modality)
        .sort()
    ).toEqual(["mri", "x-ray"]);
  });
});
