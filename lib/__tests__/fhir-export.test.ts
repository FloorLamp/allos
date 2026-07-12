import { describe, expect, it } from "vitest";
import {
  buildFhirBundle,
  fhirBundleJson,
  type FhirExportInput,
} from "@/lib/fhir-export";
import { parseFhirBundle } from "@/lib/fhir";

// The export is the INVERSE of lib/fhir.ts's import mapping, so the strongest test
// is a round-trip: build a bundle from synthetic passport rows, re-parse it with the
// production importer, and assert the clinical essentials survive. This is what
// keeps the two directions from silently drifting.

const input: FhirExportInput = {
  profile: { name: "Test Patient", sex: "female", birthdate: "1990-02-15" },
  conditions: [
    {
      name: "Essential hypertension",
      code: "I10",
      code_system: "ICD-10-CM",
      status: "active",
      onset_date: "2019-05-01",
      resolved_date: null,
    },
    {
      name: "Acute bronchitis",
      code: "466.0",
      code_system: "ICD-9-CM",
      status: "resolved",
      onset_date: "2015-01-10",
      resolved_date: "2015-02-01",
    },
  ],
  allergies: [
    {
      substance: "Penicillin",
      substance_code: "7980",
      substance_code_system: "SNOMED CT",
      reaction: "Hives",
      severity: "moderate",
      status: "active",
      onset_date: "2010-06-01",
    },
  ],
  procedures: [
    {
      name: "Appendectomy",
      code: "44950",
      code_system: "ICD-10-CM",
      date: "2018-08-20",
    },
  ],
  immunizations: [
    { vaccine: "Influenza", date: "2023-10-01", dose_label: "Dose 1" },
  ],
  observations: [
    {
      name: "Cholesterol",
      value: "190",
      value_num: 190,
      unit: "mg/dL",
      date: "2024-01-05",
    },
    {
      name: "Blood type",
      value: "O+",
      value_num: null,
      unit: null,
      date: "2020-03-03",
    },
  ],
  medications: [
    {
      name: "Lisinopril 10 mg",
      dosage: "1 tablet daily",
      date: "2022-04-01",
      active: true,
    },
  ],
};

