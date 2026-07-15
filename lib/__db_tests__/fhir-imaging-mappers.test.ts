// DB INTEGRATION TIER — the structured FHIR imaging mappers (#708 → #702).
//
// Drives a synthetic FHIR bundle carrying an ImagingStudy, an imaging
// DiagnosticReport (conclusion + inline presentedForm), and an inline-text imaging
// DocumentReference through the REAL deterministic path (parseFhirBundle →
// healthRecordToPersistInput → the ONE persist core), then reads the rows back. Pins
// that (a) each FHIR imaging resource lands as a structured imaging_studies row with
// its impression + normalized modality, (b) the rows carry document_id/source so the
// import footprint owns them, (c) they count toward extracted_count / producedTotal,
// and (d) they honor the footprint contract — cleared on document delete, MOVED on
// reassign (#201) — since imaging_studies joins IMPORT_FOOTPRINT_TABLES.
//
// No AI, no network — the bundle is deterministic FHIR JSON. Names are SYNTHETIC
// ("Test Patient"); every value is clearly fake. Runs against a throwaway DB (setup.ts).

import { describe, it, expect, beforeAll } from "vitest";
import { parseFhirBundle } from "@/lib/fhir";
import { healthRecordToPersistInput } from "@/lib/import-shape";
import {
  persistDocumentImport,
  countImportedDocumentRows,
  clearImportedDocumentRows,
  moveImportedDocumentRows,
} from "@/lib/import-persist";
import { producedTotal } from "@/lib/import-log";
import {
  getDocumentProduced,
  getDocumentImagingStudies,
  getImagingStudies,
  getMedicalDocument,
} from "@/lib/queries";
import { db } from "@/lib/db";

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

function imagingBundle(): string {
  return JSON.stringify({
    resourceType: "Bundle",
    type: "collection",
    entry: [
      {
        resource: {
          resourceType: "Patient",
          gender: "female",
          birthDate: "1990-02-02",
          name: [{ text: "Test Patient" }],
        },
      },
      {
        resource: {
          resourceType: "ImagingStudy",
          id: "study-1",
          status: "available",
          started: "2024-05-02T10:00:00Z",
          modality: [{ code: "MR", display: "Magnetic Resonance" }],
          description: "MRI Left Knee",
          reasonCode: [{ text: "Knee pain" }],
          series: [
            {
              modality: { code: "MR" },
              bodySite: { display: "Knee" },
              laterality: { code: "7771000", display: "Left" },
            },
          ],
        },
      },
      {
        resource: {
          resourceType: "DiagnosticReport",
          id: "dr-img",
          status: "final",
          category: [
            {
              coding: [
                {
                  system: "http://terminology.hl7.org/CodeSystem/v2-0074",
                  code: "RAD",
                },
              ],
            },
          ],
          code: { text: "CT Chest" },
          effectiveDateTime: "2024-03-15",
          conclusion: "No acute cardiopulmonary process.",
          presentedForm: [
            { contentType: "text/plain", data: b64("FINDINGS: Clear lungs.") },
          ],
        },
      },
      {
        resource: {
          resourceType: "DocumentReference",
          id: "docref-1",
          status: "current",
          type: { text: "Radiology Report" },
          date: "2024-06-10",
          content: [
            {
              attachment: {
                contentType: "text/html",
                data: b64("<b>IMPRESSION:</b> Normal ultrasound."),
              },
            },
          ],
        },
      },
    ],
  });
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
         VALUES (?, 'fhir-export.json', '', 'processing', 'fhir')`
      )
      .run(profileId).lastInsertRowid
  );
}

function importInto(profileId: number, docId: number): void {
  const parsed = parseFhirBundle(imagingBundle());
  const input = healthRecordToPersistInput(parsed, "fhir", "FHIR export");
  persistDocumentImport(profileId, docId, input);
}

let profile: number;
let doc: number;

beforeAll(() => {
  profile = newProfile("FHIR-IMAGING");
  doc = newDocument(profile);
  importInto(profile, doc);
});

describe("FHIR imaging mappers land structured studies through the persist core", () => {
  it("persists each FHIR imaging resource as an imaging_studies row with its impression", () => {
    const rows = getDocumentImagingStudies(profile, doc);
    expect(rows).toHaveLength(3);

    const all = getImagingStudies(profile);
    const mri = all.find((s) => s.modality === "mri")!;
    expect(mri.body_region).toBe("Knee");
    expect(mri.laterality).toBe("left");
    expect(mri.impression).toBe("MRI Left Knee");
    expect(mri.indication).toBe("Knee pain");

    const ct = all.find((s) => s.modality === "ct")!;
    expect(ct.impression).toContain("No acute cardiopulmonary process.");
    expect(ct.impression).toContain("Clear lungs");
    expect(ct.study_date).toBe("2024-03-15");

    // The inline-text DocumentReference (HTML stripped to text).
    const docref = all.find(
      (s) => s.impression === "IMPRESSION: Normal ultrasound."
    )!;
    expect(docref).toBeTruthy();

    // Import provenance is stamped so the footprint can clear/move/count it.
    for (const s of all) {
      expect(s.document_id).toBe(doc);
      expect(s.source).toBe(`document:${doc}`);
    }
  });

  it("counts the imaging studies toward extracted_count / producedTotal", () => {
    const counts = getDocumentProduced(profile, doc);
    expect(counts.imagingStudies).toBe(3);
    const total = countImportedDocumentRows(profile, doc);
    expect(producedTotal(counts)).toBe(total);
    const docRow = getMedicalDocument(profile, doc)!;
    expect(docRow.extracted_count).toBe(total);
    expect(total).toBeGreaterThanOrEqual(3);
  });

  it("re-importing the same bundle is idempotent (no duplicate rows)", () => {
    const p = newProfile("FHIR-IMAGING-REIMPORT");
    const d = newDocument(p);
    importInto(p, d);
    importInto(p, d); // reprocess — clears then re-inserts
    expect(getDocumentImagingStudies(p, d)).toHaveLength(3);
  });
});

describe("import footprint: FHIR imaging_studies is cleared / moved by document (#201)", () => {
  it("clearImportedDocumentRows removes them on document delete", () => {
    const p = newProfile("FHIR-IMAGING-CLEAR");
    const d = newDocument(p);
    importInto(p, d);
    expect(getDocumentImagingStudies(p, d)).toHaveLength(3);
    clearImportedDocumentRows(p, d);
    expect(getDocumentImagingStudies(p, d)).toHaveLength(0);
  });

  it("moveImportedDocumentRows re-points them to the destination profile", () => {
    const src = newProfile("FHIR-IMAGING-SRC");
    const dest = newProfile("FHIR-IMAGING-DEST");
    const d = newDocument(src);
    importInto(src, d);
    expect(getImagingStudies(src).length).toBeGreaterThanOrEqual(3);

    moveImportedDocumentRows(src, dest, d);
    expect(getDocumentImagingStudies(dest, d)).toHaveLength(3);
    expect(getDocumentImagingStudies(src, d)).toHaveLength(0);
  });
});
