// DB INTEGRATION TIER — the structured FHIR VisionPrescription mapper (#708 → #697).
//
// Drives a synthetic FHIR bundle carrying a two-eye eyeglass VisionPrescription, a
// contact-lens VisionPrescription, and an unmappable one (no refraction) through the
// REAL deterministic path (parseFhirBundle → healthRecordToPersistInput → the ONE
// persist core), then reads the rows back. Pins that (a) each mappable Rx lands as one
// optical_prescriptions row folding both eyes, with kind/per-eye powers/PD/base-curve/
// prescriber resolved, (b) the unmappable one is dropped (no row), (c) the rows carry
// document_id/source so the import footprint owns them, (d) they count toward
// extracted_count / producedTotal, and (e) they honor the footprint contract — cleared
// on document delete, MOVED on reassign (#201) — since optical_prescriptions joins
// IMPORT_FOOTPRINT_TABLES (#994).
//
// No AI, no network — the bundle is deterministic FHIR JSON. Names are SYNTHETIC
// ("Test Patient", "Dr. Test Optometrist"); every value is clearly fake. Runs against
// a throwaway DB (setup.ts).

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
  getDocumentOpticalPrescriptions,
  getOpticalPrescriptions,
  getMedicalDocument,
} from "@/lib/queries";
import { db } from "@/lib/db";

const PRODUCT =
  "http://terminology.hl7.org/CodeSystem/ex-visionprescriptionproduct";

