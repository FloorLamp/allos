import { describe, it, expect } from "vitest";
import { resourcesToImportResult } from "../fhir/bundle";
import { encounterRefExternalId } from "../fhir/resources";

// Tier-1 FHIR encounter-reference resolution (#1050). A MedicationRequest /
// Observation / Immunization / Procedure whose `encounter` reference resolves within
// the bundle to an imported Encounter carries that visit's external_id through to
// persist; a DANGLING reference resolves to null — never a wrong link. The visit
// diagnosis (Encounter.diagnosis[].condition) tags the resolved condition row.

const ENCOUNTER = {
  resourceType: "Encounter",
  id: "visit-1",
  status: "finished",
  period: { start: "2026-03-03" },
  type: [{ text: "Office Visit" }],
};

describe("encounter-reference resolution", () => {
  it("MedicationRequest.encounter → the imported visit's external_id", () => {
    const out = resourcesToImportResult(
      [
        ENCOUNTER,
        {
          resourceType: "MedicationRequest",
          id: "rx-1",
          status: "active",
          authoredOn: "2026-03-03",
          medicationCodeableConcept: { text: "Amoxicillin 500 mg" },
          encounter: { reference: "Encounter/visit-1" },
        },
      ],
      "fhir"
    );
    const med = out.records.find((r) => r.category === "prescription");
    expect(med?.encounter_external_id).toBe("ccda:encounter:visit-1");
  });

  it("Observation.encounter (a lab) resolves too", () => {
    const out = resourcesToImportResult(
      [
        ENCOUNTER,
        {
          resourceType: "Observation",
          id: "obs-1",
          status: "final",
          effectiveDateTime: "2026-03-03",
          code: {
            coding: [{ system: "http://loinc.org", code: "2345-7" }],
            text: "Glucose",
          },
          valueQuantity: { value: 95, unit: "mg/dL" },
          encounter: { reference: "Encounter/visit-1" },
        },
      ],
      "fhir"
    );
    expect(
      out.records.some(
        (r) => r.encounter_external_id === "ccda:encounter:visit-1"
      )
    ).toBe(true);
  });

  it("a DANGLING encounter reference resolves to null (never a wrong link)", () => {
    const out = resourcesToImportResult(
      [
        {
          resourceType: "MedicationRequest",
          id: "rx-2",
          status: "active",
          authoredOn: "2026-03-03",
          medicationCodeableConcept: { text: "Lisinopril 10 mg" },
          encounter: { reference: "Encounter/does-not-exist" },
        },
      ],
      "fhir"
    );
    const med = out.records.find((r) => r.category === "prescription");
    expect(med).toBeDefined();
    expect(med?.encounter_external_id ?? null).toBeNull();
  });

  it("no encounter field ⇒ null", () => {
    expect(
      encounterRefExternalId({ resourceType: "MedicationRequest" })
    ).toBeNull();
  });

  it("visit diagnosis: Encounter.diagnosis[].condition tags the imported condition", () => {
    const out = resourcesToImportResult(
      [
        {
          ...ENCOUNTER,
          diagnosis: [{ condition: { reference: "Condition/cond-1" } }],
        },
        {
          resourceType: "Condition",
          id: "cond-1",
          code: { text: "Acute sinusitis" },
        },
      ],
      "fhir"
    );
    const cond = (out.conditions ?? []).find(
      (c) => c.name === "Acute sinusitis"
    );
    expect(cond?.encounter_external_id).toBe("ccda:encounter:visit-1");
    // The transient tagging field is dropped from the persisted encounter shape.
    expect(
      (
        (out.encounters ?? [])[0] as {
          diagnosis_condition_external_ids?: unknown;
        }
      )?.diagnosis_condition_external_ids
    ).toBeUndefined();
  });
});
