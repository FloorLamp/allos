// DB INTEGRATION TIER — intake-family schema-debt invariants (issue #97, migration
// 011). Pure hygiene: these assertions pin the schema shape and the same-profile
// integrity that the app upholds in code, as a cheap drift backstop.
//
//   1. RENAME — intake_item_doses / intake_item_logs expose `item_id` (not the old
//      `supplement_id`), and the FK still points at intake_items.
//   2. REDUNDANT COLUMN KEPT — intake_item_logs.item_id is a denormalized shortcut;
//      it must always equal the parent dose's item_id (consistency assertion, the
//      reason the column was kept rather than dropped).
//   3. UNORDERED PAIR — intake_item_pairs enforces CHECK (a_id < b_id), so the
//      reversed duplicate can no longer be stored.
//   4. CROSS-PROFILE — pair endpoints, and a log's item vs its dose's item, live in
//      the same profile over seeded data.
//
// The db singleton is redirected at a per-file temp DB by setup.ts, whose fresh
// open runs every migration (including 011).

import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { db } from "@/lib/db";
import { seedProfile } from "./fixtures";
import { orderIntakePair } from "@/lib/intake-pairs";

function columnNames(table: string): Set<string> {
  return new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
      (r) => r.name
    )
  );
}

function fkTargets(table: string, column: string): string[] {
  return (
    db.prepare(`PRAGMA foreign_key_list(${table})`).all() as {
      table: string;
      from: string;
    }[]
  )
    .filter((r) => r.from === column)
    .map((r) => r.table);
}

describe("migration 011 — intake column rename", () => {
  it("renamed supplement_id → item_id on doses and logs, keeping the FK", () => {
    const doseCols = columnNames("intake_item_doses");
    expect(doseCols.has("item_id")).toBe(true);
    expect(doseCols.has("supplement_id")).toBe(false);
    expect(fkTargets("intake_item_doses", "item_id")).toContain("intake_items");

    const logCols = columnNames("intake_item_logs");
    expect(logCols.has("item_id")).toBe(true);
    expect(logCols.has("supplement_id")).toBe(false);
    expect(logCols.has("dose_id")).toBe(true);
    expect(fkTargets("intake_item_logs", "item_id")).toContain("intake_items");
  });
});

describe("migration 011 — intake_item_logs.item_id kept as a consistent shortcut", () => {
  it("every log's item_id equals its parent dose's item_id (finding #2)", () => {
    seedProfile("logs-consistency");
    const mismatches = (
      db
        .prepare(
          `SELECT COUNT(*) AS c
             FROM intake_item_logs l
             JOIN intake_item_doses d ON d.id = l.dose_id
            WHERE l.item_id IS NOT NULL AND l.item_id <> d.item_id`
        )
        .get() as { c: number }
    ).c;
    expect(mismatches).toBe(0);
  });
});

describe("migration 011 — intake_item_pairs canonical ordering (finding #3)", () => {
  it("enforces CHECK (a_id < b_id), blocking an unordered insert", () => {
    const fx = seedProfile("pairs-check");
    const other = Number(
      db
        .prepare(
          `INSERT INTO intake_items
             (profile_id, name, active, kind, condition, priority)
           VALUES (?, 'Zinc', 1, 'supplement', 'daily', 'low')`
        )
        .run(fx.profileId).lastInsertRowid
    );
    const [a, b] = orderIntakePair(fx.supplementId, other);

    // Canonical (a < b) insert succeeds.
    db.prepare(
      `INSERT INTO intake_item_pairs (a_id, b_id, relation) VALUES (?, ?, 'separate')`
    ).run(a, b);

    // The reversed pair is a UNIQUE-collapsed duplicate AND violates the CHECK —
    // either way it must be refused.
    expect(() =>
      db
        .prepare(
          `INSERT INTO intake_item_pairs (a_id, b_id, relation) VALUES (?, ?, 'separate')`
        )
        .run(b, a)
    ).toThrow();

    // A brand-new unordered pair (distinct ids, a > b) is refused by the CHECK.
    expect(() =>
      db
        .prepare(
          `INSERT INTO intake_item_pairs (a_id, b_id, relation) VALUES (?, ?, 'with')`
        )
        .run(b, a)
    ).toThrow(/CHECK/i);
  });
});