function visionBundle(): string {
  return JSON.stringify({
    resourceType: "Bundle",
    type: "collection",
    entry: [
      {
        resource: {
          resourceType: "Patient",
          gender: "male",
          birthDate: "1988-08-08",
          name: [{ text: "Test Patient" }],
        },
      },
      // A two-eye eyeglass prescription: product 'lens', per-eye sphere/cylinder/axis/
      // add, a prism on OD, a PD extension, and a referenced prescriber (display).
      {
        resource: {
          resourceType: "VisionPrescription",
          id: "vrx-glasses",
          status: "active",
          dateWritten: "2024-04-01",
          prescriber: {
            reference: "Practitioner/pr-1",
            display: "Dr. Test Optometrist",
          },
          extension: [
            {
              url: "http://example.org/fhir/StructureDefinition/pupillaryDistance",
              valueQuantity: { value: 63, unit: "mm" },
            },
          ],
          lensSpecification: [
            {
              product: { coding: [{ system: PRODUCT, code: "lens" }] },
              eye: "right",
              sphere: -2.0,
              cylinder: -0.5,
              axis: 90,
              add: 1.25,
              prism: [{ amount: 2, base: "up" }],
            },
            {
              product: { coding: [{ system: PRODUCT, code: "lens" }] },
              eye: "left",
              sphere: -1.75,
              cylinder: -0.25,
              axis: 85,
              add: 1.25,
            },
          ],
        },
      },
      // A contact-lens prescription: product 'contact', with backCurve/diameter/brand.
      {
        resource: {
          resourceType: "VisionPrescription",
          id: "vrx-contacts",
          status: "active",
          dateWritten: "2024-05-15",
          lensSpecification: [
            {
              product: { coding: [{ system: PRODUCT, code: "contact" }] },
              eye: "right",
              sphere: -3.0,
              power: -3.0,
              backCurve: 8.6,
              diameter: 14.2,
              brand: "Acme Daily",
            },
            {
              product: { coding: [{ system: PRODUCT, code: "contact" }] },
              eye: "left",
              sphere: -2.75,
              power: -2.75,
              backCurve: 8.6,
              diameter: 14.2,
              brand: "Acme Daily",
            },
          ],
        },
      },
      // Unmappable: a lensSpecification with no refraction and no lens geometry — the
      // mapper drops it (nothing distinguishing to store).
      {
        resource: {
          resourceType: "VisionPrescription",
          id: "vrx-empty",
          status: "active",
          dateWritten: "2024-06-01",
          lensSpecification: [
            {
              product: { coding: [{ system: PRODUCT, code: "lens" }] },
              eye: "right",
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
  const parsed = parseFhirBundle(visionBundle());
  const input = healthRecordToPersistInput(parsed, "fhir", "FHIR export");
  persistDocumentImport(profileId, docId, input);
}

let profile: number;
let doc: number;

beforeAll(() => {
  profile = newProfile("FHIR-VISION");
  doc = newDocument(profile);
  importInto(profile, doc);
});

describe("FHIR VisionPrescription mapper lands structured Rx through the persist core", () => {
  it("persists each mappable VisionPrescription as one folded optical_prescriptions row", () => {
    const rows = getDocumentOpticalPrescriptions(profile, doc);
    // Two mappable (glasses + contacts); the empty one is dropped.
    expect(rows).toHaveLength(2);

    const all = getOpticalPrescriptions(profile);
    const glasses = all.find((p) => p.kind === "glasses")!;
    expect(glasses).toBeTruthy();
    // Per-eye refraction folded from the right/left lensSpecification entries.
    expect(glasses.od_sphere).toBe(-2.0);
    expect(glasses.od_cylinder).toBe(-0.5);
    expect(glasses.od_axis).toBe(90);
    expect(glasses.od_add).toBe(1.25);
    expect(glasses.os_sphere).toBe(-1.75);
    expect(glasses.os_axis).toBe(85);
    expect(glasses.pd).toBe(63);
    expect(glasses.issued_date).toBe("2024-04-01");
    // The prescriber reference resolved into the shared providers registry.
    expect(glasses.provider_id).not.toBeNull();
    // The OD prism is preserved as a note (no prism column).
    expect(glasses.notes).toContain("prism");

    const contacts = all.find((p) => p.kind === "contacts")!;
    expect(contacts).toBeTruthy();
    expect(contacts.od_sphere).toBe(-3.0);
    expect(contacts.os_sphere).toBe(-2.75);
    expect(contacts.base_curve).toBe(8.6);
    expect(contacts.diameter).toBe(14.2);
    expect(contacts.brand).toBe("Acme Daily");
    expect(contacts.issued_date).toBe("2024-05-15");

    // Import provenance is stamped so the footprint can clear/move/count it.
    for (const p of rows) {
      const row = all.find((r) => r.id === p.id)!;
      expect(row.document_id).toBe(doc);
      expect(row.source).toBe(`document:${doc}`);
    }
  });

  it("counts the optical prescriptions toward extracted_count / producedTotal", () => {
    const counts = getDocumentProduced(profile, doc);
    expect(counts.opticalPrescriptions).toBe(2);
    const total = countImportedDocumentRows(profile, doc);
    expect(producedTotal(counts)).toBe(total);
    const docRow = getMedicalDocument(profile, doc)!;
    expect(docRow.extracted_count).toBe(total);
    expect(total).toBeGreaterThanOrEqual(2);
  });

  it("re-importing the same bundle is idempotent (no duplicate rows)", () => {
    const p = newProfile("FHIR-VISION-REIMPORT");
    const d = newDocument(p);
    importInto(p, d);
    importInto(p, d); // reprocess — clears then re-inserts
    expect(getDocumentOpticalPrescriptions(p, d)).toHaveLength(2);
  });
});

describe("import footprint: FHIR optical_prescriptions is cleared / moved by document (#201)", () => {
  it("clearImportedDocumentRows removes them on document delete", () => {
    const p = newProfile("FHIR-VISION-CLEAR");
    const d = newDocument(p);
    importInto(p, d);
    expect(getDocumentOpticalPrescriptions(p, d)).toHaveLength(2);
    clearImportedDocumentRows(p, d);
    expect(getDocumentOpticalPrescriptions(p, d)).toHaveLength(0);
  });

  it("moveImportedDocumentRows re-points them to the destination profile", () => {
    const src = newProfile("FHIR-VISION-SRC");
    const dest = newProfile("FHIR-VISION-DEST");
    const d = newDocument(src);
    importInto(src, d);
    expect(getOpticalPrescriptions(src).length).toBeGreaterThanOrEqual(2);

    moveImportedDocumentRows(src, dest, d);
    expect(getDocumentOpticalPrescriptions(dest, d)).toHaveLength(2);
    expect(getDocumentOpticalPrescriptions(src, d)).toHaveLength(0);
  });
});
