// DB INTEGRATION TIER — AI-extraction clinical-domain parity (#412).
//
// Proves the AI document-extraction path now lands the SAME clinical domains the
// deterministic CCD/FHIR path always did — conditions, allergies, procedures,
// encounters, family history, care-plan items + goals — by driving a fixture
// ExtractionResult through the REAL adapter (extractionToPersistInput) and the ONE
// persist core (persistDocumentImport), then reading the rows back through the same
// document queries the UI uses. Also pins that (a) extracted_count / producedTotal
// reflect the new kinds (so a clinical-only scan no longer imports "0 records"), (b)
// meta.source is registered as a provider, and (c) a real import report lands.
//
// No real AI calls — the fixture is a synthetic ExtractionResult with clearly-fake
// PHI. Runs against a throwaway DB redirected by lib/__db_tests__/setup.ts.

import { describe, it, expect, beforeAll } from "vitest";
import {
  getDocumentProduced,
  getDocumentVisits,
  getDocumentConditions,
  getDocumentAllergies,
  getDocumentProcedures,
  getDocumentFamilyHistory,
  getDocumentCarePlanItems,
  getDocumentCareGoals,
  getMedicalDocument,
} from "@/lib/queries";
import {
  persistDocumentImport,
  countImportedDocumentRows,
} from "@/lib/import-persist";
import { producedTotal } from "@/lib/import-log";
import { extractionToPersistInput } from "@/lib/import-shape";
import type { ExtractionResult } from "@/lib/medical-extract";
import { parseImportReport } from "@/lib/import-report";
import { db } from "@/lib/db";

// A synthetic after-visit-summary extraction: NO numeric analytes, only clinical
// entities — exactly the document that used to import "0 records".
function clinicalExtraction(): Extract<ExtractionResult, { status: "done" }> {
  return {
    status: "done",
    model: "claude-test",
    raw: "RAW",
    meta: {
      document_type: "other",
      source: "Sample Health System",
      patient_name: "Test Patient",
      patient_sex: null,
      patient_birthdate: null,
      patient_age: null,
      document_date: "2024-03-15",
    },
    results: [],
    immunizations: [],
    conditions: [
      {
        name: "Type 2 diabetes mellitus",
        code: "E11.9",
        code_system: "ICD-10-CM",
        status: "Active",
        onset_date: "2019-05-01",
        resolved_date: null,
      },
    ],
    allergies: [
      {
        substance: "Penicillin",
        substance_code: null,
        substance_code_system: null,
        reaction: "Hives",
        severity: "moderate",
        status: null,
        onset_date: null,
      },
    ],
    procedures: [
      {
        name: "Appendectomy",
        code: "44970",
        code_system: "CPT",
        date: "2010-08-01",
      },
    ],
    encounters: [
      {
        date: "2024-03-15",
        end_date: "2024-03-15",
        type: "Office Visit",
        class_code: "AMB",
        reason: "Follow-up",
        diagnoses: ["Type 2 diabetes mellitus"],
        provider: "Grace Hopper, MD",
        location: "Sample Health System",
        notes: null,
      },
    ],
    familyHistory: [
      {
        relation: "mother",
        condition: "Breast cancer",
        code: null,
        code_system: null,
        onset_age: 52,
        deceased: 1,
      },
    ],
    carePlanItems: [
      {
        description: "Order HbA1c in 3 months",
        code: null,
        code_system: null,
        category: "observation",
        planned_date: "2024-06-15",
        status: "planned",
      },
    ],
    careGoals: [
      {
        description: "A1c < 7.0%",
        code: null,
        code_system: null,
        target_date: null,
        status: "active",
      },
    ],
    // One rejected entity, so the report has a drop to account for.
    drops: [
      { kind: "allergy", label: "(unnamed allergy)", reason: "no_value" },
    ],
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
         VALUES (?, 'after-visit.pdf', '', 'processing', 'other')`
      )
      .run(profileId).lastInsertRowid
  );
}

let profile: number;
let doc: number;

beforeAll(() => {
  profile = newProfile("PARITY");
  doc = newDocument(profile);
  persistDocumentImport(
    profile,
    doc,
    extractionToPersistInput(clinicalExtraction(), "2024-03-15")
  );
});

describe("AI extraction lands clinical domains through the persist core", () => {
  it("persists each clinical domain, readable through the document queries", () => {
    expect(getDocumentConditions(profile, doc).map((c) => c.name)).toEqual([
      "Type 2 diabetes mellitus",
    ]);
    expect(getDocumentAllergies(profile, doc).map((a) => a.substance)).toEqual([
      "Penicillin",
    ]);
    expect(getDocumentProcedures(profile, doc).map((p) => p.name)).toEqual([
      "Appendectomy",
    ]);
    expect(getDocumentVisits(profile, doc).map((e) => e.type)).toEqual([
      "Office Visit",
    ]);
    expect(
      getDocumentFamilyHistory(profile, doc).map((f) => f.condition)
    ).toEqual(["Breast cancer"]);
    expect(
      getDocumentCarePlanItems(profile, doc).map((c) => c.description)
    ).toEqual(["Order HbA1c in 3 months"]);
    expect(
      getDocumentCareGoals(profile, doc).map((g) => g.description)
    ).toEqual(["A1c < 7.0%"]);
  });

  it("normalizes allergy/condition status to the CHECK set", () => {
    expect(getDocumentConditions(profile, doc)[0].status).toBe("active");
    expect(getDocumentAllergies(profile, doc)[0].status).toBe("active");
  });

  it("resolves the encounter's provider + facility into the shared registry", () => {
    const row = db
      .prepare(
        `SELECT p.name AS provider_name, l.name AS location_name
           FROM encounters e
           LEFT JOIN providers p ON p.id = e.provider_id
           LEFT JOIN providers l ON l.id = e.location_provider_id
          WHERE e.profile_id = ? AND e.document_id = ?`
      )
      .get(profile, doc) as {
      provider_name: string | null;
      location_name: string | null;
    };
    expect(row.provider_name).toBe("Grace Hopper, MD");
    expect(row.location_name).toBe("Sample Health System");
  });

  it("counts the clinical rows toward extracted_count (not '0 records')", () => {
    const counts = getDocumentProduced(profile, doc);
    // 1 each of 7 clinical kinds; 0 medical_records/labs.
    expect(counts.recordsByCategory).toEqual([]);
    expect(counts.conditions).toBe(1);
    expect(counts.allergies).toBe(1);
    expect(counts.procedures).toBe(1);
    expect(counts.encounters).toBe(1);
    expect(counts.familyHistory).toBe(1);
    expect(counts.carePlanItems).toBe(1);
    expect(counts.careGoals).toBe(1);
    // The registered document-source provider is visible in the breakdown.
    expect(counts.providers).toBeGreaterThanOrEqual(1);

    const total = countImportedDocumentRows(profile, doc);
    expect(total).toBe(7);
    expect(producedTotal(counts)).toBe(7);
    const docRow = getMedicalDocument(profile, doc)!;
    expect(docRow.extracted_count).toBe(7);
  });

  it("stores a real import report with the extraction's drop accounting", () => {
    const docRow = getMedicalDocument(profile, doc)!;
    const report = parseImportReport(docRow.import_report ?? null);
    expect(report).not.toBeNull();
    expect(report!.imported).toBe(7);
    expect(report!.drops).toEqual([
      { kind: "allergy", label: "(unnamed allergy)", reason: "no_value" },
    ]);
  });
});
