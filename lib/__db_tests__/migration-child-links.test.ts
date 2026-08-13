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
// THE OTHER HALF — issue #2680. `CHILD_LINKS` is about NON-CASCADING parents only:
// the ones whose reference must BLOCK a delete. It says nothing about CASCADING
// children, and its silence used to read as coverage. Those are the opposite
// obligation (clean up, not block) and the runner cannot discharge it for you: every
// migration applies with `foreign_keys = OFF` (issue #95, for safe table rebuilds),
// so `ON DELETE CASCADE` fires for nothing and a bare `DELETE FROM parent` inside a
// migration ORPHANS its cascading children — while the same delete at runtime removes
// them. The later suites in this file reproduce that through the real runner, pin the
// cascading children of `medical_records` the way the first half pins the
// non-cascading parents, and check lib/migrations/cascade-delete.ts (the fix) against
// what a runtime delete actually does.
//
// SYNTHETIC ONLY: fictional profiles, deep-past dates, invented values. No PHI.

import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  deleteRowsWithCascade,
  inboundDeleteLinks,
  sweepOrphanedCascadeRows,
} from "@/lib/migrations/cascade-delete";
import { runMigrations } from "@/lib/migrations/runner";
import { up as up184 } from "@/lib/migrations/versions/184-care-plan-dangling-record-links";
import { up as upSweep } from "@/lib/migrations/versions/20260813-cascade-orphan-sweep";

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
    // Both eras: the closed numbered prefix (NNN-slug.ts) and the name-keyed era
    // after it (YYYYMMDD-slug.ts) — a new migration's CHILD_LINKS must be scanned
    // regardless of which naming scheme it shipped under.
    .filter((f) => f.endsWith(".ts") && f !== "index.ts")
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

  // The twin of the pin above, and the reason #2680 exists: these are the links a
  // CHILD_LINKS registry does NOT cover. A migration deleting a medical_records row
  // must clear them itself, because the runner's foreign_keys = OFF means SQLite
  // will not. Frozen for the same reason — a new cascading child of
  // medical_records lands on a reviewer.
  it("pins the CASCADING children of medical_records (the half CHILD_LINKS omits)", () => {
    const links = inboundDeleteLinks(db, "medical_records").map(
      (l) => `${l.table}.${l.columns.join("+")} ${l.action}`
    );
    expect(links.sort()).toEqual([
      "instrument_responses.medical_record_id cascade",
      "medical_record_revisions.record_id cascade",
    ]);
  });

  // lib/migrations/cascade-delete.ts nests one correlated predicate per level and
  // refuses a cycle loudly rather than looping. Neither refusal can be reached
  // today, and this is what keeps that true.
  it("has no self-referencing foreign key anywhere in the schema", () => {
    const tables = (
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
        )
        .all() as { name: string }[]
    ).map((r) => r.name);
    const selfRefs: string[] = [];
    for (const t of tables) {
      const fks = db.prepare(`PRAGMA foreign_key_list("${t}")`).all() as {
        table: string;
        from: string;
      }[];
      for (const fk of fks) {
        if (fk.table.toLowerCase() === t.toLowerCase())
          selfRefs.push(`${t}.${fk.from}`);
      }
    }
    expect(selfRefs).toEqual([]);
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

// ---- #2680: the cascading half ----------------------------------------------

// The minimal real shape: a parent, a CASCADE child, and a grandchild that cascades
// off the child — enough to show that depth matters, kept independent of whatever
// else the baseline supplies.
function cascadeDb(): Database.Database {
  const mem = new Database(":memory:");
  mem.pragma("foreign_keys = ON");
  mem.exec(`
    CREATE TABLE medical_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      name TEXT
    );
    CREATE TABLE medical_record_revisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      record_id INTEGER NOT NULL REFERENCES medical_records(id) ON DELETE CASCADE,
      value TEXT
    );
    CREATE TABLE revision_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      revision_id INTEGER NOT NULL
        REFERENCES medical_record_revisions(id) ON DELETE CASCADE,
      body TEXT
    );
    CREATE TABLE care_plan_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id INTEGER NOT NULL,
      source_medical_record_id INTEGER REFERENCES medical_records(id)
    );
  `);
  mem.exec(`
    INSERT INTO medical_records (id, profile_id, date, name)
      VALUES (4, 1, '2016-02-11', 'Waist Circumference'),
             (5, 1, '2016-02-12', 'Serum Sodium');
    INSERT INTO medical_record_revisions (id, record_id, value)
      VALUES (1, 4, '88'), (2, 5, '140');
    INSERT INTO revision_notes (id, revision_id, body)
      VALUES (1, 1, 'corrected by the lab'), (2, 2, 'unrelated');
  `);
  return mem;
}

function counts(mem: Database.Database): Record<string, number> {
  const one = (t: string) =>
    (mem.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
  return {
    records: one("medical_records"),
    revisions: one("medical_record_revisions"),
    notes: one("revision_notes"),
  };
}

function fkViolations(mem: Database.Database): unknown[] {
  return mem.pragma("foreign_key_check") as unknown[];
}

describe("the runner applies migrations with cascades DISABLED (#2680)", () => {
  it("a bare DELETE inside a migration orphans the cascading children", () => {
    const mem = cascadeDb();
    runMigrations(mem, [
      {
        name: "20990101-synthetic-bare-delete",
        up: (d) => {
          d.prepare("DELETE FROM medical_records WHERE id = ?").run(4);
        },
      },
    ]);
    // The parent is gone; its revision and that revision's note are not.
    expect(counts(mem)).toEqual({ records: 1, revisions: 2, notes: 2 });
    expect(fkViolations(mem)).toEqual([
      {
        table: "medical_record_revisions",
        rowid: 1,
        parent: "medical_records",
        fkid: 0,
      },
    ]);
  });

  it("the SAME delete at runtime cascades all the way down", () => {
    const mem = cascadeDb();
    mem.prepare("DELETE FROM medical_records WHERE id = ?").run(4);
    expect(counts(mem)).toEqual({ records: 1, revisions: 1, notes: 1 });
    expect(fkViolations(mem)).toEqual([]);
  });

  it("deleteRowsWithCascade inside a migration matches the runtime delete", () => {
    const mem = cascadeDb();
    runMigrations(mem, [
      {
        name: "20990101-synthetic-cascade-delete",
        up: (d) => {
          deleteRowsWithCascade(d, "medical_records", [4]);
        },
      },
    ]);
    expect(counts(mem)).toEqual({ records: 1, revisions: 1, notes: 1 });
    expect(fkViolations(mem)).toEqual([]);
  });

  it("reports what it removed, deepest table included", () => {
    const mem = cascadeDb();
    mem.pragma("foreign_keys = OFF");
    expect(deleteRowsWithCascade(mem, "medical_records", [4])).toEqual([
      { table: "revision_notes", action: "cascade", rows: 1 },
      { table: "medical_record_revisions", action: "cascade", rows: 1 },
      { table: "medical_records", action: "parent", rows: 1 },
    ]);
  });

  it("touches nothing when the id set is empty or matches no row", () => {
    const mem = cascadeDb();
    mem.pragma("foreign_keys = OFF");
    expect(deleteRowsWithCascade(mem, "medical_records", [])).toEqual([]);
    expect(deleteRowsWithCascade(mem, "medical_records", [9999])).toEqual([]);
    expect(counts(mem)).toEqual({ records: 2, revisions: 2, notes: 2 });
  });

  it("nulls a SET NULL reference instead of deleting the row that holds it", () => {
    const mem = new Database(":memory:");
    mem.exec(`
      CREATE TABLE activities (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT);
      CREATE TABLE fitness_assessments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        activity_id INTEGER REFERENCES activities(id) ON DELETE SET NULL,
        label TEXT
      );
      INSERT INTO activities (id, title) VALUES (3, 'Meditating');
      INSERT INTO fitness_assessments (id, activity_id, label)
        VALUES (1, 3, 'Sit and reach');
    `);
    expect(deleteRowsWithCascade(mem, "activities", [3])).toEqual([
      { table: "fitness_assessments", action: "set-null", rows: 1 },
      { table: "activities", action: "parent", rows: 1 },
    ]);
    expect(
      mem
        .prepare("SELECT id, activity_id, label FROM fitness_assessments")
        .all()
    ).toEqual([{ id: 1, activity_id: null, label: "Sit and reach" }]);
  });

  it("leaves the NON-cascading half alone — blocking is still CHILD_LINKS' job", () => {
    const mem = cascadeDb();
    mem.pragma("foreign_keys = OFF");
    mem
      .prepare(
        "INSERT INTO care_plan_items (id, profile_id, source_medical_record_id) VALUES (1, 1, 4)"
      )
      .run();
    // The helper deletes what it was told to; it does not notice that a NO ACTION
    // parent still points at the row. That check belongs to the migration.
    deleteRowsWithCascade(mem, "medical_records", [4]);
    expect(
      inboundDeleteLinks(mem, "medical_records").map((l) => l.table)
    ).toEqual(["medical_record_revisions"]);
    expect(
      (
        mem.prepare("SELECT COUNT(*) AS n FROM care_plan_items").get() as {
          n: number;
        }
      ).n
    ).toBe(1);
  });

  it("handles a COMPOSITE cascading key (the portal_accounts shape)", () => {
    const mem = new Database(":memory:");
    mem.exec(`
      CREATE TABLE portal_accounts (
        id INTEGER NOT NULL,
        profile_id INTEGER NOT NULL,
        label TEXT,
        PRIMARY KEY (id)
      );
      CREATE TABLE portal_identities (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        profile_id INTEGER NOT NULL,
        account_id INTEGER NOT NULL,
        name TEXT,
        FOREIGN KEY (profile_id, account_id)
          REFERENCES portal_accounts(profile_id, id) ON DELETE CASCADE
      );
      CREATE UNIQUE INDEX portal_accounts_scoped ON portal_accounts (profile_id, id);
      INSERT INTO portal_accounts (id, profile_id, label) VALUES (2, 1, 'Clinic');
      INSERT INTO portal_identities (id, profile_id, account_id, name)
        VALUES (1, 1, 2, 'Sample Patient');
    `);
    const links = inboundDeleteLinks(mem, "portal_accounts");
    expect(links).toEqual([
      {
        table: "portal_identities",
        columns: ["profile_id", "account_id"],
        parent: "portal_accounts",
        parentColumns: ["profile_id", "id"],
        action: "cascade",
      },
    ]);
    expect(deleteRowsWithCascade(mem, "portal_accounts", [2])).toEqual([
      { table: "portal_identities", action: "cascade", rows: 1 },
      { table: "portal_accounts", action: "parent", rows: 1 },
    ]);
  });
});

describe("migration 20260813-cascade-orphan-sweep clears what is already orphaned", () => {
  // A database in the state migrations 180 / 20260813-bmi-derived-rows left it in.
  function orphanedDb(): Database.Database {
    const mem = cascadeDb();
    mem.pragma("foreign_keys = OFF");
    mem.prepare("DELETE FROM medical_records WHERE id = ?").run(4);
    return mem;
  }

  it("deletes the orphan and its own orphaned child, to a fixed point", () => {
    const mem = orphanedDb();
    expect(counts(mem)).toEqual({ records: 1, revisions: 2, notes: 2 });
    upSweep(mem);
    expect(counts(mem)).toEqual({ records: 1, revisions: 1, notes: 1 });
    expect(fkViolations(mem)).toEqual([]);
  });

  it("reports what it removed", () => {
    const mem = orphanedDb();
    expect(sweepOrphanedCascadeRows(mem)).toEqual([
      {
        table: "medical_record_revisions",
        columns: ["record_id"],
        parent: "medical_records",
        rows: 1,
      },
      {
        table: "revision_notes",
        columns: ["revision_id"],
        parent: "medical_record_revisions",
        rows: 1,
      },
    ]);
  });

  it("is a no-op on a healthy database, and idempotent", () => {
    const mem = cascadeDb();
    upSweep(mem);
    expect(counts(mem)).toEqual({ records: 2, revisions: 2, notes: 2 });
    upSweep(mem);
    expect(counts(mem)).toEqual({ records: 2, revisions: 2, notes: 2 });
  });

  it("never touches a NON-cascading dangling link (migration 184's territory)", () => {
    const mem = orphanedDb();
    mem
      .prepare(
        "INSERT INTO care_plan_items (id, profile_id, source_medical_record_id) VALUES (1, 1, 4)"
      )
      .run();
    upSweep(mem);
    expect(
      mem
        .prepare(
          "SELECT id, source_medical_record_id FROM care_plan_items ORDER BY id"
        )
        .all()
    ).toEqual([{ id: 1, source_medical_record_id: 4 }]);
  });

  it("leaves a NULL cascading reference alone", () => {
    const mem = new Database(":memory:");
    mem.exec(`
      CREATE TABLE notify_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT);
      CREATE TABLE tap_receipts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id INTEGER REFERENCES notify_messages(id) ON DELETE CASCADE,
        note TEXT
      );
      INSERT INTO tap_receipts (id, message_id, note) VALUES (1, NULL, 'manual tap');
    `);
    expect(sweepOrphanedCascadeRows(mem)).toEqual([]);
    expect(
      (
        mem.prepare("SELECT COUNT(*) AS n FROM tap_receipts").get() as {
          n: number;
        }
      ).n
    ).toBe(1);
  });

  it("runs clean against the real migrated schema (nothing to sweep on a fresh boot)", () => {
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });
});

// ---- the ratchet: a row-deleting migration must clear what CASCADE will not ----

// Shipped migrations whose `DELETE FROM <parent>` predates lib/migrations/cascade-delete.ts.
// Every file here is hash-locked by lib/migrations/manifest.json and cannot be
// corrected in place. The list may only SHRINK, and only by a file leaving the repo.
const FROZEN_UNGUARDED_DELETES: readonly {
  file: string;
  table: string;
  why: string;
}[] = [
  {
    file: "092-consolidate-imported-prescriptions.ts",
    table: "medical_records",
    why: "#2680: runs at position 92, before medical_record_revisions exists (migration 120). instrument_responses (066) does exist, so a prescription row carrying one would have been orphaned; 20260813-cascade-orphan-sweep clears anything it left.",
  },
  {
    file: "101-recover-blank-name-prescriptions.ts",
    table: "medical_records",
    why: "#2680: same era and same reasoning as migration 092 above — pre-120, so no revision row to orphan, and the sweep migration clears whatever instrument_responses it did.",
  },
  {
    file: "118-imported-practice-logs.ts",
    table: "activities",
    why: "#2680: NOT a defect — 118 is the precedent. It names the runner's foreign_keys = OFF posture in its own comment, nulls fitness_assessments.activity_id by hand, and refuses to delete an activity that any of its cascading children still reference. The three telemetry children arrive later (migration 159), after it has run.",
  },
  {
    file: "180-waist-circumference-metric.ts",
    table: "medical_records",
    why: "#2680: a real orphaning. Runs after both cascading children exist (066, 120) and clears neither — its CHILD_LINKS registry covers only the non-cascading half. 20260813-cascade-orphan-sweep repairs it.",
  },
  {
    file: "20260813-bmi-derived-rows.ts",
    table: "medical_records",
    why: "#2680: the same orphaning as migration 180, which it was modelled on, and the one the issue reproduced against the real schema. 20260813-cascade-orphan-sweep repairs it.",
  },
];

// Every table named by a `DELETE FROM …` in a migration's SQL. Read out of string
// and template literals via the AST, so a comment DISCUSSING a delete (migration 170
// and 184 both do) is not mistaken for one.
function deletedTables(): { file: string; table: string }[] {
  const out: { file: string; table: string }[] = [];
  for (const file of fs
    .readdirSync(VERSIONS)
    .filter((f) => f.endsWith(".ts") && f !== "index.ts")
    .sort()) {
    const src = fs.readFileSync(path.join(VERSIONS, file), "utf8");
    const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true);
    const scan = (text: string): void => {
      for (const m of text.matchAll(
        /\bDELETE\s+FROM\s+"?([A-Za-z_][\w]*)"?/gi
      )) {
        const table = m[1].toLowerCase();
        if (out.some((o) => o.file === file && o.table === table)) continue;
        out.push({ file, table });
      }
    };
    const visit = (node: ts.Node): void => {
      if (ts.isStringLiteralLike(node)) scan(node.text);
      else if (ts.isTemplateExpression(node)) {
        scan(node.head.text);
        for (const span of node.templateSpans) scan(span.literal.text);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return out;
}

describe("a row-deleting migration clears its cascading children (#2680)", () => {
  const deletes = deletedTables();

  it("finds the DELETE statements at all (the scan is not vacuous)", () => {
    expect(deletes.length).toBeGreaterThan(0);
    expect(
      deletes.some(
        (d) =>
          d.file === "180-waist-circumference-metric.ts" &&
          d.table === "medical_records"
      )
    ).toBe(true);
  });

  it("does not mistake a comment about a delete for a delete", () => {
    // Migration 170's header discusses `DELETE FROM notify_messages`; 184's
    // discusses `DELETE FROM medical_records`. Neither issues one.
    expect(
      deletes.filter(
        (d) =>
          d.file === "170-tap-message-provenance.ts" ||
          d.file === "184-care-plan-dangling-record-links.ts"
      )
    ).toEqual([]);
  });

  it("every delete of a table with cascading children routes through the helper", () => {
    const frozen = new Set(
      FROZEN_UNGUARDED_DELETES.map((f) => `${f.file}|${f.table}`)
    );
    const violations: string[] = [];
    for (const { file, table } of deletes) {
      if (inboundDeleteLinks(db, table).length === 0) continue;
      if (frozen.has(`${file}|${table}`)) continue;
      const src = fs.readFileSync(path.join(VERSIONS, file), "utf8");
      if (src.includes("../cascade-delete")) continue;
      violations.push(`${file}: DELETE FROM ${table}`);
    }
    expect(
      violations,
      "the runner applies migrations with foreign_keys = OFF, so ON DELETE CASCADE " +
        "fires for nothing and this delete orphans its children (#2680). Use " +
        "deleteRowsWithCascade() from lib/migrations/cascade-delete.ts, which " +
        "derives the links from the schema as of THIS migration."
    ).toEqual([]);
  });

  it("reaps the frozen entries (each must still name a real, still-unguarded delete)", () => {
    for (const f of FROZEN_UNGUARDED_DELETES) {
      expect(
        deletes.some((d) => d.file === f.file && d.table === f.table),
        `${f.file} no longer deletes from ${f.table} — drop the entry`
      ).toBe(true);
      expect(
        inboundDeleteLinks(db, f.table).length,
        `${f.table} no longer has cascading children — the entry is stale`
      ).toBeGreaterThan(0);
      expect(f.why.length).toBeGreaterThan(30);
    }
  });
});
