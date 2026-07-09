import { describe, expect, it } from "vitest";
import { parseFhirBundle, FhirError } from "@/lib/fhir";

function bundle(entries: object[]): string {
  return JSON.stringify({
    resourceType: "Bundle",
    type: "collection",
    entry: entries.map((resource) => ({ resource })),
  });
}

const immunization = (cvx: string, date: string, extra: object = {}) => ({
  resourceType: "Immunization",
  status: "completed",
  vaccineCode: {
    coding: [{ system: "http://hl7.org/fhir/sid/cvx", code: cvx }],
  },
  occurrenceDateTime: date,
  ...extra,
});

describe("parseFhirBundle", () => {
  it("maps Immunization + Observation + Patient with the fhir id prefix", () => {
    const text = bundle([
      {
        resourceType: "Patient",
        gender: "female",
        birthDate: "1991-07-14",
        name: [{ given: ["Ada"], family: "Lovelace" }],
      },
      immunization("208", "2021-03-01", {
        lotNumber: "ABC",
        protocolApplied: [{ doseNumberPositiveInt: 1 }],
      }),
      immunization("08", "2010-06-15"),
      {
        resourceType: "Observation",
        status: "final",
        code: {
          text: "Systolic blood pressure",
          coding: [{ system: "http://loinc.org", code: "8480-6" }],
        },
        valueQuantity: { value: 118, unit: "mm[Hg]" },
        effectiveDateTime: "2024-01-10",
      },
      // Unmapped resource types are ignored, not an error.
      { resourceType: "Provenance", target: [{ reference: "Patient/1" }] },
    ]);
    const r = parseFhirBundle(text);

    expect(r.immunizations.map((i) => i.code)).toEqual(["hepb", "covid"]); // sorted by date
    const covid = r.immunizations.find((i) => i.code === "covid")!;
    expect(covid.dose_label).toBe("Dose 1");
    expect(covid.notes).toBe("Lot ABC");
    expect(covid.external_id).toBe("fhir:covid:2021-03-01");

    expect(r.records).toHaveLength(1);
    expect(r.records[0]).toMatchObject({
      // Systolic BP (LOINC 8480-6) is a vital sign, not a lab — classified by
      // LOINC since a FHIR Observation has no section context.
      category: "vitals",
      canonical: "Blood Pressure Systolic", // LOINC → canonical
      value_num: 118,
      // Value is part of the dedup key so two same-day BPs stay distinct.
      external_id: "fhir:vital:8480-6:2024-01-10:118",
    });

    expect(r.demographics).toEqual({
      sex: "female",
      birthdate: "1991-07-14",
      name: "Ada Lovelace",
    });
  });

  it("uses HumanName.text when present", () => {
    const r = parseFhirBundle(
      bundle([
        { resourceType: "Patient", name: [{ text: "Grace M. Hopper" }] },
        immunization("08", "2010-06-15"),
      ])
    );
    expect(r.demographics).toEqual({
      sex: null,
      birthdate: null,
      name: "Grace M. Hopper",
    });
  });

  it("skips discarded immunizations and dedupes repeats", () => {
    const r = parseFhirBundle(
      bundle([
        immunization("08", "2010-06-15"),
        immunization("08", "2010-06-15"),
        immunization("213", "2022-01-01", { status: "entered-in-error" }),
      ])
    );
    expect(r.immunizations).toHaveLength(1);
    expect(r.immunizations[0].code).toBe("hepb");
  });

  it("drops retracted Observations and classifies vitals vs labs by LOINC", () => {
    const r = parseFhirBundle(
      bundle([
        // A lab (unmapped LOINC) — stays category "lab".
        {
          resourceType: "Observation",
          status: "final",
          code: {
            text: "Hemoglobin A1c",
            coding: [{ system: "http://loinc.org", code: "4548-4" }],
          },
          valueQuantity: { value: 5.4, unit: "%" },
          effectiveDateTime: "2024-02-01",
        },
        // Heart rate (LOINC 8867-4) — a vital sign.
        {
          resourceType: "Observation",
          status: "final",
          code: { coding: [{ system: "http://loinc.org", code: "8867-4" }] },
          valueQuantity: { value: 60, unit: "/min" },
          effectiveDateTime: "2024-02-01",
        },
        // Retracted reading — must be dropped.
        {
          resourceType: "Observation",
          status: "entered-in-error",
          code: { coding: [{ system: "http://loinc.org", code: "8867-4" }] },
          valueQuantity: { value: 999, unit: "/min" },
          effectiveDateTime: "2024-02-01",
        },
      ])
    );
    expect(r.records).toHaveLength(2);
    expect(r.records.find((x) => x.name === "Hemoglobin A1c")?.category).toBe(
      "lab"
    );
    const hr = r.records.find((x) => x.canonical === "Resting Heart Rate");
    expect(hr?.category).toBe("vitals");
    expect(r.records.some((x) => x.value_num === 999)).toBe(false);
  });

  it("returns null demographics when no Patient / no birthDate+gender", () => {
    expect(
      parseFhirBundle(bundle([immunization("08", "2010-06-15")])).demographics
    ).toBeNull();
  });

  it("throws on bad JSON or a non-Bundle resource", () => {
    expect(() => parseFhirBundle("{bad")).toThrow(FhirError);
    expect(() =>
      parseFhirBundle(JSON.stringify({ resourceType: "Immunization" }))
    ).toThrow(FhirError);
  });
});
