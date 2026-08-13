// DB INTEGRATION TIER — a FHIR component-level refusal must reach the STORED import
// report (#2411), not just fail to become a row.
//
// A blood pressure ships its numbers in `component[]`. When one component is unusable
// the mapper used to skip it with a bare `continue`: the systolic imported, the
// diastolic vanished, and the document's import report said nothing at all — the
// Dropped list did not show it and `considered` did not count it, so kept-vs-considered
// silently lied. The row-level path has always reported every one of these.
//
// Asserted through the REAL persist path (parseFhirBundle → healthRecordToPersistInput
// → persistDocumentImport), because `considered` is rebound onto the live footprint
// tally in that same UPDATE — the accounting only exists once the report is stored.
//
// Runs against a throwaway DB redirected by lib/__db_tests__/setup.ts. SYNTHETIC ONLY:
// invented patient, fictional dates, low-entropy values. No PHI.

import { describe, it, expect, beforeAll } from "vitest";
import { parseFhirBundle } from "@/lib/fhir";
import { healthRecordToPersistInput } from "@/lib/import-shape";
import { persistDocumentImport } from "@/lib/import-persist";
import { parseImportReport } from "@/lib/import-report";
import { db } from "@/lib/db";

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
         VALUES (?, 'vitals.json', '', 'processing', 'fhir')`
      )
      .run(profileId).lastInsertRowid
  );
}

// One BP panel: a good systolic beside a diastolic the source itself declares absent.
const BUNDLE = JSON.stringify({
  resourceType: "Bundle",
  type: "collection",
  entry: [
    {
      resource: {
        resourceType: "Observation",
        status: "final",
        code: {
          text: "Blood pressure panel",
          coding: [{ system: "http://loinc.org", code: "85354-9" }],
        },
        effectiveDateTime: "2026-06-01",
        component: [
          {
            code: {
              text: "Systolic",
              coding: [{ system: "http://loinc.org", code: "8480-6" }],
            },
            valueQuantity: { value: 116, unit: "mm[Hg]" },
          },
          {
            code: {
              text: "Diastolic",
              coding: [{ system: "http://loinc.org", code: "8462-4" }],
            },
            dataAbsentReason: {
              coding: [
                {
                  system:
                    "http://terminology.hl7.org/CodeSystem/data-absent-reason",
                  code: "not-performed",
                },
              ],
            },
          },
        ],
      },
    },
  ],
});

let profileId: number;
let docId: number;

beforeAll(() => {
  profileId = newProfile("FHIR-COMPONENT-DROP");
  docId = newDocument(profileId);
  const parsed = parseFhirBundle(BUNDLE);
  persistDocumentImport(
    profileId,
    docId,
    healthRecordToPersistInput(parsed, "fhir", "fhir")
  );
});

function storedReport() {
  const raw = db
    .prepare(
      "SELECT import_report FROM medical_documents WHERE id = ? AND profile_id = ?"
    )
    .get(docId, profileId) as { import_report: string | null };
  return parseImportReport(raw.import_report);
}

describe("a FHIR component refusal reaches the import report (#2411)", () => {
  it("keeps the valued component — a refused sibling takes nothing down with it", () => {
    const rows = db
      .prepare(
        "SELECT canonical_name AS canon, value_num FROM medical_records WHERE profile_id = ?"
      )
      .all(profileId) as { canon: string; value_num: number | null }[];
    expect(rows).toEqual([
      { canon: "Blood Pressure Systolic", value_num: 116 },
    ]);
  });

  it("reports the refused component under its OWN label and reason", () => {
    const report = storedReport()!;
    const drop = report.drops.find((d) => d.label === "Diastolic");
    expect(drop).toMatchObject({ kind: "vitals", reason: "null_flavor" });
    // Never the parent panel's name — that would report a candidate that was kept.
    expect(report.drops.some((d) => d.label === "Blood pressure panel")).toBe(
      false
    );
  });

  it("counts it into `considered`, so kept-vs-considered stays true", () => {
    const report = storedReport()!;
    expect(report.imported).toBe(1);
    expect(report.considered).toBe(2);
  });
});
