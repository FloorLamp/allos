import { describe, expect, it } from "vitest";
import { parseFhirBundle } from "@/lib/fhir";
import {
  procedureExternalId,
  familyHistoryExternalId,
} from "@/lib/clinical-parse";

// Fixture coverage for the two FHIR resource types added here: Procedure and
// FamilyMemberHistory (previously deliberately unmapped). Asserts the mappers
// produce the right rows, that a performed period resolves to a date, that
// FamilyMemberHistory yields one row per condition with onset age + deceased, and
// that an entered-in-error resource is dropped.

function bundle(resources: object[]): string {
  return JSON.stringify({
    resourceType: "Bundle",
    type: "collection",
    entry: resources.map((resource) => ({ resource })),
  });
}

describe("FHIR Procedure → ImportedProcedure", () => {
  it("maps code, performed date, and performer", () => {
    const r = parseFhirBundle(
      bundle([
        {
          resourceType: "Procedure",
          status: "completed",
          code: {
            text: "Appendectomy",
            coding: [
              { system: "http://snomed.info/sct", code: "80146002" },
              { system: "http://www.ama-assn.org/go/cpt", code: "44970" },
            ],
          },
          performedDateTime: "2005-06-12",
          performer: [{ actor: { display: "Dr. Testy Provider" } }],
        },
      ])
    );
    expect(r.procedures).toHaveLength(1);
    const p = r.procedures![0];
    expect(p).toMatchObject({
      name: "Appendectomy",
      code: "80146002", // primary coding (no ICD-10 present)
      date: "2005-06-12",
    });
    expect(p.provider?.name).toContain("Provider");
    expect(p.external_id).toBe(
      procedureExternalId({
        name: "Appendectomy",
        code: "80146002",
        date: "2005-06-12",
      })
    );
  });

  it("resolves a performedPeriod start as the date and drops entered-in-error", () => {
    const r = parseFhirBundle(
      bundle([
        {
          resourceType: "Procedure",
          status: "completed",
          code: { text: "Knee arthroscopy" },
          performedPeriod: { start: "2019-03-01", end: "2019-03-01" },
        },
        {
          resourceType: "Procedure",
          status: "entered-in-error",
          code: { text: "Erroneous procedure" },
          performedDateTime: "2020-01-01",
        },
      ])
    );
    expect(r.procedures!.map((p) => p.name)).toEqual(["Knee arthroscopy"]);
    expect(r.procedures![0].date).toBe("2019-03-01");
  });
});

describe("FHIR FamilyMemberHistory → ImportedFamilyHistory", () => {
  it("maps relationship, one row per condition, onset age, and deceased", () => {
    const r = parseFhirBundle(
      bundle([
        {
          resourceType: "FamilyMemberHistory",
          status: "completed",
          relationship: {
            text: "Mother",
            coding: [
              {
                system: "http://terminology.hl7.org/CodeSystem/v3-RoleCode",
                code: "MTH",
              },
            ],
          },
          deceasedBoolean: true,
          condition: [
            {
              code: {
                text: "Breast cancer",
                coding: [
                  { system: "http://snomed.info/sct", code: "254837009" },
                ],
              },
              onsetAge: { value: 60, unit: "a" },
            },
            {
              code: { text: "Hypertension" },
            },
          ],
        },
      ])
    );
    expect(r.familyHistory).toHaveLength(2);
    const cancer = r.familyHistory!.find((f) => /breast/i.test(f.condition))!;
    expect(cancer).toMatchObject({
      relation: "Mother",
      code: "254837009",
      code_system: "SNOMED CT",
      onset_age: 60,
      deceased: 1,
    });
    expect(cancer.external_id).toBe(
      familyHistoryExternalId({
        relation: "Mother",
        condition: "Breast cancer",
        code: "254837009",
      })
    );
    // The uncoded second condition still imports (deceased inherited from the
    // resource).
    const htn = r.familyHistory!.find((f) =>
      /hypertension/i.test(f.condition)
    )!;
    expect(htn).toMatchObject({ relation: "Mother", code: null, deceased: 1 });
  });
});
