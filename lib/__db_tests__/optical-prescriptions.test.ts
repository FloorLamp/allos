// DB INTEGRATION TIER — structured optical prescriptions (#697).
//
// Drives a synthetic Rx-slip extraction through the REAL adapter
// (extractionToPersistInput) and the ONE persist core (persistDocumentImport), then
// reads it back through the document queries the UI uses. Pins that (a) prescriptions
// land as structured rows with the raw kind normalized and the per-eye powers / axis
// / distances parsed off the Rx notation, (b) they count toward extracted_count /
// producedTotal, (c) they honor the import footprint contract — cleared on document
// delete, MOVED on reassign (#201) — since optical_prescriptions joins
// IMPORT_FOOTPRINT_TABLES, and (d) the prescriber resolves into the shared providers
// registry (linked via provider_id).
//
// No real AI calls — the fixture is a synthetic ExtractionResult with clearly-fake
// PHI (a fictional "Test Patient" / prescriber). Runs against a throwaway DB.

import { describe, it, expect, beforeAll } from "vitest";
import {
  getDocumentProduced,
  getDocumentOpticalPrescriptions,
  getOpticalPrescriptions,
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
import type { ExtractionResult } from "@/lib/medical-extract";
import { db } from "@/lib/db";

// A synthetic optical Rx slip: one glasses Rx (both eyes, prescriber named) and one
// contacts Rx, plus one empty prescription that must drop. Loose notation
// ("plano", "+1.00", a "soft toric" kind) exercises the parser/normalizer.
function opticalExtraction(): Extract<ExtractionResult, { status: "done" }> {
  return {
    status: "done",
    model: "claude-test",
    raw: "RAW",
    meta: {
      document_type: "other",
      source: "Test Vision Center",
      patient_name: "Test Patient",
      patient_sex: null,
      patient_birthdate: null,
      patient_age: null,
      document_date: "2026-03-01",
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
    opticalPrescriptions: [
      {
        kind: "glasses",
        od_sphere: "-2.00",
        od_cylinder: "-0.75",
        od_axis: "90",
        od_add: "+1.00",
        os_sphere: "plano",
        os_cylinder: null,
        os_axis: null,
        os_add: null,
        pd: "63",
        base_curve: null,
        diameter: null,
        brand: null,
        issued_date: "2026-03-01",
        expiry_date: "2028-03-01",
        prescriber: "Ada Lovelace, OD",
        notes: null,
      },
      {
        kind: "soft toric contacts",
        od_sphere: "-3.25",
        od_cylinder: null,
        od_axis: null,
        od_add: null,
        os_sphere: "-3.00",
        os_cylinder: null,
        os_axis: null,
        os_add: null,
        pd: null,
        base_curve: "8.6",
        diameter: "14.2",
        brand: "Acuvue",
        issued_date: "2026-03-01",
        expiry_date: null,
        prescriber: null,
        notes: null,
      },
      // Empty prescription — no kind, no sphere on either eye — must drop.
      {
        kind: null,
        od_sphere: null,
        od_cylinder: null,
        od_axis: null,
        od_add: null,
        os_sphere: null,
        os_cylinder: null,
        os_axis: null,
        os_add: null,
        pd: null,
        base_curve: null,
        diameter: null,
        brand: null,
        issued_date: null,
        expiry_date: null,
        prescriber: null,
        notes: null,
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
         VALUES (?, 'rx-slip.pdf', '', 'processing', 'other')`
      )
      .run(profileId).lastInsertRowid
  );
}

let profile: number;
let doc: number;

beforeAll(() => {
  profile = newProfile("OPTICAL");
  doc = newDocument(profile);
  persistDocumentImport(
    profile,
    doc,
    extractionToPersistInput(opticalExtraction(), "2026-03-01")
  );
});

describe("AI extraction lands optical prescriptions through the persist core", () => {
  it("persists each Rx with kind normalized and powers parsed", () => {
    const all = getOpticalPrescriptions(profile);
    expect(all.map((r) => r.kind).sort()).toEqual(["contacts", "glasses"]);

    const glasses = all.find((r) => r.kind === "glasses")!;
    expect(glasses.od_sphere).toBe(-2);
    expect(glasses.od_cylinder).toBe(-0.75);
    expect(glasses.od_axis).toBe(90);
    expect(glasses.od_add).toBe(1);
    expect(glasses.os_sphere).toBe(0); // "plano" → 0
    expect(glasses.pd).toBe(63);
    expect(glasses.expiry_date).toBe("2028-03-01");
    // The prescriber resolved into the providers registry.
    expect(glasses.provider_id).not.toBeNull();
    // Import provenance is stamped so the footprint can clear/move/count it.
    expect(glasses.document_id).toBe(doc);
    expect(glasses.source).toBe(`document:${doc}`);

    const contacts = all.find((r) => r.kind === "contacts")!;
    expect(contacts.base_curve).toBe(8.6);
    expect(contacts.diameter).toBe(14.2);
    expect(contacts.brand).toBe("Acuvue");
  });

  it("drops an empty prescription (no kind, no sphere)", () => {
    expect(getDocumentOpticalPrescriptions(profile, doc)).toHaveLength(2);
  });

  it("counts the prescriptions toward extracted_count / producedTotal", () => {
    const counts = getDocumentProduced(profile, doc);
    expect(counts.opticalPrescriptions).toBe(2);
    const total = countImportedDocumentRows(profile, doc);
    expect(producedTotal(counts)).toBe(total);
    const docRow = getMedicalDocument(profile, doc)!;
    expect(docRow.extracted_count).toBe(total);
    expect(total).toBeGreaterThanOrEqual(2);
  });
});

describe("import footprint: optical_prescriptions is cleared / moved by document", () => {
  it("clearImportedDocumentRows removes them on document delete", () => {
    const p = newProfile("OPTICAL-CLEAR");
    const d = newDocument(p);
    persistDocumentImport(
      p,
      d,
      extractionToPersistInput(opticalExtraction(), "2026-03-01")
    );
    expect(getDocumentOpticalPrescriptions(p, d)).toHaveLength(2);
    clearImportedDocumentRows(p, d);
    expect(getDocumentOpticalPrescriptions(p, d)).toHaveLength(0);
  });

  it("moveImportedDocumentRows re-points them to the destination profile (#201)", () => {
    const src = newProfile("OPTICAL-SRC");
    const dest = newProfile("OPTICAL-DEST");
    const d = newDocument(src);
    persistDocumentImport(
      src,
      d,
      extractionToPersistInput(opticalExtraction(), "2026-03-01")
    );
    expect(getOpticalPrescriptions(src).length).toBeGreaterThanOrEqual(2);

    moveImportedDocumentRows(src, dest, d);
    expect(getDocumentOpticalPrescriptions(dest, d)).toHaveLength(2);
    expect(getDocumentOpticalPrescriptions(src, d)).toHaveLength(0);
    expect(
      getOpticalPrescriptions(dest)
        .map((r) => r.kind)
        .sort()
    ).toEqual(["contacts", "glasses"]);
  });
});