describe("migration 011 — same-profile child integrity (finding #4)", () => {
  it("pair endpoints and a log's item/dose-item share one profile over seeded data", () => {
    const a = seedProfile("cross-a");
    const b = seedProfile("cross-b");

    // A pair within profile A.
    const other = Number(
      db
        .prepare(
          `INSERT INTO intake_items
             (profile_id, name, active, kind, condition, priority)
           VALUES (?, 'Magnesium', 1, 'supplement', 'daily', 'low')`
        )
        .run(a.profileId).lastInsertRowid
    );
    const [lo, hi] = orderIntakePair(a.supplementId, other);
    db.prepare(
      `INSERT INTO intake_item_pairs (a_id, b_id, relation) VALUES (?, ?, 'with')`
    ).run(lo, hi);

    // Both pair endpoints resolve to the same profile.
    const pairViolations = (
      db
        .prepare(
          `SELECT COUNT(*) AS c
             FROM intake_item_pairs p
             JOIN intake_items ia ON ia.id = p.a_id
             JOIN intake_items ib ON ib.id = p.b_id
            WHERE ia.profile_id <> ib.profile_id`
        )
        .get() as { c: number }
    ).c;
    expect(pairViolations).toBe(0);

    // A log's denormalized item and its dose's parent item share a profile.
    const logViolations = (
      db
        .prepare(
          `SELECT COUNT(*) AS c
             FROM intake_item_logs l
             JOIN intake_items li ON li.id = l.item_id
             JOIN intake_item_doses d ON d.id = l.dose_id
             JOIN intake_items di ON di.id = d.item_id
            WHERE li.profile_id <> di.profile_id`
        )
        .get() as { c: number }
    ).c;
    expect(logViolations).toBe(0);

    // Sanity: the two profiles are distinct so the invariant isn't vacuous.
    expect(a.profileId).not.toBe(b.profileId);
  });
});

// Guard the in-transaction canonicalization + reversed-dup collapse of migration
// 011's pairs rebuild directly (a fresh handle so it runs the migration from an
// unordered legacy shape). Mirrors migrate()'s foreign_keys-off application.
describe("migration 011 — pairs rebuild canonicalizes legacy rows", () => {
  it("swaps a>b rows and collapses reversed duplicates", async () => {
    const mem = new Database(":memory:");
    mem.pragma("foreign_keys = ON");
    // Build the pre-011 shape (unordered pairs, no CHECK) and two items.
    mem.pragma("foreign_keys = OFF");
    mem.exec(`
      CREATE TABLE intake_items (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT);
      INSERT INTO intake_items (id, name) VALUES (1, 'A'), (2, 'B'), (3, 'C');
      CREATE TABLE intake_item_pairs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        a_id INTEGER NOT NULL REFERENCES intake_items(id) ON DELETE CASCADE,
        b_id INTEGER NOT NULL REFERENCES intake_items(id) ON DELETE CASCADE,
        relation TEXT NOT NULL DEFAULT 'separate' CHECK (relation IN ('with','separate')),
        note TEXT,
        UNIQUE (a_id, b_id, relation)
      );
    `);
    // (3,1,'with') unordered, plus its reverse (1,3,'with') — a legacy dup — and a
    // self-pair (2,2) that cannot satisfy a<b.
    mem
      .prepare(
        `INSERT INTO intake_item_pairs (a_id, b_id, relation, note) VALUES (?,?,?,?)`
      )
      .run(3, 1, "with", "kept");
    mem
      .prepare(
        `INSERT INTO intake_item_pairs (a_id, b_id, relation, note) VALUES (?,?,?,?)`
      )
      .run(1, 3, "with", "dup");
    mem
      .prepare(
        `INSERT INTO intake_item_pairs (a_id, b_id, relation, note) VALUES (?,?,?,?)`
      )
      .run(2, 2, "separate", "self");

    const { up } =
      await import("@/lib/migrations/versions/011-intake-schema-debt");
    up(mem);

    const rows = mem
      .prepare(
        `SELECT a_id, b_id, relation, note FROM intake_item_pairs ORDER BY id`
      )
      .all() as {
      a_id: number;
      b_id: number;
      relation: string;
      note: string;
    }[];
    // One surviving row: (1,3,'with') — canonicalized, earliest id ("kept") wins,
    // the self-pair dropped.
    expect(rows).toEqual([
      { a_id: 1, b_id: 3, relation: "with", note: "kept" },
    ]);
    // CHECK is now present and blocks an unordered insert.
    expect(() =>
      mem
        .prepare(`INSERT INTO intake_item_pairs (a_id, b_id) VALUES (2, 1)`)
        .run()
    ).toThrow(/CHECK/i);
    mem.close();
  });
});