describe("buildFhirBundle", () => {
  it("produces a FHIR R4 collection Bundle with one entry per row", () => {
    const bundle = buildFhirBundle(input);
    expect(bundle.resourceType).toBe("Bundle");
    expect(bundle.type).toBe("collection");
    // 1 patient + 2 conditions + 1 allergy + 1 procedure + 1 immunization
    // + 2 observations + 1 medication = 9
    expect(bundle.entry).toHaveLength(9);
    for (const e of bundle.entry) {
      expect(typeof e.resource.resourceType).toBe("string");
      expect(typeof e.resource.id).toBe("string");
      expect(e.fullUrl).toMatch(/^urn:allos:/);
    }
  });

  it("round-trips through the production importer (parseFhirBundle)", () => {
    const result = parseFhirBundle(fhirBundleJson(input));

    // Demographics.
    expect(result.demographics).toMatchObject({
      sex: "female",
      birthdate: "1990-02-15",
      name: "Test Patient",
    });

    // Conditions.
    const htn = result.conditions?.find(
      (c) => c.name === "Essential hypertension"
    );
    expect(htn).toMatchObject({
      code: "I10",
      code_system: "ICD-10-CM",
      status: "active",
      onset_date: "2019-05-01",
    });
    const bronchitis = result.conditions?.find(
      (c) => c.name === "Acute bronchitis"
    );
    expect(bronchitis).toMatchObject({
      status: "resolved",
      onset_date: "2015-01-10",
      resolved_date: "2015-02-01",
    });

    // Allergy.
    expect(result.allergies).toHaveLength(1);
    expect(result.allergies?.[0]).toMatchObject({
      substance: "Penicillin",
      substance_code: "7980",
      substance_code_system: "SNOMED CT",
      reaction: "Hives",
      severity: "moderate",
      status: "active",
      onset_date: "2010-06-01",
    });

    // Procedure.
    expect(result.procedures).toHaveLength(1);
    expect(result.procedures?.[0]).toMatchObject({
      name: "Appendectomy",
      code: "44950",
      code_system: "ICD-10-CM",
      date: "2018-08-20",
    });

    // Immunization (name → catalog slug; the DB stores no CVX so we compare the
    // re-derived code and the date).
    expect(result.immunizations).toHaveLength(1);
    expect(result.immunizations[0].code).toBe("influenza");
    expect(result.immunizations[0].date).toBe("2023-10-01");
    expect(result.immunizations[0].dose_label).toBe("Dose 1");

    // Observations (labs) — separated from medication records by category.
    const labs = result.records.filter((r) => r.category === "lab");
    const chol = labs.find((r) => r.name === "Cholesterol");
    expect(chol).toMatchObject({
      value: "190",
      value_num: 190,
      unit: "mg/dL",
      date: "2024-01-05",
    });
    const bloodType = labs.find((r) => r.name === "Blood type");
    expect(bloodType).toMatchObject({ value: "O+", value_num: null });

    // Medication (a prescription record).
    const meds = result.records.filter((r) => r.category === "prescription");
    expect(meds).toHaveLength(1);
    expect(meds[0]).toMatchObject({
      name: "Lisinopril 10 mg",
      value: "1 tablet daily",
      date: "2022-04-01",
    });
  });

  it("round-trips encounters, family history, care plan and goals (#465)", () => {
    const extended: FhirExportInput = {
      ...input,
      encounters: [
        {
          date: "2024-03-01",
          end_date: "2024-03-01",
          type: "Office Visit",
          class_code: "AMB",
          reason: "Annual physical",
          diagnoses: ["Essential hypertension"],
        },
      ],
      familyHistory: [
        {
          relation: "Mother",
          condition: "Breast cancer",
          code: "C50.9",
          code_system: "ICD-10-CM",
          onset_age: 52,
          deceased: 1,
        },
      ],
      carePlanItems: [
        {
          description: "Low-sodium diet",
          code: null,
          code_system: null,
          category: "diet",
          planned_date: "2024-03-15",
          status: "active",
        },
      ],
      careGoals: [
        {
          description: "Systolic BP under 130",
          code: null,
          code_system: null,
          target_date: "2024-12-31",
          status: "active",
        },
      ],
    };
    const result = parseFhirBundle(fhirBundleJson(extended));

    const enc = result.encounters?.find((e) => e.type === "Office Visit");
    expect(enc).toMatchObject({
      date: "2024-03-01",
      class_code: "AMB",
      reason: "Annual physical",
    });
    expect(enc?.diagnoses).toContain("Essential hypertension");

    expect(result.familyHistory).toHaveLength(1);
    expect(result.familyHistory?.[0]).toMatchObject({
      relation: "Mother",
      condition: "Breast cancer",
      code: "C50.9",
      code_system: "ICD-10-CM",
      onset_age: 52,
      deceased: 1,
    });

    expect(result.carePlanItems).toHaveLength(1);
    expect(result.carePlanItems?.[0]).toMatchObject({
      description: "Low-sodium diet",
      planned_date: "2024-03-15",
    });

    expect(result.careGoals).toHaveLength(1);
    expect(result.careGoals?.[0]).toMatchObject({
      description: "Systolic BP under 130",
      target_date: "2024-12-31",
    });
  });

  it("carries settings-tier clinical facts on the Patient (#465)", () => {
    const bundle = buildFhirBundle({
      ...input,
      profile: {
        name: "Test Patient",
        sex: "female",
        birthdate: "1990-02-15",
        bloodType: "O+",
        emergencyContact: {
          name: "Ada Lovelace",
          phone: "555-0142",
          relation: "Spouse",
        },
        smoking: { status: "former", packYears: 10, quitYear: 2015 },
      },
    });
    const patient = bundle.entry.find(
      (e) => e.resource.resourceType === "Patient"
    )!.resource as Record<string, unknown>;
    const contact = (patient.contact as Record<string, unknown>[])[0];
    expect((contact.name as { text: string }).text).toBe("Ada Lovelace");
    const ext = patient.extension as { url: string; valueString: string }[];
    expect(ext.find((e) => e.url === "urn:allos:blood-type")?.valueString).toBe(
      "O+"
    );
    expect(
      ext.find((e) => e.url === "urn:allos:smoking-history")?.valueString
    ).toContain("former");
    // The importer still recovers the core demographics unchanged.
    const result = parseFhirBundle(JSON.stringify(bundle));
    expect(result.demographics).toMatchObject({
      sex: "female",
      birthdate: "1990-02-15",
    });
  });

  it("omits the Patient entry when no profile is given", () => {
    const bundle = buildFhirBundle({ ...input, profile: null });
    expect(
      bundle.entry.some((e) => e.resource.resourceType === "Patient")
    ).toBe(false);
  });

  it("emits an empty (but valid) Bundle for an empty passport", () => {
    const bundle = buildFhirBundle({
      conditions: [],
      allergies: [],
      procedures: [],
      immunizations: [],
      observations: [],
      medications: [],
    });
    expect(bundle.entry).toHaveLength(0);
    // Still parseable.
    const result = parseFhirBundle(JSON.stringify(bundle));
    expect(result.records).toHaveLength(0);
  });
});
