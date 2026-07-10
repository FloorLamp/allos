// DB INTEGRATION TIER — import DEBUGGER report persistence.
//
// Proves persistDocumentImport writes the drop/coverage report onto
// medical_documents.import_report, that a REPROCESS refreshes it (idempotent —
// the latest parse wins), and that the detail-page read (getMedicalDocument,
// SELECT *) surfaces it strictly per profile. Runs against a throwaway DB
// redirected by lib/__db_tests__/setup.ts.

import { describe, it, expect, beforeAll } from "vitest";
import { persistDocumentImport } from "@/lib/import-persist";
import type { PersistInput } from "@/lib/import-shape";
import { getMedicalDocument } from "@/lib/queries";
import {
  parseImportReport,
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
