// DB INTEGRATION TIER — import DEBUGGER report persistence.
//
// Proves persistDocumentImport writes the drop/coverage report onto
// medical_documents.import_report, that a REPROCESS refreshes it (idempotent —
// the latest parse wins), that the detail-page read (getMedicalDocument,
// SELECT *) surfaces it strictly per profile, and (#1827) that the report's
// kept-vs-considered counts ARE the document's extracted_count — one question,
// one computation, both stamped in the same UPDATE. Runs against a throwaway DB
// redirected by lib/__db_tests__/setup.ts. All fixtures synthetic.

import { describe, it, expect, beforeAll } from "vitest";
import { toKg } from "@/lib/units";
import {
  IMPORT_FOOTPRINT_TABLES,
  countImportedDocumentRows,
  persistDocumentImport,
} from "@/lib/import-persist";
import { documentSource } from "@/lib/body-metric-extract";
import type { PersistInput } from "@/lib/import-shape";
import { getMedicalDocument } from "@/lib/queries";
import {
  parseImportReport,
  rowDropCount,
  serializeImportReport,
  type ImportReport,
} from "@/lib/import-report";
import { db } from "@/lib/db";

const DATE = "2021-03-04";

function reportV1(): ImportReport {
  return {
    drops: [
      {
        kind: "lab",
        label: "Comment(s)",
        reason: "null_flavor",
        section: "Results",
      },
      { kind: "section", label: "Insurance", reason: "unrecognized_section" },
    ],
    coverage: [
      { key: "results", title: "Results", consumed: true, present: 3 },
      { key: "ins", title: "Insurance", consumed: false, present: 1 },
    ],
    imported: 1,
    considered: 2,
  };
}

