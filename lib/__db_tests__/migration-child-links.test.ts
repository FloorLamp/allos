// DB INTEGRATION TIER — issue #2444: a migration's child-link registry must name
// columns that exist, and migration 184 repairs the rows migration 180's did not.
//
// THE DEFECT CLASS. A one-shot row-move migration that deletes rows declares the
// (table, column) pairs that must block a delete — "a row a child table still
// references is SKIPPED" — and probes each with `PRAGMA table_info`, skipping absent
// ones so the migration can run against every historical schema shape. That probe
// cannot tell "this database is older than the table" from "this pair is a typo", so
// a misnamed entry drops out silently and the guard covers nothing while still
// reading like a guard. Migration 180 shipped with three of four entries misnamed.
//
// A typo is only detectable against the FINAL migrated schema, which is a superset of
// every historical shape — so it is detectable HERE and nowhere in the pure tier.
// The first suite reads every migration's source for link-shaped literals and checks
// each pair against the real schema. Migration 180's own three are allowlisted with
// the reason: the file is hash-locked by lib/migrations/manifest.json and cannot be
// corrected in place; migration 184 repairs what they let through.
//
// SYNTHETIC ONLY: fictional profiles, deep-past dates, invented values. No PHI.

import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { up as up184 } from "@/lib/migrations/versions/184-care-plan-dangling-record-links";

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const VERSIONS = path.join(REPO, "lib/migrations/versions");

// Link literals a shipped, frozen migration declares that do NOT match the schema.
// This list may only SHRINK, and only by a migration file leaving the repo — every
// entry is a hash-locked mistake, not a design.
const FROZEN_BAD_LINKS: readonly {
  file: string;
  table: string;
  column: string;
  why: string;
}[] = [
  {
    file: "180-waist-circumference-metric.ts",
    table: "followup_labs",
    column: "source_record_id",
    why: "#2444: no `followup_labs` table has ever existed — follow-up-lab linkage lives on care_plan_items (migration 060). The file is frozen by the hash manifest; migration 184 nulls the links this let 180 orphan.",
  },
  {
    file: "180-waist-circumference-metric.ts",
    table: "followup_labs",
    column: "result_record_id",
    why: "#2444: same nonexistent table as the entry above.",
  },
  {
    file: "180-waist-circumference-metric.ts",
    table: "care_plan_items",
    column: "source_record_id",
    why: "#2444: care_plan_items has no `source_record_id` — the real columns are source_medical_record_id and resolved_by_medical_record_id (migrations 050/060). This is the entry whose absence let 180 delete a live follow-up's source reading.",
  },
];

interface LinkLiteral {
  file: string;
  table: string;
  column: string;
}

