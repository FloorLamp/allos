// DB INTEGRATION TIER — the condition read-layer collapse must prefer CODE equality
// over name-string equality once rows carry ICD-10-CM codes (#155, strengthening
// #134). Two same-code rows with DIFFERENT display names collapse to one; two
// same-name rows with DIFFERENT codes stay distinct; a coded row never collapses
// with an uncoded same-name row. The SQL COALESCE key must group rows exactly as the
// pure conditionCollapseKey() keys them, so the two engines can't drift.
//
// Runs against a throwaway DB redirected by lib/__db_tests__/setup.ts. Names/codes
// are SYNTHETIC public reference data (no PHI).

import { describe, it, expect, beforeAll } from "vitest";
import { getConditions } from "@/lib/queries";
import { conditionCollapseKey } from "@/lib/icd10";
import { db } from "@/lib/db";

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

// Insert a condition row. The collapse keys on (code-or-name) regardless of source,
// so manual rows (document_id NULL) exercise the code-vs-name preference directly;
// each same-group twin is a stand-in for the cross-document duplicate case.
function insertCondition(
  profileId: number,
  name: string,
  code: string | null,
  codeSystem: string | null
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO conditions (profile_id, name, code, code_system, status)
         VALUES (?, ?, ?, ?, 'active')`
      )
      .run(profileId, name, code, codeSystem).lastInsertRowid
  );
}

let profileId: number;

beforeAll(() => {
  profileId = newProfile("COND-CODE-DEDUP");
});

describe("condition collapse prefers code equality (#155)", () => {
  it("collapses two differently-named rows that share an ICD-10-CM code", () => {
    const p = newProfile("same-code");
    // Same code E11.9, different provider phrasings, different documents.
    insertCondition(p, "Type 2 diabetes mellitus", "E11.9", "ICD-10-CM");
    insertCondition(p, "T2DM", "E11.9", "ICD-10-CM");
    const rows = getConditions(p);
    const e119 = rows.filter((r) => r.code === "E11.9");
    expect(e119.length).toBe(1); // collapsed on the code, not the divergent names
  });

  it("keeps two same-name rows with DIFFERENT codes distinct", () => {
    const p = newProfile("diff-code");
    insertCondition(p, "Diabetes", "E10.9", "ICD-10-CM"); // type 1
    insertCondition(p, "Diabetes", "E11.9", "ICD-10-CM"); // type 2
    const rows = getConditions(p);
    const codes = rows.map((r) => r.code).sort();
    expect(codes).toEqual(["E10.9", "E11.9"]);
  });

  it("never collapses a coded row with an uncoded same-name row", () => {
    const p = newProfile("coded-vs-uncoded");
    insertCondition(p, "Hypertension", "I10", "ICD-10-CM");
    insertCondition(p, "Hypertension", null, null); // uncoded twin
    const rows = getConditions(p);
    expect(rows.length).toBe(2);
  });

  it("groups rows the same way the pure conditionCollapseKey() keys them", () => {
    const p = newProfile("sql-matches-pure");
    const specs = [
      { name: "Asthma", code: "J45.909" },
      { name: "Reactive airway disease", code: "J45.909" }, // same code → same group
      { name: "Asthma", code: null }, // uncoded → its own group
      { name: "Gout", code: "M10.9" },
    ];
    for (const s of specs) {
      insertCondition(p, s.name, s.code, s.code ? "ICD-10-CM" : null);
    }
    const expectedGroups = new Set(specs.map((s) => conditionCollapseKey(s)));
    const rows = getConditions(p);
    // One representative per pure-key group.
    expect(rows.length).toBe(expectedGroups.size);
    const rowKeys = new Set(
      rows.map((r) => conditionCollapseKey({ code: r.code, name: r.name }))
    );
    expect(rowKeys).toEqual(expectedGroups);
  });
});
