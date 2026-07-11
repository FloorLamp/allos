// DB INTEGRATION TIER — a condition that carries an ICD-10-CM code (as filled by the
// #155 entry-time suggestion) must survive a full FHIR export → re-import round-trip
// and be matchable BY CODE (not just by name). This proves the export is no longer
// lossy for coded conditions: collectFhirExportInput reads the stored code, the
// exporter emits the canonical coding, and the production importer recovers it.
//
// Runs against a throwaway DB redirected by lib/__db_tests__/setup.ts. Names are
// SYNTHETIC; the ICD-10-CM codes are public reference data (no PHI).

import { describe, it, expect, beforeAll } from "vitest";
import { collectFhirExportInput } from "@/lib/export-full";
import { buildFhirBundle, fhirBundleJson } from "@/lib/fhir-export";
import { parseFhirBundle } from "@/lib/fhir";
import { db } from "@/lib/db";

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

let profileId: number;

beforeAll(() => {
  profileId = newProfile("FHIR-ROUNDTRIP");
  // A MANUAL condition whose code was filled by the ICD-10-CM suggestion (source
  // NULL, code_system 'ICD-10-CM'), plus an UNCODED manual condition that must still
  // round-trip on text alone.
  db.prepare(
    `INSERT INTO conditions (profile_id, name, code, code_system, status, onset_date, source)
     VALUES (?, 'Unspecified asthma, uncomplicated', 'J45.909', 'ICD-10-CM', 'active', '2020-04-01', NULL)`
  ).run(profileId);
  db.prepare(
    `INSERT INTO conditions (profile_id, name, code, code_system, status, source)
     VALUES (?, 'Synthetic uncoded complaint', NULL, NULL, 'active', NULL)`
  ).run(profileId);
});

describe("FHIR condition export round-trip by code (#155)", () => {
  it("emits an ICD-10-CM coding on the exported Condition when a code is stored", () => {
    const bundle = buildFhirBundle(
      collectFhirExportInput(profileId, "FHIR-ROUNDTRIP")
    );
    const asthma = bundle.entry.find(
      (e) =>
        e.resource.resourceType === "Condition" &&
        (e.resource.code as { text?: string })?.text ===
          "Unspecified asthma, uncomplicated"
    );
    expect(asthma).toBeTruthy();
    const coding = (asthma!.resource.code as { coding?: unknown[] }).coding as
      { system?: string; code?: string }[] | undefined;
    expect(coding?.[0]).toMatchObject({
      system: "http://hl7.org/fhir/sid/icd-10-cm",
      code: "J45.909",
    });
  });

  it("re-imports the coded condition matching by code + system", () => {
    const json = fhirBundleJson(
      collectFhirExportInput(profileId, "FHIR-ROUNDTRIP")
    );
    const result = parseFhirBundle(json);

    const coded = result.conditions?.find((c) => c.code === "J45.909");
    expect(coded).toMatchObject({
      code: "J45.909",
      code_system: "ICD-10-CM",
      status: "active",
      onset_date: "2020-04-01",
    });

    // The uncoded condition still round-trips on its name, with no code.
    const uncoded = result.conditions?.find(
      (c) => c.name === "Synthetic uncoded complaint"
    );
    expect(uncoded).toBeTruthy();
    expect(uncoded?.code ?? null).toBeNull();
  });
});
