// DB INTEGRATION TIER — the FHIR importer must NOT persist non-analyte
// administrative rows or derived anthropometric percentiles as lab records (#693).
//
// The CDA path already drops these before persistence; before this fix the FHIR
// path kept them AND (because the shared isUnmappedLabLoinc excludes them) hid them
// from the unmapped-code coverage report — a junk lab row that no maintainer could
// see. This proves the fix end-to-end: parse a synthetic bundle carrying an
// administrative code (45374-6 Specimen Expiration Date) and a derived percentile
// (59576-9 BMI percentile) alongside a real analyte, run it through the production
// shape converter + persister, and assert only the analyte reaches medical_records.
//
// Runs against a throwaway DB redirected by lib/__db_tests__/setup.ts. All values
// synthetic (no PHI).

import { describe, it, expect, beforeAll } from "vitest";
import { parseFhirBundle } from "@/lib/fhir";
import { healthRecordToPersistInput } from "@/lib/import-shape";
import { persistDocumentImport } from "@/lib/import-persist";
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
         VALUES (?, 'labs.json', '', 'processing', 'fhir')`
      )
      .run(profileId).lastInsertRowid
  );
}

const BUNDLE = JSON.stringify({
  resourceType: "Bundle",
  type: "collection",
  entry: [
    {
      resource: {
        resourceType: "Observation",
        status: "final",
        code: {
          text: "Glucose",
          coding: [{ system: "http://loinc.org", code: "2345-7" }],
        },
        valueQuantity: { value: 95, unit: "mg/dL" },
        effectiveDateTime: "2026-06-01",
      },
    },
    {
      resource: {
        resourceType: "Observation",
        status: "final",
        code: {
          text: "Specimen Expiration Date",
          coding: [{ system: "http://loinc.org", code: "45374-6" }],
        },
        valueString: "2026-06-30",
        effectiveDateTime: "2026-06-01",
      },
    },
    {
      resource: {
        resourceType: "Observation",
        status: "final",
        code: {
          text: "BMI percentile",
          coding: [{ system: "http://loinc.org", code: "59576-9" }],
        },
        valueQuantity: { value: 62, unit: "%" },
        effectiveDateTime: "2026-06-01",
      },
    },
  ],
});

let profileId: number;
let docId: number;

beforeAll(() => {
  profileId = newProfile("FHIR-NOISE");
  docId = newDocument(profileId);
  const parsed = parseFhirBundle(BUNDLE);
  persistDocumentImport(
    profileId,
    docId,
    healthRecordToPersistInput(parsed, "fhir", "fhir")
  );
});

describe("FHIR non-analyte / derived-percentile drop, end-to-end (#693)", () => {
  it("persists only the real analyte to medical_records", () => {
    const rows = db
      .prepare(
        "SELECT name FROM medical_records WHERE profile_id = ? ORDER BY name"
      )
      .all(profileId) as { name: string }[];
    expect(rows.map((r) => r.name)).toEqual(["Glucose"]);
  });

  it("persists exactly one record — the two noise observations never land", () => {
    const total = db
      .prepare("SELECT COUNT(*) AS n FROM medical_records WHERE profile_id = ?")
      .get(profileId) as { n: number };
    expect(total.n).toBe(1);
    // And neither administrative-name row survives under its printed name.
    const byNoiseName = db
      .prepare(
        "SELECT COUNT(*) AS n FROM medical_records WHERE profile_id = ? AND name IN ('Specimen Expiration Date', 'BMI percentile')"
      )
      .get(profileId) as { n: number };
    expect(byNoiseName.n).toBe(0);
  });
});
