// DB INTEGRATION TIER — Procedures + Family History.
//   1. The read queries are profile-scoped (no cross-profile bleed) and ordered.
//   2. The import persist path writes both tables, scopes them to the document, and
//      the shared clearImportedDocumentRows delete-set removes them on reprocess/
//      delete WITHOUT touching a manual (NULL document_id) row.
// The static source scan (lib/__tests__/profile-scoping.test.ts) can't see across
// the helper calls; this is the dynamic guard.

import { describe, it, expect, beforeAll } from "vitest";
import { db } from "@/lib/db";
import { getProcedures, getFamilyHistory } from "@/lib/queries";
import {
  persistDocumentImport,
  clearImportedDocumentRows,
} from "@/lib/import-persist";
import type { PersistInput } from "@/lib/import-shape";

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

function newDocument(profileId: number, filename: string): number {
  return Number(
    db
      .prepare(
        `INSERT INTO medical_documents
           (profile_id, filename, stored_path, extraction_status, doc_type)
         VALUES (?, ?, '', 'processing', 'ccd')`
      )
      .run(profileId, filename).lastInsertRowid
  );
}

// A PersistInput carrying only the two new domains (everything else empty).
function makeInput(tag: string): PersistInput {
  return {
    records: [],
    immunizations: [],
    allergies: [],
    conditions: [],
    encounters: [],
    procedures: [
      {
        name: `${tag} Appendectomy`,
        code: "44970",
        code_system: "CPT",
        date: "2005-06-12",
        provider: null,
        external_id: `ccda:procedure:44970:${tag}`,
      },
    ],
    familyHistory: [
      {
        relation: "Father",
        condition: `${tag} Type 2 diabetes`,
        code: "44054006",
        code_system: "SNOMED CT",
        onset_age: 55,
        deceased: 0,
        external_id: `ccda:famhx:father:44054006:${tag}`,
      },
    ],
    carePlanItems: [],
    careGoals: [],
    bodyMetrics: [],
    heights: [],
    headCircs: [],
    demographics: null,
    meta: {
      docType: "ccd",
      source: "MyChart",
      documentDate: "2024-05-12",
      patientName: "Test Patient",
      raw: null,
      model: null,
      importReport: null,
    },
    canonicalNamesToRegister: [],
    providers: [],
  };
}

let pa: number;
let pb: number;
let docA: number;

beforeAll(() => {
  pa = newProfile("PROC-A");
  pb = newProfile("PROC-B");
  docA = newDocument(pa, "A.ccd");
  const docB = newDocument(pb, "B.ccd");
  persistDocumentImport(pa, docA, makeInput("AAA"));
  persistDocumentImport(pb, docB, makeInput("BBB"));
  // A MANUAL procedure + family-history row for A (NULL document_id) — must survive
  // the document delete-set.
  db.prepare(
    `INSERT INTO procedures (profile_id, name, source) VALUES (?, 'AAA Manual biopsy', NULL)`
  ).run(pa);
  db.prepare(
    `INSERT INTO family_history (profile_id, relation, condition, source)
     VALUES (?, 'Mother', 'AAA Manual asthma', NULL)`
  ).run(pa);
});

describe("procedures + family_history — read scoping", () => {
  it("getProcedures returns only the querying profile's rows", () => {
    const a = getProcedures(pa);
    expect(a.every((p) => p.name.startsWith("AAA"))).toBe(true);
    expect(a.some((p) => p.name.includes("BBB"))).toBe(false);
    expect(getProcedures(pb).every((p) => p.name.startsWith("BBB"))).toBe(true);
  });

  it("getFamilyHistory returns only the querying profile's rows", () => {
    const a = getFamilyHistory(pa);
    expect(a.every((f) => f.condition.startsWith("AAA"))).toBe(true);
    expect(a.some((f) => f.condition.includes("BBB"))).toBe(false);
    // Onset age + relation round-trip.
    const diabetes = a.find((f) => /diabetes/i.test(f.condition))!;
    expect(diabetes.relation).toBe("Father");
    expect(diabetes.onset_age).toBe(55);
  });
});

describe("import persist + delete coverage", () => {
  it("wrote both domains scoped to the document", () => {
    const procs = db
      .prepare(
        "SELECT COUNT(*) n FROM procedures WHERE document_id = ? AND profile_id = ?"
      )
      .get(docA, pa) as { n: number };
    const fam = db
      .prepare(
        "SELECT COUNT(*) n FROM family_history WHERE document_id = ? AND profile_id = ?"
      )
      .get(docA, pa) as { n: number };
    expect(procs.n).toBe(1);
    expect(fam.n).toBe(1);
  });

  it("clearImportedDocumentRows removes the imported rows but not manual ones", () => {
    clearImportedDocumentRows(pa, docA);
    const imported = db
      .prepare(
        "SELECT COUNT(*) n FROM procedures WHERE document_id = ? AND profile_id = ?"
      )
      .get(docA, pa) as { n: number };
    expect(imported.n).toBe(0);
    // Manual rows (NULL document_id) survive.
    const manualProc = db
      .prepare(
        "SELECT COUNT(*) n FROM procedures WHERE document_id IS NULL AND profile_id = ?"
      )
      .get(pa) as { n: number };
    const manualFam = db
      .prepare(
        "SELECT COUNT(*) n FROM family_history WHERE document_id IS NULL AND profile_id = ?"
      )
      .get(pa) as { n: number };
    expect(manualProc.n).toBe(1);
    expect(manualFam.n).toBe(1);
    // Profile B's imported rows are untouched by A's clear.
    const bProcs = getProcedures(pb);
    expect(bProcs.some((p) => p.name.startsWith("BBB"))).toBe(true);
  });
});
