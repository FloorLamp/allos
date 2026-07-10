// DB INTEGRATION TIER (issue #133).
//
// Migration 002 (edit-lock flags + body_metrics uniqueness) against real in-memory
// SQLite handles: a fresh DB and a DB stamped at v1 both end up with the `edited`
// columns and the UNIQUE(profile_id, date, source) index, existing rows default to
// unlocked, and the pre-existing-collision dedup keeps the lowest id while leaving
// NULL-source rows alone. Mirrors runner.test.ts patterns; :memory: only.
//
// Runs via `npm run test:db` (vitest.db.config.ts).

import Database from "better-sqlite3";
import { describe, it, expect } from "vitest";
import { runMigrations, readVersion } from "@/lib/migrations/runner";
import { MIGRATIONS } from "@/lib/migrations/versions";

function newDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 10000");
  return db;
}

function columnNames(db: Database.Database, table: string): Set<string> {
  return new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
      (r) => r.name
    )
  );
}

function indexNames(db: Database.Database, table: string): Set<string> {
  return new Set(
    (db.prepare(`PRAGMA index_list(${table})`).all() as { name: string }[]).map(
      (r) => r.name
    )
  );
}

// A DB with ONLY the baseline applied and stamped at version 1 — the exact shape a
// deployment that shipped before migration 002 has on disk.
function v1Db(): Database.Database {
  const db = newDb();
  MIGRATIONS[0].up(db);
  db.pragma("user_version = 1");
  return db;
}

describe("002 edit-lock flags — schema shape", () => {
  it("a fresh DB gains the edited columns and the body_metrics unique index", () => {
    const db = newDb();
    runMigrations(db);
    expect(readVersion(db)).toBe(MIGRATIONS.length);
    expect(columnNames(db, "body_metrics").has("edited")).toBe(true);
    expect(columnNames(db, "medical_records").has("edited")).toBe(true);
    expect(indexNames(db, "body_metrics").has("idx_body_metrics_source")).toBe(
      true
    );
    db.close();
  });

  it("a v1 DB receives 002 (columns absent before, present after; stamped to 2)", () => {
    const db = v1Db();
    expect(columnNames(db, "body_metrics").has("edited")).toBe(false);
    expect(columnNames(db, "medical_records").has("edited")).toBe(false);

    runMigrations(db);

    expect(readVersion(db)).toBe(2);
    expect(columnNames(db, "body_metrics").has("edited")).toBe(true);
    expect(columnNames(db, "medical_records").has("edited")).toBe(true);
    expect(indexNames(db, "body_metrics").has("idx_body_metrics_source")).toBe(
      true
    );
    db.close();
  });

  it("existing rows default to unlocked (edited = 0)", () => {
    const db = v1Db();
    const pid = Number(
      db.prepare("INSERT INTO profiles (name) VALUES ('EL')").run()
        .lastInsertRowid
    );
    db.prepare(
      "INSERT INTO body_metrics (profile_id, date, weight_kg, source) VALUES (?,?,?,?)"
    ).run(pid, "2024-01-01", 80, "health-connect");
    db.prepare(
      "INSERT INTO medical_records (profile_id, date, category, name, external_id, source) VALUES (?,?,?,?,?,?)"
    ).run(pid, "2024-01-01", "vitals", "Systolic", "hc:v:1", "health-connect");

    runMigrations(db);

    expect(
      (
        db
          .prepare("SELECT edited FROM body_metrics WHERE profile_id = ?")
          .get(pid) as { edited: number }
      ).edited
    ).toBe(0);
    expect(
      (
        db
          .prepare("SELECT edited FROM medical_records WHERE profile_id = ?")
          .get(pid) as { edited: number }
      ).edited
    ).toBe(0);
    db.close();
  });
});

describe("002 edit-lock flags — pre-existing collision dedup", () => {
  it("keeps the lowest id per (profile,date,source) and leaves NULL-source rows alone", () => {
    const db = v1Db();
    const pid = Number(
      db.prepare("INSERT INTO profiles (name) VALUES ('DUP')").run()
        .lastInsertRowid
    );
    const ins = db.prepare(
      "INSERT INTO body_metrics (profile_id, date, weight_kg, source) VALUES (?,?,?,?)"
    );
    const keep = Number(
      ins.run(pid, "2024-02-01", 80, "health-connect").lastInsertRowid
    );
    // A second same-key row (only possible pre-constraint) must be collapsed.
    ins.run(pid, "2024-02-01", 81, "health-connect");
    // Two manual weigh-ins the same day are legitimate — NULL source is exempt.
    ins.run(pid, "2024-02-01", 70, null);
    ins.run(pid, "2024-02-01", 71, null);

    runMigrations(db);

    const rows = db
      .prepare(
        "SELECT id, weight_kg, source FROM body_metrics WHERE profile_id = ? ORDER BY id"
      )
      .all(pid) as { id: number; weight_kg: number; source: string | null }[];
    const hc = rows.filter((r) => r.source === "health-connect");
    expect(hc).toHaveLength(1);
    expect(hc[0].id).toBe(keep);
    expect(hc[0].weight_kg).toBe(80);
    expect(rows.filter((r) => r.source === null)).toHaveLength(2);
    db.close();
  });
});
