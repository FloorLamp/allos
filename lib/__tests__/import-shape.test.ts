import { describe, expect, it } from "vitest";
import {
  extractionToPersistInput,
  healthRecordToPersistInput,
} from "@/lib/import-shape";
import type { ExtractionResult } from "@/lib/medical-extract";
import type { ImportResult } from "@/lib/health-import";
import { parseImportReport } from "@/lib/import-report";

function doneExtraction(
  over: Partial<Extract<ExtractionResult, { status: "done" }>> = {}
): Extract<ExtractionResult, { status: "done" }> {
  return {
    status: "done",
    model: "claude-x",
    raw: "RAW",
    meta: {
      document_type: "lab",
      source: "LabCorp",
      patient_name: "Jane Doe",
      patient_sex: "female",
      patient_birthdate: "1985-03-12",
      patient_age: null,
      document_date: "2024-02-01",
    },
    results: [],
    immunizations: [],
    conditions: [],
    allergies: [],
    procedures: [],
    encounters: [],
    familyHistory: [],
    carePlanItems: [],
    careGoals: [],
    drops: [],
    ...over,
  };
}

describe("extractionToPersistInput (AI path)", () => {
  it("resolves record dates: collected_date when ISO, else the fallback", () => {
    const input = extractionToPersistInput(
      doneExtraction({
        results: [
          mkResult({ name: "Glucose", collected_date: "2024-01-15" }),
          mkResult({ name: "HDL", collected_date: null }),
          mkResult({ name: "LDL", collected_date: "not-a-date" }),
        ],
      }),
      "2099-12-31"
    );
    expect(input.records.map((r) => r.date)).toEqual([
      "2024-01-15",
      "2099-12-31",
      "2099-12-31",
    ]);
  });

  it("carries the rich lab fields and leaves source/external_id null", () => {
    const [r] = extractionToPersistInput(
      doneExtraction({
        results: [
          mkResult({
            name: "Thyroid-Stimulating Hormone (TSH)",
            canonical_name: "Thyroid Stimulating Hormone",
            value: "2.1",
            value_num: 2.1,
            unit: "mIU/L",
            reference_range: "0.4-4.0",
            flag: "normal",
            panel: "Thyroid",
            notes: "fasting",
          }),
        ],
      }),
      "2024-02-01"
    ).records;
    expect(r).toMatchObject({
      canonical: "Thyroid Stimulating Hormone",
      value_num: 2.1,
      reference_range: "0.4-4.0",
      flag: "normal",
      panel: "Thyroid",
      notes: "fasting",
      source: null,
      external_id: null,
    });
  });

  it("coerces a `report` row into the narrative shape (value → notes, value/value_num/unit null)", () => {
    // The model classifies a narrative finding (an ECG/stress-test interpretation) as
    // `report` and puts the text in `value`; the Results → Reports surface reads `notes`
    // with a NULL value, so the adapter folds it over — otherwise the report renders
    // with an empty body (#708 follow-up).
    const [r] = extractionToPersistInput(
      doneExtraction({
        results: [
          mkResult({
            category: "report",
            name: "ECG Interpretation",
            value: "Sinus bradycardia. Otherwise normal ECG.",
            value_num: 55, // must be dropped — a report is not a valued analyte
            unit: "bpm",
            notes: null,
          }),
        ],
      }),
      "2024-02-01"
    ).records;
    expect(r.category).toBe("report");
    expect(r.value).toBeNull();
    expect(r.value_num).toBeNull();
    expect(r.unit).toBeNull();
    expect(r.notes).toBe("Sinus bradycardia. Otherwise normal ECG.");
  });

  it("folds a report row's value AND notes into one body", () => {
    const [r] = extractionToPersistInput(
      doneExtraction({
        results: [
          mkResult({
            category: "report",
            name: "Exercise Stress Test",
            value: "Negative",
            notes: "No chest pain or significant ST-T changes",
          }),
        ],
      }),
      "2024-02-01"
    ).records;
    expect(r.value).toBeNull();
    expect(r.notes).toBe(
      "Negative — No chest pain or significant ST-T changes"
    );
  });

  it("drops a non-finite value_num and defaults canonical to the name", () => {
    const [r] = extractionToPersistInput(
      doneExtraction({
        results: [
          mkResult({ name: "Note", canonical_name: "", value_num: NaN }),
        ],
      }),
      "2024-02-01"
    ).records;
    expect(r.value_num).toBeNull();
    expect(r.canonical).toBe("Note");
  });

  it("registers all result canonical names, projects meta + demographics", () => {
    const input = extractionToPersistInput(
      doneExtraction({
        results: [
          mkResult({ name: "A", canonical_name: "Alpha" }),
          mkResult({ name: "B", canonical_name: "" }),
        ],
      }),
      "2024-02-01"
    );
    expect(input.canonicalNamesToRegister).toEqual(["Alpha", "B"]);
    expect(input.demographics).toEqual({
      patient_sex: "female",
      patient_birthdate: "1985-03-12",
      patient_age: null,
      patient_name: "Jane Doe",
    });
    expect(input.meta).toMatchObject({
      docType: "lab",
      source: "LabCorp",
      documentDate: "2024-02-01",
      patientName: "Jane Doe",
      raw: "RAW",
      model: "claude-x",
    });
  });

  it("nulls a garbage document_date", () => {
    const input = extractionToPersistInput(
      doneExtraction({
        meta: { ...doneExtraction().meta, document_date: "??" },
      }),
      "2024-02-01"
    );
    expect(input.meta.documentDate).toBeNull();
  });

  it("projects body metrics to body_metrics and vaccine doses to immunizations", () => {
    const input = extractionToPersistInput(
      doneExtraction({
        results: [
          mkResult({
            name: "Body Weight",
            value_num: 80,
            unit: "kg",
            collected_date: "2024-02-01",
          }),
        ],
        immunizations: [
          {
            vaccine: "Tdap",
            date: "2023-09-15",
            dose_label: null,
            notes: null,
          },
        ],
      }),
      "2024-02-01"
    );
    expect(input.bodyMetrics).toEqual([
      {
        date: "2024-02-01",
        weight_kg: 80,
        body_fat_pct: null,
        resting_hr: null,
      },
    ]);
    expect(input.immunizations).toEqual([
      {
        date: "2023-09-15",
        vaccine: "tdap",
        dose_label: null,
        notes: null,
        external_id: null,
        provider: null,
      },
    ]);
  });

  it("body metrics captured in a body-metrics row are NOT also stored as records", () => {
    const input = extractionToPersistInput(
      doneExtraction({
        results: [
          mkResult({
            name: "Body Weight",
            category: "vitals",
            value_num: 80,
            unit: "kg",
            collected_date: "2024-02-01",
          }),
          mkResult({
            name: "Resting Heart Rate",
            canonical_name: "Resting Heart Rate",
            category: "vitals",
            value_num: 55,
            collected_date: "2024-02-01",
          }),
          mkResult({
            name: "Systolic blood pressure",
            canonical_name: "Blood Pressure Systolic",
            category: "vitals",
            value_num: 118,
            unit: "mmHg",
            collected_date: "2024-02-01",
          }),
          mkResult({
            name: "Glucose",
            category: "lab",
            value_num: 90,
            unit: "mg/dL",
            collected_date: "2024-02-01",
          }),
        ],
      }),
      "2024-02-01"
    );
    // weight + HR live in the body-metrics row...
    expect(input.bodyMetrics).toEqual([
      { date: "2024-02-01", weight_kg: 80, body_fat_pct: null, resting_hr: 55 },
    ]);
    // ...and are gone from records; the clinical vital (BP) and the lab stay.
    expect(input.records.map((r) => r.name)).toEqual([
      "Systolic blood pressure",
      "Glucose",
    ]);
    expect(input.canonicalNamesToRegister).not.toContain("Resting Heart Rate");
  });

  it("routes a lone body metric (HR, no weight) to a weightless body-metrics row", () => {
    // A vitals panel with a heart rate but no weight → a weightless body_metrics
    // row (weight_kg nullable), and the HR is removed from records so it lives in
    // exactly one place.
    const input = extractionToPersistInput(
      doneExtraction({
        results: [
          mkResult({
            name: "Resting Heart Rate",
            canonical_name: "Resting Heart Rate",
            value_num: 60,
            collected_date: "2024-02-01",
          }),
        ],
      }),
      "2024-02-01"
    );
    expect(input.bodyMetrics).toEqual([
      {
        date: "2024-02-01",
        weight_kg: null,
        body_fat_pct: null,
        resting_hr: 60,
      },
    ]);
    expect(input.records).toEqual([]);
  });

  it("keeps a body metric as a record when it has no resolvable date", () => {
    // No collected_date and a non-ISO document_date → the projection can't place
    // the reading on a date, so it isn't captured in body_metrics; it stays a
    // record (dated by the caller's fallback) rather than being dropped.
    const input = extractionToPersistInput(
      doneExtraction({
        meta: { ...doneExtraction().meta, document_date: "??" },
        results: [
          mkResult({
            name: "Resting Heart Rate",
            canonical_name: "Resting Heart Rate",
            value_num: 60,
            collected_date: null,
          }),
        ],
      }),
      "2024-02-01"
    );
    expect(input.bodyMetrics).toEqual([]);
    expect(input.records.map((r) => r.name)).toEqual(["Resting Heart Rate"]);
  });

  it("keeps a body-metric-kind reading whose value was rejected, even on a captured date", () => {
    // A DEXA on one date reports weight 80 kg (→ a body_metrics row, so the date is
    // captured) AND "Total Body Fat" as a MASS in kg (rejected by the % guard, never
    // stored). The fat-mass record must survive rather than vanish from both tables.
    const input = extractionToPersistInput(
      doneExtraction({
        results: [
          mkResult({
            name: "Body Weight",
            value_num: 80,
            unit: "kg",
            collected_date: "2024-02-01",
          }),
          mkResult({
            name: "Total Body Fat",
            value_num: 25,
            unit: "kg", // fat MASS, not a percentage → not stored in body_fat_pct
            collected_date: "2024-02-01",
          }),
        ],
      }),
      "2024-02-01"
    );
    expect(input.bodyMetrics).toEqual([
      {
        date: "2024-02-01",
        weight_kg: 80,
        body_fat_pct: null,
        resting_hr: null,
      },
    ]);
    // Weight is captured (removed from records); the un-stored fat-mass stays.
    expect(input.records.map((r) => r.name)).toEqual(["Total Body Fat"]);
  });

  it("projects Body Height into metric_samples heights and drops it from records", () => {
    const input = extractionToPersistInput(
      doneExtraction({
        results: [
          mkResult({
            name: "Body Height",
            canonical_name: "Body Height",
            category: "vitals",
            value_num: 178,
            unit: "cm",
            collected_date: "2024-02-01",
          }),
          mkResult({
            name: "Glucose",
            category: "lab",
            value_num: 90,
            unit: "mg/dL",
            collected_date: "2024-02-01",
          }),
        ],
      }),
      "2024-02-01"
    );
    expect(input.heights).toEqual([{ date: "2024-02-01", height_cm: 178 }]);
    // Height is gone from records (single home); the lab stays.
    expect(input.records.map((r) => r.name)).toEqual(["Glucose"]);
    expect(input.canonicalNamesToRegister).not.toContain("Body Height");
  });

  it("keeps a height whose value was rejected as a record (never projected)", () => {
    const input = extractionToPersistInput(
      doneExtraction({
        results: [
          mkResult({
            name: "Body Height",
            canonical_name: "Body Height",
            value_num: 178, // no unit → ambiguous → rejected by heightToCm
            unit: null,
            collected_date: "2024-02-01",
          }),
        ],
      }),
      "2024-02-01"
    );
    expect(input.heights).toEqual([]);
    expect(input.records.map((r) => r.name)).toEqual(["Body Height"]);
  });

  it("maps clinical domains, normalizing allergy/condition status to the CHECK set", () => {
    const input = extractionToPersistInput(
      doneExtraction({
        conditions: [
          {
            name: "Type 2 diabetes mellitus",
            code: "E11.9",
            code_system: "ICD-10-CM",
            status: "Resolved", // → resolved
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
            status: "garbage-status", // unknown → active
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
            description: "Follow up in 3 months",
            code: null,
            code_system: null,
            category: "encounter",
            planned_date: "2024-05-01",
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
      }),
      "2024-02-01"
    );
    expect(input.conditions).toEqual([
      {
        name: "Type 2 diabetes mellitus",
        code: "E11.9",
        code_system: "ICD-10-CM",
        status: "resolved",
        onset_date: "2019-05-01",
        resolved_date: null,
        external_id: null,
      },
    ]);
    expect(input.allergies[0].status).toBe("active"); // unknown normalized to active
    expect(input.procedures[0]).toMatchObject({
      name: "Appendectomy",
      code: "44970",
      provider: null,
      external_id: null,
    });
    expect(input.familyHistory[0]).toMatchObject({
      relation: "mother",
      condition: "Breast cancer",
      onset_age: 52,
      deceased: 1,
    });
    expect(input.carePlanItems[0]).toMatchObject({
      description: "Follow up in 3 months",
      category: "encounter",
      status: "planned", // free-text passthrough
      provider: null,
    });
    expect(input.careGoals[0]).toMatchObject({ description: "A1c < 7.0%" });
  });

  it("resolves an encounter's provider + facility names into ImportedProviders", () => {
    const input = extractionToPersistInput(
      doneExtraction({
        encounters: [
          {
            date: "2024-02-01",
            end_date: "2024-02-01",
            type: "Office Visit",
            class_code: "AMB",
            reason: "Fever",
            diagnoses: ["Fever"],
            provider: "Grace Hopper, MD",
            location: "Sample Pediatrics",
            notes: null,
          },
        ],
      }),
      "2024-02-01"
    );
    expect(input.encounters).toHaveLength(1);
    expect(input.encounters[0]).toMatchObject({
      date: "2024-02-01",
      type: "Office Visit",
      diagnoses: ["Fever"],
      external_id: null,
    });
    expect(input.encounters[0].provider).toEqual({
      name: "Grace Hopper, MD",
      type: "individual",
      npi: null,
      identifier: null,
      phone: null,
      address: null,
    });
    expect(input.encounters[0].location?.name).toBe("Sample Pediatrics");
    expect(input.encounters[0].location?.type).toBe("organization");
  });

  it("registers meta.source as an organization provider", () => {
    const input = extractionToPersistInput(
      doneExtraction({ meta: { ...doneExtraction().meta, source: "LabCorp" } }),
      "2024-02-01"
    );
    expect(input.providers).toEqual([
      {
        name: "LabCorp",
        type: "organization",
        npi: null,
        identifier: null,
        phone: null,
        address: null,
      },
    ]);
  });

  it("produces an import report carrying the extraction's drop accounting", () => {
    const input = extractionToPersistInput(
      doneExtraction({
        conditions: [
          {
            name: "Hypertension",
            code: null,
            code_system: null,
            status: null,
            onset_date: null,
            resolved_date: null,
          },
        ],
        drops: [
          { kind: "allergy", label: "(unnamed allergy)", reason: "no_value" },
        ],
      }),
      "2024-02-01"
    );
    const report = JSON.parse(input.meta.importReport!);
    expect(report.imported).toBe(1); // one condition landed
    expect(report.considered).toBe(2); // + one row-level drop
    expect(report.drops).toEqual([
      { kind: "allergy", label: "(unnamed allergy)", reason: "no_value" },
    ]);
  });
});

describe("healthRecordToPersistInput (deterministic path)", () => {
  const parsed: ImportResult = {
    immunizations: [
      {
        code: "covid",
        date: "2021-11-01",
        dose_label: null,
        notes: null,
        external_id: "ccda:covid:2021-11-01",
      },
    ],
    records: [
      {
        category: "lab",
        name: "Hepatitis B Surface Antibody",
        canonical: "Hepatitis B Surface Antibody",
        value: "45",
        value_num: 45,
        unit: "mIU/mL",
        date: "2020-06-01",
        external_id: "ccda:obs:16935-9:2020-06-01",
      },
      {
        category: "vitals",
        name: "Systolic blood pressure",
        canonical: "Blood Pressure Systolic",
        value: "118",
        value_num: 118,
        unit: "mm[Hg]",
        date: "2024-01-10",
        external_id: "ccda:vital:8480-6:2024-01-10",
      },
    ],
    demographics: { sex: "male", birthdate: "1990-07-22", name: "Sam Lee" },
  };

  it("maps records with external_id + source and preserves immunization codes", () => {
    const input = healthRecordToPersistInput(parsed, "ccda", "MyChart");
    expect(input.records[0]).toMatchObject({
      canonical: "Hepatitis B Surface Antibody",
      source: "ccda",
      external_id: "ccda:obs:16935-9:2020-06-01",
      reference_range: null,
      flag: null,
    });
    expect(input.immunizations[0]).toEqual({
      date: "2021-11-01",
      vaccine: "covid",
      dose_label: null,
      notes: null,
      external_id: "ccda:covid:2021-11-01",
      provider: null,
      // Tier-1 visit link (#1050): null here — this fixture carries no encounter ref.
      encounter_external_id: null,
    });
    expect(input.bodyMetrics).toEqual([]);
  });

  it("projects encounters with their provider/location + diagnoses", () => {
    const withEncounter: ImportResult = {
      ...parsed,
      encounters: [
        {
          date: "2026-06-08",
          end_date: "2026-06-08",
          type: "Office Visit",
          code: "99213",
          code_system: "CPT",
          class_code: "AMB",
          reason: "Fever",
          diagnoses: ["Fever"],
          provider: {
            name: "Grace Hopper",
            type: "individual",
            npi: "1000000001",
            identifier: null,
            phone: null,
            address: null,
          },
          location: {
            name: "Sample Pediatrics - Springfield",
            type: "organization",
            npi: null,
            identifier: null,
            phone: null,
            address: null,
          },
          notes: null,
          external_id: "ccda:encounter:100000001",
        },
      ],
    };
    const input = healthRecordToPersistInput(withEncounter, "ccda", "MyChart");
    expect(input.encounters).toHaveLength(1);
    expect(input.encounters[0]).toMatchObject({
      date: "2026-06-08",
      type: "Office Visit",
      class_code: "AMB",
      reason: "Fever",
      diagnoses: ["Fever"],
      external_id: "ccda:encounter:100000001",
    });
    expect(input.encounters[0].provider?.npi).toBe("1000000001");
    expect(input.encounters[0].location?.name).toBe(
      "Sample Pediatrics - Springfield"
    );
  });

  it("leaves encounters empty when the parse carried none", () => {
    const input = healthRecordToPersistInput(parsed, "ccda", "MyChart");
    expect(input.encounters).toEqual([]);
  });

  it("registers only lab canonical names (not vitals), sets meta + demographics", () => {
    const input = healthRecordToPersistInput(parsed, "ccda", "MyChart export");
    expect(input.canonicalNamesToRegister).toEqual([
      "Hepatitis B Surface Antibody",
    ]);
    expect(input.meta).toMatchObject({
      docType: "MyChart export",
      source: "ccda",
      documentDate: "2024-01-10", // latest item date
      patientName: "Sam Lee", // patient name flows to the document field
      model: null,
    });
    expect(JSON.parse(input.meta.raw!)).toMatchObject({ demographics: {} });
    expect(input.demographics).toEqual({
      patient_sex: "male",
      patient_birthdate: "1990-07-22",
      patient_age: null,
      patient_name: "Sam Lee",
      patient_postal_code: null,
    });
  });

  it("routes CDA body metrics to body_metrics, leaving clinical vitals as records", () => {
    const withBodyMetrics: ImportResult = {
      immunizations: [],
      records: [
        {
          category: "vitals",
          name: "Body Weight",
          canonical: "Body Weight",
          value: "82",
          value_num: 82,
          unit: "kg",
          date: "2024-01-10",
          external_id: "ccda:vital:29463-7:2024-01-10",
        },
        {
          category: "vitals",
          name: "Heart rate",
          canonical: "Resting Heart Rate", // LOINC 8867-4 canonicalized
          value: "61",
          value_num: 61,
          unit: "/min",
          date: "2024-01-10",
          external_id: "ccda:vital:8867-4:2024-01-10",
        },
        {
          category: "vitals",
          name: "Systolic blood pressure",
          canonical: "Blood Pressure Systolic",
          value: "118",
          value_num: 118,
          unit: "mm[Hg]",
          date: "2024-01-10",
          external_id: "ccda:vital:8480-6:2024-01-10",
        },
      ],
      demographics: null,
    };
    const input = healthRecordToPersistInput(
      withBodyMetrics,
      "ccda",
      "MyChart"
    );
    expect(input.bodyMetrics).toEqual([
      { date: "2024-01-10", weight_kg: 82, body_fat_pct: null, resting_hr: 61 },
    ]);
    // Weight + HR are gone from records; the clinical vital (BP) remains.
    expect(input.records.map((r) => r.name)).toEqual([
      "Systolic blood pressure",
    ]);
  });

  it("routes CDA/FHIR Body Height to metric_samples heights, incl. a LOINC-only reading", () => {
    const withHeight: ImportResult = {
      immunizations: [],
      records: [
        {
          category: "vitals",
          name: "Body Height",
          canonical: "Body Height",
          value: "178",
          value_num: 178,
          unit: "cm",
          date: "2024-01-10",
          external_id: "ccda:vital:8302-2:2024-01-10",
          loinc: "8302-2",
        },
        {
          // A generic-named height recognized purely by its LOINC on another date.
          category: "vitals",
          name: "Observation",
          canonical: "Observation",
          value: "68",
          value_num: 68,
          unit: "in",
          date: "2023-01-10",
          external_id: "ccda:vital:8308-9:2023-01-10",
          loinc: "8308-9",
        },
        {
          category: "vitals",
          name: "Body Weight",
          canonical: "Body Weight",
          value: "82",
          value_num: 82,
          unit: "kg",
          date: "2024-01-10",
          external_id: "ccda:vital:29463-7:2024-01-10",
          loinc: "29463-7",
        },
      ],
      demographics: null,
    };
    const input = healthRecordToPersistInput(withHeight, "ccda", "MyChart");
    expect(input.heights).toEqual([
      { date: "2023-01-10", height_cm: 172.7 },
      { date: "2024-01-10", height_cm: 178 },
    ]);
    // Weight still routes to body_metrics.
    expect(input.bodyMetrics).toEqual([
      {
        date: "2024-01-10",
        weight_kg: 82,
        body_fat_pct: null,
        resting_hr: null,
      },
    ]);
    // Both heights AND the weight are gone from records (each has one home).
    expect(input.records).toEqual([]);
    expect(input.canonicalNamesToRegister).toEqual([]);
  });

  it("routes CDA head circumference (8287-5) to metric_samples headCircs, not records", () => {
    const withHeadCirc: ImportResult = {
      immunizations: [],
      records: [
        {
          category: "vitals",
          name: "Head Occipital-frontal circumference by Tape measure",
          canonical: "Head Occipital-frontal circumference by Tape measure",
          value: "46",
          value_num: 46,
          unit: "cm",
          date: "2024-06-10",
          external_id: "ccda:vital:8287-5:2024-06-10",
          loinc: "8287-5",
        },
        {
          // The percentile companion code is NOT a measurement — it must stay a record.
          category: "vitals",
          name: "Head OFC Percentile",
          canonical: "Head OFC Percentile",
          value: "55",
          value_num: 55,
          unit: "%",
          date: "2024-06-10",
          external_id: "ccda:vital:8289-1:2024-06-10",
          loinc: "8289-1",
        },
      ],
      demographics: null,
    };
    const input = healthRecordToPersistInput(withHeadCirc, "ccda", "MyChart");
    expect(input.headCircs).toEqual([
      { date: "2024-06-10", head_circumference_cm: 46 },
    ]);
    // The measurement left records; the percentile row stays a record.
    expect(input.records.map((r) => r.loinc)).toEqual(["8289-1"]);
  });
});

function mkResult(over: Record<string, unknown>) {
  return {
    category: "lab" as const,
    panel: null,
    name: "X",
    canonical_name: "X",
    value: null,
    value_num: null,
    unit: null,
    reference_range: null,
    flag: null,
    collected_date: null,
    notes: null,
    ...over,
  };
}

describe("extractionToPersistInput — unresolved analytes (#918 §4)", () => {
  // Synthetic uncurated names (never in the dataset) so this stays green even after
  // real gaps like urinalysis are curated.
  const UNCURATED_LAB = "Nonexistent Test Analyte";

  function reportOf(over: Parameters<typeof doneExtraction>[0]) {
    const input = extractionToPersistInput(doneExtraction(over), "2099-12-31");
    return parseImportReport(input.meta.importReport);
  }

  it("surfaces a lab whose canonical name matched no curated entry, with its unit", () => {
    const report = reportOf({
      results: [
        mkResult({ name: "Sodium", canonical_name: "Sodium", unit: "mmol/L" }),
        mkResult({
          name: "URO",
          canonical_name: UNCURATED_LAB,
          unit: "mg/dL",
        }),
        mkResult({
          name: "URO2",
          canonical_name: UNCURATED_LAB,
          unit: "mg/dL",
        }),
      ],
    });
    // Sodium resolves (seeded) and is NOT reported; the uncurated lab is, ×2.
    expect(report?.unresolvedNames).toEqual([
      { name: UNCURATED_LAB, count: 2, unit: "mg/dL" },
    ]);
  });

  it("does NOT surface a non-lab (vitals/scan/anthropometric) uncurated name (§5)", () => {
    const report = reportOf({
      results: [
        mkResult({
          category: "vitals",
          name: "Some Vital",
          canonical_name: "Nonexistent Test Vital",
          unit: "mmHg",
        }),
      ],
    });
    expect(report?.unresolvedNames).toEqual([]);
  });
});

describe("extractionToPersistInput — source reconciliation", () => {
  it("folds the reconciliation into the report, keeping only the unconfirmed rows", () => {
    const input = extractionToPersistInput(
      doneExtraction({
        reconciliation: {
          total: 3,
          confirmed: 1,
          valueMismatch: 1,
          nameNotFound: 1,
          confirmedRate: 1 / 3,
          items: [
            { name: "Sodium", value: "140", verdict: "confirmed" },
            { name: "Ferritin", value: "999", verdict: "value_mismatch" },
            { name: "Made Up", value: "1", verdict: "name_not_found" },
          ],
        },
      }),
      "2099-12-31"
    );
    expect(parseImportReport(input.meta.importReport)?.reconciliation).toEqual({
      confirmed: 1,
      total: 3,
      flags: [
        { name: "Ferritin", value: "999", verdict: "value_mismatch" },
        { name: "Made Up", value: "1", verdict: "name_not_found" },
      ],
    });
  });

  it("leaves reconciliation null when the result carries none (replay / non-PDF)", () => {
    const input = extractionToPersistInput(doneExtraction({}), "2099-12-31");
    expect(
      parseImportReport(input.meta.importReport)?.reconciliation
    ).toBeNull();
  });
});

describe("extractionToPersistInput — structured prescription (#414)", () => {
  it("threads structured attribution + sig/strength/course onto a prescription record", () => {
    const input = extractionToPersistInput(
      doneExtraction({
        results: [
          mkResult({
            category: "prescription",
            name: "Lisinopril",
            canonical_name: "Lisinopril",
            value: null,
            notes: null,
            prescription: {
              sig: "Take 1 tablet by mouth daily",
              strength: "10 mg",
              prn: 0,
              prescriber: "Grace Hopper, MD",
              pharmacy: "Test Pharmacy #12",
              rx_number: "RX-555031",
              start_date: "2024-02-01",
            },
          }),
        ],
      }),
      "2099-12-31"
    );
    const rec = input.records.find((r) => r.category === "prescription")!;
    // Attribution comes straight off the label, not NULL.
    expect(rec.prescriber).toBe("Grace Hopper, MD");
    expect(rec.pharmacy).toBe("Test Pharmacy #12");
    expect(rec.rxNumber).toBe("RX-555031");
    // Strength → value (parsePrescription's explicit strength), sig → notes (so the
    // schedule is inferred from clean directions).
    expect(rec.value).toBe("10 mg");
    expect(rec.notes).toBe("Take 1 tablet by mouth daily");
    // A printed start date becomes a single open course.
    expect(rec.courses).toEqual([
      {
        started_on: "2024-02-01",
        stopped_on: null,
        stop_reason: null,
        notes: null,
      },
    ]);
  });

  it("forces PRN through the sig and leaves attribution null when unstructured", () => {
    const input = extractionToPersistInput(
      doneExtraction({
        results: [
          mkResult({
            category: "prescription",
            name: "Ibuprofen",
            canonical_name: "Ibuprofen",
            notes: "old note",
            prescription: {
              sig: "1 tablet for pain",
              strength: null,
              prn: 1,
              prescriber: null,
              pharmacy: null,
              rx_number: null,
              start_date: null,
            },
          }),
        ],
      }),
      "2099-12-31"
    );
    const rec = input.records.find((r) => r.category === "prescription")!;
    expect(rec.notes).toBe("1 tablet for pain; as needed");
    expect(rec.prescriber).toBeNull();
    expect(rec.courses).toBeNull();
  });

  it("falls back to the note (no structured prescription) — legacy path unchanged", () => {
    const input = extractionToPersistInput(
      doneExtraction({
        results: [
          mkResult({
            category: "prescription",
            name: "Metformin 500 mg",
            canonical_name: "Metformin 500 mg",
            notes: "Take 1 tablet twice daily",
          }),
        ],
      }),
      "2099-12-31"
    );
    const rec = input.records.find((r) => r.category === "prescription")!;
    expect(rec.notes).toBe("Take 1 tablet twice daily");
    expect(rec.prescriber ?? null).toBeNull();
    expect(rec.courses ?? null).toBeNull();
  });
});
