// DB INTEGRATION TIER — Care Plan + Care Goals.
//   1. The read queries are profile-scoped (no cross-profile bleed) and ordered.
//   2. The import persist path writes both tables, scopes them to the document, and
//      the shared clearImportedDocumentRows delete-set removes them on reprocess/
//      delete WITHOUT touching a manual (NULL document_id) row.
// The static source scan (lib/__tests__/profile-scoping.test.ts) can't see across
// the helper calls; this is the dynamic guard.

import { describe, it, expect, beforeAll } from "vitest";
import { db } from "@/lib/db";
import { getCarePlanItems, getCareGoals } from "@/lib/queries";
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
    procedures: [],
    familyHistory: [],
    carePlanItems: [
      {
        description: `${tag} Follow-up lipid panel`,
        code: "57698-3",
        code_system: "LOINC",
        category: "observation",
        planned_date: "2025-01-15",
        status: "planned",
        provider: null,
        external_id: `ccda:careplan:57698-3:${tag}`,
      },
    ],
    careGoals: [
      {
        description: `${tag} HbA1c below 6.5%`,
        code: "4548-4",
        code_system: "LOINC",
        target_date: "2025-09-01",
        status: "active",
        external_id: `ccda:caregoal:4548-4:${tag}`,
      },
    ],
    appointments: [],
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
  pa = newProfile("CARE-A");
  pb = newProfile("CARE-B");
  docA = newDocument(pa, "A.ccd");
  const docB = newDocument(pb, "B.ccd");
  persistDocumentImport(pa, docA, makeInput("AAA"));
  persistDocumentImport(pb, docB, makeInput("BBB"));
  // A MANUAL care-plan + care-goal row for A (NULL document_id) — must survive the
  // document delete-set.
  db.prepare(
    `INSERT INTO care_plan_items (profile_id, description, source) VALUES (?, 'AAA Manual PT visit', NULL)`
  ).run(pa);
  db.prepare(
    `INSERT INTO care_goals (profile_id, description, source) VALUES (?, 'AAA Manual weight goal', NULL)`
  ).run(pa);
});

describe("care_plan_items + care_goals — read scoping", () => {
  it("getCarePlanItems returns only the querying profile's rows", () => {
    const a = getCarePlanItems(pa);
    expect(a.every((c) => c.description.startsWith("AAA"))).toBe(true);
    expect(a.some((c) => c.description.includes("BBB"))).toBe(false);
    expect(
      getCarePlanItems(pb).every((c) => c.description.startsWith("BBB"))
    ).toBe(true);
  });

  it("getCareGoals returns only the querying profile's rows", () => {
    const a = getCareGoals(pa);
    expect(a.every((g) => g.description.startsWith("AAA"))).toBe(true);
    expect(a.some((g) => g.description.includes("BBB"))).toBe(false);
    const a1c = a.find((g) => /a1c/i.test(g.description))!;
    expect(a1c.target_date).toBe("2025-09-01");
    expect(a1c.status).toBe("active");
  });
});

describe("import persist + delete coverage", () => {
  it("wrote both domains scoped to the document", () => {
    const cp = db
      .prepare(
        "SELECT COUNT(*) n FROM care_plan_items WHERE document_id = ? AND profile_id = ?"
      )
      .get(docA, pa) as { n: number };
    const cg = db
      .prepare(
        "SELECT COUNT(*) n FROM care_goals WHERE document_id = ? AND profile_id = ?"
      )
      .get(docA, pa) as { n: number };
    expect(cp.n).toBe(1);
    expect(cg.n).toBe(1);
  });

  it("clearImportedDocumentRows removes the imported rows but not manual ones", () => {
    clearImportedDocumentRows(pa, docA);
    const importedCp = db
      .prepare(
        "SELECT COUNT(*) n FROM care_plan_items WHERE document_id = ? AND profile_id = ?"
      )
      .get(docA, pa) as { n: number };
    expect(importedCp.n).toBe(0);
    // Manual rows (NULL document_id) survive.
    const manualCp = db
      .prepare(
        "SELECT COUNT(*) n FROM care_plan_items WHERE document_id IS NULL AND profile_id = ?"
      )
      .get(pa) as { n: number };
    const manualCg = db
      .prepare(
        "SELECT COUNT(*) n FROM care_goals WHERE document_id IS NULL AND profile_id = ?"
      )
      .get(pa) as { n: number };
    expect(manualCp.n).toBe(1);
    expect(manualCg.n).toBe(1);
    // Profile B's imported rows are untouched by A's clear.
    const bItems = getCarePlanItems(pb);
    expect(bItems.some((c) => c.description.startsWith("BBB"))).toBe(true);
  });
});
