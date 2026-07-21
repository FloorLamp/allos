import { describe, it, expect } from "vitest";
import { resourcesToImportResult } from "../fhir/bundle";
import { reasonConditionExternalId } from "../fhir/resources";
import {
  suggestIndicationFromText,
  type ConditionRef,
} from "../indication-link";

// #1052 tier-1 (FHIR reasonReference resolution) + tier-2 (text-match suggester).

describe("reasonConditionExternalId (tier-1)", () => {
  const CONDITION = {
    resourceType: "Condition",
    id: "cond-otitis",
    code: {
      text: "Otitis media",
      coding: [{ system: "http://hl7.org/fhir/sid/icd-10-cm", code: "H66.9" }],
    },
    onsetDateTime: "2026-03-01",
  };

  it("MedicationRequest.reasonReference → the imported condition's external_id", () => {
    const out = resourcesToImportResult(
      [
        CONDITION,
        {
          resourceType: "MedicationRequest",
          id: "rx-1",
          status: "active",
          authoredOn: "2026-03-03",
          medicationCodeableConcept: { text: "Amoxicillin 500 mg" },
          reasonReference: [{ reference: "Condition/cond-otitis" }],
        },
      ],
      "fhir"
    );
    const med = out.records.find((r) => r.category === "prescription");
    expect(med?.indication_condition_external_id).toBeTruthy();
    // The condition sink forms the same external_id, so persist can map it locally.
    const cond = (out.conditions ?? []).find((c) => c.name === "Otitis media");
    expect(med?.indication_condition_external_id).toBe(cond?.external_id);
  });

  it("a DANGLING reason reference resolves to null (never a wrong link)", () => {
    const out = resourcesToImportResult(
      [
        {
          resourceType: "MedicationRequest",
          id: "rx-2",
          status: "active",
          authoredOn: "2026-03-03",
          medicationCodeableConcept: { text: "Amoxicillin 500 mg" },
          reasonReference: [{ reference: "Condition/does-not-exist" }],
        },
      ],
      "fhir"
    );
    const med = out.records.find((r) => r.category === "prescription");
    expect(med?.indication_condition_external_id ?? null).toBeNull();
  });

  it("returns null with no ctx", () => {
    expect(
      reasonConditionExternalId({
        reasonReference: [{ reference: "Condition/x" }],
      })
    ).toBeNull();
  });
});

describe("suggestIndicationFromText (tier-2)", () => {
  const conds: ConditionRef[] = [
    { id: 1, name: "Otitis media", code: "H66.9" },
    { id: 2, name: "Hypertension", code: "I10" },
  ];

  it("proposes the condition its indication text word-bound names", () => {
    expect(
      suggestIndicationFromText("Prescribed for otitis media", conds)?.id
    ).toBe(1);
  });

  it("matches a code exactly", () => {
    expect(suggestIndicationFromText("H66.9", conds)?.id).toBe(1);
  });

  it("never links on a spurious substring / drug name only", () => {
    expect(
      suggestIndicationFromText("metformin 500mg daily", conds)
    ).toBeNull();
  });

  it("is null when the text names two distinct conditions (ambiguous)", () => {
    expect(
      suggestIndicationFromText("otitis media and hypertension", conds)
    ).toBeNull();
  });

  it("empty text no-ops", () => {
    expect(suggestIndicationFromText("", conds)).toBeNull();
    expect(suggestIndicationFromText(null, conds)).toBeNull();
  });
});
