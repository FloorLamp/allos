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

  // #693: the FHIR importer must drop non-analyte administrative rows and derived
  // anthropometric percentiles just like the CDA path — otherwise they persist as
  // junk lab records that no longer even show up in the unmapped-code report (the
  // shared isUnmappedLabLoinc excludes them). Fixtures synthetic.
  it("drops non-analyte + derived-percentile observations, keeps the real analyte (#693)", () => {
    const r = parseFhirBundle(
      bundle([
        {
          resourceType: "Observation",
          status: "final",
          code: {
            text: "Glucose",
            coding: [{ system: "http://loinc.org", code: "2345-7" }],
          },
          valueQuantity: { value: 95, unit: "mg/dL" },
          effectiveDateTime: "2026-06-01",
        },
        {
          resourceType: "Observation",
          status: "final",
          code: {
            text: "Specimen Expiration Date",
            coding: [{ system: "http://loinc.org", code: "45374-6" }],
          },
          valueString: "2026-06-30",
          effectiveDateTime: "2026-06-01",
        },
        {
          resourceType: "Observation",
          status: "final",
          code: {
            text: "BMI percentile",
            coding: [{ system: "http://loinc.org", code: "59576-9" }],
          },
          valueQuantity: { value: 62, unit: "%" },
          effectiveDateTime: "2026-06-01",
        },
      ])
    );
    // Only the real analyte imports.
    expect(r.records.map((x) => x.name)).toEqual(["Glucose"]);
    // Neither administrative noise nor the percentile leaks into the unmapped-code
    // report (the exact regression #693 describes for the FHIR path).
    expect(r.report!.unmappedLoincs).toEqual([]);
    // The drops are classified precisely, not as generic no_value.
    const specimen = r.report!.drops.find(
      (d) => d.label === "Specimen Expiration Date"
    );
    expect(specimen?.reason).toBe("non_analyte");
    const pct = r.report!.drops.find((d) => d.label === "BMI percentile");
    expect(pct?.reason).toBe("derived_percentile");
  });

  // ---- Structured imaging mappers (#708 → #702) ----

  const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

  it("maps an ImagingStudy → a study row with modality/body region/laterality (#708)", () => {
    const r = parseFhirBundle(
      bundle([
        {
          resourceType: "ImagingStudy",
          id: "study-1",
          status: "available",
          started: "2024-05-02T10:00:00Z",
          modality: [
            {
              system: "http://dicom.nema.org/resources/ontology/DCM",
              code: "MR",
              display: "Magnetic Resonance",
            },
          ],
          description: "MRI Left Knee",
          numberOfSeries: 3,
          reasonCode: [{ text: "Knee pain" }],
          series: [
            {
              modality: { code: "MR" },
              bodySite: { display: "Knee" },
              laterality: { code: "7771000", display: "Left" },
            },
          ],
        },
      ])
    );
    expect(r.imagingStudies).toHaveLength(1);
    expect(r.imagingStudies![0]).toMatchObject({
      modality: "mri",
      body_region: "Knee",
      laterality: "left",
      study_date: "2024-05-02",
      indication: "Knee pain",
      impression: "MRI Left Knee",
      external_id: "fhir:imaging:study:study-1",
    });
  });

  it("drops an entered-in-error ImagingStudy, records the drop", () => {
    const r = parseFhirBundle(
      bundle([
        {
          resourceType: "ImagingStudy",
          id: "study-bad",
          status: "entered-in-error",
          started: "2024-05-02",
          modality: [{ code: "CT" }],
        },
      ])
    );
    expect(r.imagingStudies ?? []).toHaveLength(0);
    expect(
      r.report!.drops.some(
        (d) => d.kind === "imaging_study" && d.reason === "negated"
      )
    ).toBe(true);
  });

  it("captures an imaging DiagnosticReport's conclusion + conclusionCode + inline presentedForm as the impression (#708)", () => {
    const r = parseFhirBundle(
      bundle([
        {
          resourceType: "DiagnosticReport",
          id: "dr-img",
          status: "final",
          category: [
            {
              coding: [
                {
                  system: "http://terminology.hl7.org/CodeSystem/v2-0074",
                  code: "RAD",
                },
              ],
            },
          ],
          code: { text: "CT Chest without contrast" },
          effectiveDateTime: "2024-03-15",
          conclusion: "No acute cardiopulmonary process.",
          conclusionCode: [{ text: "Normal chest CT" }],
          presentedForm: [
            {
              contentType: "text/plain",
              data: b64("FINDINGS: Clear lungs. No effusion."),
            },
          ],
        },
      ])
    );
    expect(r.imagingStudies).toHaveLength(1);
    const study = r.imagingStudies![0];
    expect(study.modality).toBe("ct");
    expect(study.study_date).toBe("2024-03-15");
    expect(study.impression).toContain("No acute cardiopulmonary process.");
    expect(study.impression).toContain("Normal chest CT");
    expect(study.impression).toContain("Clear lungs");
    // The report's discrete Observations still flow to records — no imaging row here.
    expect(r.records).toHaveLength(0);
  });

  it("routes a NON-imaging DiagnosticReport conclusion to a value-less lab record (#708)", () => {
    const r = parseFhirBundle(
      bundle([
        {
          resourceType: "DiagnosticReport",
          id: "dr-path",
          status: "final",
          category: [
            {
              coding: [
                {
                  system: "http://terminology.hl7.org/CodeSystem/v2-0074",
                  code: "LAB",
                },
              ],
            },
          ],
          code: { text: "Surgical Pathology Report" },
          effectiveDateTime: "2024-04-01",
          conclusion: "Benign. No malignancy identified.",
        },
      ])
    );
    expect(r.imagingStudies ?? []).toHaveLength(0);
    const rec = r.records.find((x) => x.name === "Surgical Pathology Report");
    expect(rec).toBeTruthy();
    expect(rec!.category).toBe("lab");
    expect(rec!.value).toContain("Benign");
    expect(rec!.value_num).toBeNull();
    expect(rec!.external_id).toBe("fhir:dr-conclusion:dr-path");
  });

  it("ingests an inline-text imaging DocumentReference but NOT a binary/remote one (#708 item 4)", () => {
    const r = parseFhirBundle(
      bundle([
        {
          resourceType: "DocumentReference",
          id: "docref-inline",
          status: "current",
          type: {
            text: "Radiology Report",
            coding: [
              {
                system: "http://loinc.org",
                code: "18748-4",
                display: "Diagnostic imaging study",
              },
            ],
          },
          date: "2024-06-10",
          content: [
            {
              attachment: {
                contentType: "text/html",
                data: b64(
                  "<html><body><b>IMPRESSION:</b> Normal study.</body></html>"
                ),
              },
            },
          ],
        },
        // Binary + remote imaging document — must NOT be fetched or ingested.
        {
          resourceType: "DocumentReference",
          id: "docref-binary",
          status: "current",
          type: { text: "CT Report" },
          content: [
            {
              attachment: {
                contentType: "application/pdf",
                url: "https://example.org/report.pdf",
              },
            },
          ],
        },
      ])
    );
    expect(r.imagingStudies).toHaveLength(1);
    const study = r.imagingStudies![0];
    expect(study.external_id).toBe("fhir:imaging:docref:docref-inline");
    expect(study.study_date).toBe("2024-06-10");
    // HTML stripped to plain text.
    expect(study.impression).toBe("IMPRESSION: Normal study.");
  });

  it("is idempotent — a duplicate ImagingStudy dedupes on external_id", () => {
    const study = {
      resourceType: "ImagingStudy",
      id: "study-dup",
      status: "available",
      started: "2024-01-01",
      modality: [{ code: "US" }],
      series: [{ modality: { code: "US" }, bodySite: { display: "Abdomen" } }],
    };
    const r = parseFhirBundle(bundle([study, { ...study }]));
    expect(r.imagingStudies).toHaveLength(1);
    expect(r.imagingStudies![0].modality).toBe("ultrasound");
    expect(
      r.report!.drops.some(
        (d) => d.kind === "imaging_study" && d.reason === "deduped"
      )
    ).toBe(true);
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