function makeInput(report: ImportReport | null): PersistInput {
  return {
    records: [
      {
        category: "lab",
        name: "Glucose",
        canonical: "Glucose",
        value: "95",
        value_num: 95,
        unit: "mg/dL",
        date: DATE,
        reference_range: null,
        flag: null,
        panel: null,
        notes: null,
        source: null,
        external_id: "obs:glucose",
        loinc: null,
        provider: null,
      },
    ],
    immunizations: [],
    allergies: [],
    conditions: [],
    encounters: [],
    procedures: [],
    familyHistory: [],
    carePlanItems: [],
    careGoals: [],
    appointments: [],
    bodyMetrics: [],
    heights: [],
    headCircs: [],
    demographics: null,
    meta: {
      docType: "ccd",
      source: "ccd",
      documentDate: DATE,
      patientName: "Test Patient",
      raw: null,
      model: null,
      importReport: serializeImportReport(report),
    },
    canonicalNamesToRegister: [],
    providers: [],
  };
}

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
         VALUES (?, 'labs.xml', '', 'processing', 'ccd')`
      )
      .run(profileId).lastInsertRowid
  );
}

let profileA: number;
let profileB: number;
let docA: number;
let docB: number;

beforeAll(() => {
  profileA = newProfile("REPORT-A");
  profileB = newProfile("REPORT-B");
  docA = newDocument(profileA);
  docB = newDocument(profileB);
  persistDocumentImport(profileA, docA, makeInput(reportV1()));
  persistDocumentImport(profileB, docB, makeInput(null));
});

describe("import_report persistence", () => {
  it("stores the report as JSON on the document", () => {
    const doc = getMedicalDocument(profileA, docA)!;
    const parsed = parseImportReport(doc.import_report);
    expect(parsed).not.toBeNull();
    expect(parsed!.imported).toBe(1);
    expect(
      parsed!.drops.some(
        (d) => d.reason === "null_flavor" && d.label === "Comment(s)"
      )
    ).toBe(true);
    expect(
      parsed!.coverage.find((c) => c.title === "Insurance")?.consumed
    ).toBe(false);
  });

  it("refreshes the report on reprocess (latest parse wins, idempotent)", () => {
    const v2: ImportReport = {
      drops: [{ kind: "vitals", label: "Heart rate", reason: "deduped" }],
      coverage: [
        { key: "vitals", title: "Vital Signs", consumed: true, present: 2 },
      ],
      imported: 1,
      considered: 2,
    };
    persistDocumentImport(profileA, docA, makeInput(v2));
    const parsed = parseImportReport(
      getMedicalDocument(profileA, docA)!.import_report
    );
    // The old drops are gone; the new report is in place.
    expect(parsed!.drops).toHaveLength(1);
    expect(parsed!.drops[0].reason).toBe("deduped");
    expect(parsed!.coverage[0].title).toBe("Vital Signs");
  });

  it("stores NULL for a path with no report (AI extraction)", () => {
    expect(getMedicalDocument(profileB, docB)!.import_report).toBeNull();
  });

  it("is profile-scoped: A cannot read B's document report", () => {
    expect(getMedicalDocument(profileA, docB)).toBeUndefined();
  });
});

// ---- #1827: the coverage card's count IS extracted_count ----

// A document carrying EVERY domain an import writes — the medications the old
// parse-time sum forgot, plus imaging, optical, dental, genomics, appointments,
// body metrics and the height/head-circumference samples. The stored report's
// `imported` must be the footprint tally, whatever the parse guessed.
const ALL_DATE = "2022-08-09";

function everyDomainInput(): PersistInput {
  return {
    records: [
      {
        category: "lab",
        name: "Glucose",
        canonical: "Glucose",
        value: "95",
        value_num: 95,
        unit: "mg/dL",
        date: ALL_DATE,
        reference_range: null,
        flag: null,
        panel: null,
        notes: null,
        source: null,
        external_id: "obs:glucose",
        loinc: null,
        provider: null,
      },
      // A prescription is the medication entity (#1178): it becomes an
      // intake_items row, never a medical_records row — the domain the parse-time
      // sum could not see, because it only became a row at persist.
      {
        category: "prescription",
        name: "Lisinopril 10 mg",
        canonical: "Lisinopril 10 mg",
        value: null,
        value_num: null,
        unit: null,
        date: ALL_DATE,
        reference_range: null,
        flag: null,
        panel: null,
        notes: "Take 1 tablet by mouth daily",
        source: null,
        external_id: "med:rx",
        loinc: null,
        provider: null,
      },
    ],
    immunizations: [
      {
        date: ALL_DATE,
        vaccine: "mmr",
        dose_label: "1",
        notes: null,
        external_id: "imm:mmr",
        provider: null,
      },
    ],
    allergies: [
      {
        substance: "Penicillin",
        substance_code: null,
        substance_code_system: null,
        reaction: "Hives",
        severity: "moderate",
        status: "active",
        onset_date: null,
        external_id: "allergy:penicillin",
      },
    ],
    conditions: [
      {
        name: "Hypertension",
        code: "I10",
        code_system: "ICD-10",
        status: "active",
        onset_date: null,
        resolved_date: null,
        external_id: "condition:htn",
      },
    ],
    encounters: [
      {
        date: ALL_DATE,
        end_date: null,
        type: "Office Visit",
        class_code: "AMB",
        reason: "Annual physical",
        diagnoses: [],
        provider: null,
        location: null,
        notes: null,
        external_id: "encounter:1",
      },
    ],
    procedures: [
      {
        name: "Appendectomy",
        code: "44970",
        code_system: "CPT",
        date: ALL_DATE,
        provider: null,
        external_id: "procedure:44970",
      },
    ],
    familyHistory: [
      {
        relation: "Father",
        condition: "Type 2 diabetes",
        code: null,
        code_system: null,
        onset_age: 55,
        deceased: 0,
        external_id: "famhx:father",
      },
    ],
    carePlanItems: [
      {
        description: "Follow-up lipid panel",
        code: null,
        code_system: null,
        category: "observation",
        planned_date: "2022-11-01",
        status: "planned",
        provider: null,
        external_id: "careplan:lipids",
      },
    ],
    careGoals: [
      {
        description: "Blood pressure below 130/80",
        code: null,
        code_system: null,
        target_date: "2023-02-01",
        status: "active",
        external_id: "caregoal:bp",
      },
    ],
    genomicVariants: [
      {
        gene: "CYP2C19",
        variant: "rs4244285",
        genotype: null,
        star_allele: "*2/*2",
        zygosity: "homozygous",
        significance: null,
        result_type: "pharmacogenomic",
        interpretation: "Poor metabolizer",
        source_lab: "Sample Genetics Lab",
        report_date: ALL_DATE,
        external_id: "genomic:cyp2c19",
      },
    ],
    imagingStudies: [
      {
        modality: "mri",
        body_region: "Knee",
        laterality: "left",
        contrast: false,
        contrast_agent: null,
        study_date: ALL_DATE,
        dose_msv: null,
        impression: "Small joint effusion.",
        indication: "Knee pain",
        status: "final",
        external_id: "imaging:knee",
      },
    ],
    opticalPrescriptions: [
      {
        kind: "glasses",
        od_sphere: -2,
        od_cylinder: -0.75,
        od_axis: 90,
        od_add: null,
        os_sphere: 0,
        os_cylinder: null,
        os_axis: null,
        os_add: null,
        pd: 63,
        base_curve: null,
        diameter: null,
        brand: null,
        issued_date: ALL_DATE,
        expiry_date: "2024-08-09",
        provider: null,
        notes: null,
        external_id: "optical:glasses",
      },
    ],
    dentalProcedures: [
      {
        name: "Composite filling",
        status: "completed",
        tooth: "14",
        tooth_system: "universal",
        surface: "mod",
        cdt_code: "D2392",
        procedure_date: ALL_DATE,
        finding: null,
        follow_up_interval_days: null,
        external_id: "dental:filling",
      },
    ],
    appointments: [
      {
        scheduled_at: "2030-01-15T09:30",
        status: "scheduled",
        title: "Cardiology follow-up",
        location: "Sample Cardiology Clinic",
        notes: null,
        kind: null,
        provider: null,
        external_id: "appointment:cardio",
      },
    ],
    bodyMetrics: [
      {
        date: ALL_DATE,
        weight_kg: toKg(82, "kg"),
        body_fat_pct: null,
        resting_hr: null,
      },
    ],
    heights: [{ date: ALL_DATE, height_cm: 178 }],
    headCircs: [{ date: ALL_DATE, head_circumference_cm: 47 }],
    demographics: null,
    meta: {
      docType: "ccd",
      source: "ccd",
      documentDate: ALL_DATE,
      patientName: "Test Patient",
      raw: null,
      model: null,
      // The PARSE-time report, deliberately carrying the old nine-term sum's
      // answer: it counted the lab and the eight non-medication clinical kinds it
      // knew about, and saw none of the medication / imaging / optical / dental /
      // genomic / appointment / body rows this document also writes.
      importReport: serializeImportReport({
        drops: [
          { kind: "lab", label: "Comment(s)", reason: "null_flavor" },
          {
            kind: "section",
            label: "Insurance",
            reason: "unrecognized_section",
          },
        ],
        coverage: [
          { key: "results", title: "Results", consumed: true, present: 4 },
        ],
        imported: 9,
        considered: 10,
      }),
    },
    canonicalNamesToRegister: [],
    providers: [],
  };
}

describe("the stored report's counts are the footprint tally (#1827)", () => {
  let profileC: number;
  let docC: number;

  beforeAll(() => {
    profileC = newProfile("REPORT-EVERY-DOMAIN");
    docC = newDocument(profileC);
    persistDocumentImport(profileC, docC, everyDomainInput());
  });

  it("covers every footprint table, so a new one cannot slip past this guard", () => {
    // The fixture must write at least one row into EVERY table the import
    // footprint counts — the day a seventeenth table joins the registry, this
    // names it instead of letting the convergence go untested for that domain.
    const source = documentSource(docC);
    const empty = IMPORT_FOOTPRINT_TABLES.filter((t) => {
      const row = db
        .prepare(
          `SELECT COUNT(*) AS n FROM ${t.table}
            WHERE ${t.key} = ? AND profile_id = ?${t.extra ? ` AND ${t.extra}` : ""}`
        )
        .get(t.key === "document_id" ? docC : source, profileC) as {
        n: number;
      };
      return row.n === 0;
    }).map((t) => `${t.table}${t.extra ? ` (${t.extra})` : ""}`);
    expect(empty).toEqual([]);
  });

  it("reports the same number the document's extracted_count reports", () => {
    const doc = getMedicalDocument(profileC, docC)!;
    const report = parseImportReport(doc.import_report)!;
    const footprint = countImportedDocumentRows(profileC, docC);
    // The whole defect: the card said 9 (the parse's hand sum) while the toast,
    // the Review feed and the Timeline said the footprint tally.
    expect(report.imported).toBe(footprint);
    expect(report.imported).toBe(doc.extracted_count);
    // The medication the old sum missed is one of the rows being counted.
    expect(footprint).toBeGreaterThan(9);
  });

  it("carries `considered` along: footprint + row drops, section drops excluded", () => {
    const report = parseImportReport(
      getMedicalDocument(profileC, docC)!.import_report
    )!;
    expect(rowDropCount(report)).toBe(1); // the null-flavored Comment(s)
    expect(report.considered).toBe(report.imported + 1);
    // The rebind touches the counts and nothing else.
    expect(report.drops).toHaveLength(2);
    expect(report.coverage[0].title).toBe("Results");
  });

  it("re-derives the counts on reprocess rather than inheriting the stored ones", () => {
    // A re-extraction that drops a domain must move BOTH numbers together.
    const thinner = everyDomainInput();
    thinner.imagingStudies = [];
    thinner.dentalProcedures = [];
    persistDocumentImport(profileC, docC, thinner);
    const doc = getMedicalDocument(profileC, docC)!;
    const report = parseImportReport(doc.import_report)!;
    expect(report.imported).toBe(doc.extracted_count);
    expect(report.imported).toBe(countImportedDocumentRows(profileC, docC));
    // Restore the full footprint for any later reader of this document.
    persistDocumentImport(profileC, docC, everyDomainInput());
  });
});