// Every `{ table: "…", column: "…" }` object literal in the migration sources. Shape-
// matched rather than name-matched, so renaming CHILD_LINKS does not escape the scan.
function linkLiterals(): LinkLiteral[] {
  const out: LinkLiteral[] = [];
  for (const file of fs
    .readdirSync(VERSIONS)
    .filter((f) => /^\d{3}-.*\.ts$/.test(f))
    .sort()) {
    const src = fs.readFileSync(path.join(VERSIONS, file), "utf8");
    const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
      if (ts.isObjectLiteralExpression(node)) {
        const props = new Map<string, string>();
        for (const p of node.properties) {
          if (!ts.isPropertyAssignment(p) || !ts.isIdentifier(p.name)) continue;
          if (!ts.isStringLiteral(p.initializer)) continue;
          props.set(p.name.text, p.initializer.text);
        }
        const table = props.get("table");
        const column = props.get("column");
        if (table && column) out.push({ file, table, column });
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return out;
}

function columnsOf(table: string): Set<string> {
  try {
    return new Set(
      (
        db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
      ).map((c) => c.name)
    );
  } catch {
    return new Set();
  }
}

describe("migration child-link registries name real columns (#2444)", () => {
  const literals = linkLiterals();

  it("finds the link literals at all (the scan is not vacuous)", () => {
    expect(literals.length).toBeGreaterThan(0);
  });

  it("every declared (table, column) exists in the migrated schema", () => {
    const frozen = new Set(
      FROZEN_BAD_LINKS.map((f) => `${f.file}|${f.table}|${f.column}`)
    );
    const bad = literals
      .filter((l) => !frozen.has(`${l.file}|${l.table}|${l.column}`))
      .filter((l) => !columnsOf(l.table).has(l.column))
      .map((l) => `${l.file}: ${l.table}.${l.column}`);
    expect(
      bad,
      "a link registry naming a table or column the schema does not have is a " +
        "guard that silently covers nothing (#2444). Fix the names — the PRAGMA " +
        "probe these registries use cannot tell a typo from an older database."
    ).toEqual([]);
  });

  it("reaps the frozen bad links (each must still be present and still be wrong)", () => {
    for (const f of FROZEN_BAD_LINKS) {
      expect(
        literals.some(
          (l) =>
            l.file === f.file && l.table === f.table && l.column === f.column
        ),
        `${f.file} no longer declares ${f.table}.${f.column} — drop the entry`
      ).toBe(true);
      expect(
        columnsOf(f.table).has(f.column),
        `${f.table}.${f.column} now EXISTS — the allowlist entry is stale`
      ).toBe(false);
      expect(f.why.length).toBeGreaterThan(30);
    }
  });

  // The pairs a future row-move migration over `medical_records` actually has to
  // block on. Derived from the schema rather than transcribed, and frozen, so adding
  // a non-cascading FK parent to `medical_records` lands on a reviewer instead of
  // quietly widening what such a migration must consider.
  it("pins the non-cascading FK parents of medical_records", () => {
    const tables = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all() as { name: string }[]
    ).map((r) => r.name);
    const parents: string[] = [];
    for (const t of tables) {
      const fks = db.prepare(`PRAGMA foreign_key_list(${t})`).all() as {
        table: string;
        from: string;
        on_delete: string;
      }[];
      for (const fk of fks) {
        if (fk.table !== "medical_records") continue;
        if (fk.on_delete === "CASCADE") continue;
        parents.push(`${t}.${fk.from}`);
      }
    }
    expect(parents.sort()).toEqual([
      "care_plan_items.resolved_by_medical_record_id",
      "care_plan_items.source_medical_record_id",
      "intake_items.source_record_id",
    ]);
  });
});

// ---- migration 184's repair -------------------------------------------------

interface PlanRow {
  id: number;
  source_kind: string | null;
  source_medical_record_id: number | null;
  resolved_by_medical_record_id: number | null;
  resolution: string | null;
}

// The minimal pre-migration shape (the 165/171/174/176/180 pattern), so every claim
// is about migration 184 and not about whatever else the baseline supplies.
function repairDb(): Database.Database {
  const mem = new Database(":memory:");
  mem.exec(`
    CREATE TABLE medical_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      name TEXT
    );
    CREATE TABLE care_plan_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id INTEGER NOT NULL,
      description TEXT NOT NULL,
      source_kind TEXT,
      source_medical_record_id INTEGER,
      resolved_by_medical_record_id INTEGER,
      resolution TEXT,
      resolved_at TEXT
    );
  `);
  mem
    .prepare(
      "INSERT INTO medical_records (id, profile_id, date, name) VALUES (7, 1, '2017-05-02', 'Waist Circumference')"
    )
    .run();
  return mem;
}

function plans(mem: Database.Database): PlanRow[] {
  return mem
    .prepare(
      `SELECT id, source_kind, source_medical_record_id,
              resolved_by_medical_record_id, resolution
         FROM care_plan_items ORDER BY id`
    )
    .all() as PlanRow[];
}

describe("migration 184 nulls the links migration 180 orphaned (#2444)", () => {
  it("de-links a follow-up whose source reading is gone, source_kind and all", () => {
    const mem = repairDb();
    // id 9 is the reading migration 180 deleted out from under this follow-up.
    mem
      .prepare(
        `INSERT INTO care_plan_items
           (id, profile_id, description, source_kind, source_medical_record_id)
         VALUES (1, 1, 'Recheck waist', 'labs', 9)`
      )
      .run();
    up184(mem);
    expect(plans(mem)).toEqual([
      {
        id: 1,
        source_kind: null,
        source_medical_record_id: null,
        resolved_by_medical_record_id: null,
        resolution: null,
      },
    ]);
  });

  it("nulls a dangling resolved-by link without touching source_kind or the resolution", () => {
    const mem = repairDb();
    mem
      .prepare(
        `INSERT INTO care_plan_items
           (id, profile_id, description, source_kind, source_medical_record_id,
            resolved_by_medical_record_id, resolution)
         VALUES (1, 1, 'Recheck waist', 'labs', 7, 9, 'resolved')`
      )
      .run();
    up184(mem);
    // The source reading (7) is still there, so the follow-up stays TRACKED; only the
    // vanished resolving reading is de-linked, and the closure it recorded stands.
    expect(plans(mem)).toEqual([
      {
        id: 1,
        source_kind: "labs",
        source_medical_record_id: 7,
        resolved_by_medical_record_id: null,
        resolution: "resolved",
      },
    ]);
  });

  it("leaves a live link completely alone, and is idempotent", () => {
    const mem = repairDb();
    mem
      .prepare(
        `INSERT INTO care_plan_items
           (id, profile_id, description, source_kind, source_medical_record_id,
            resolved_by_medical_record_id)
         VALUES (1, 1, 'Recheck waist', 'labs', 7, 7)`
      )
      .run();
    const before = plans(mem);
    up184(mem);
    up184(mem);
    expect(plans(mem)).toEqual(before);
  });

  it("leaves an unlinked care-plan item alone", () => {
    const mem = repairDb();
    mem
      .prepare(
        `INSERT INTO care_plan_items (id, profile_id, description)
         VALUES (1, 1, 'Generic plan item')`
      )
      .run();
    const before = plans(mem);
    up184(mem);
    expect(plans(mem)).toEqual(before);
  });
});
