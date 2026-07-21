// DB INTEGRATION TIER (not the pure unit suite in lib/__tests__).
//
// Exercises the fresh-schema boot path: `migrate()` (the baseline apply + the
// per-boot tasks) on an empty in-memory database, and its idempotency — the
// baseline is pure `CREATE ... IF NOT EXISTS`, so replaying it on an up-to-date
// database must be a no-op. (The historical "strip additive columns and re-run"
// old-release reconstruction is gone with the legacy upgrade machinery — the
// versioned runner + the append-only hash manifest are what guard schema changes
// now; see lib/migrations/runner.ts and issue #119.)
//
// The whole suite runs via `npm run test:db` (vitest.db.config.ts) and is gated
// in CI. Deterministic: `:memory:` only, no network, no data/allos.db reliance.

import Database from "better-sqlite3";
import { describe, it, expect } from "vitest";
import { migrate } from "@/lib/db";

// Keep bootstrapAuth() (run inside migrate) deterministic and quiet instead of
// generating + logging a random admin password on every migrate() call.
process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "db-test-admin-pw";

function newDb(): Database.Database {
  const db = new Database(":memory:");
  // Match createDb()'s runtime pragmas so the test DB behaves like production.
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 10000");
  return db;
}

function tableNames(db: Database.Database): Set<string> {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all() as { name: string }[];
  return new Set(rows.map((r) => r.name));
}

function columnNames(db: Database.Database, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as {
    name: string;
  }[];
  return new Set(rows.map((r) => r.name));
}

describe("migrate() — fresh boot", () => {
  it("runs to completion on an empty database without throwing", () => {
    const db = newDb();
    expect(() => migrate(db)).not.toThrow();

    // Spot-check a representative slice of the schema exists.
    const tables = tableNames(db);
    for (const t of [
      "profiles",
      "logins",
      "sessions",
      "activities",
      "exercise_sets",
      "body_metrics",
      "medical_records",
      "intake_items",
      "goals",
      "narratives",
    ]) {
      expect(tables.has(t)).toBe(true);
    }

    // ...including columns that historically arrived post-CREATE (now inline).
    expect(columnNames(db, "intake_items").has("document_id")).toBe(true);
    expect(columnNames(db, "activities").has("source")).toBe(true);
    expect(columnNames(db, "medical_records").has("canonical_name")).toBe(true);
    expect(columnNames(db, "integration_sync_events").has("raw_ref")).toBe(
      true
    );
    expect(columnNames(db, "metric_samples").has("activity_external_id")).toBe(
      true
    );
    expect(columnNames(db, "metric_samples").has("origin")).toBe(true);
    expect(columnNames(db, "integration_sync_events").has("details")).toBe(
      true
    );
    // The final intake_item_logs shape keys logs on the dose, and migration 011
    // renamed its (and intake_item_doses') supplement_id link to item_id.
    expect(columnNames(db, "intake_item_logs").has("dose_id")).toBe(true);
    expect(columnNames(db, "intake_item_logs").has("item_id")).toBe(true);
    expect(columnNames(db, "intake_item_logs").has("supplement_id")).toBe(
      false
    );
    expect(columnNames(db, "intake_item_doses").has("item_id")).toBe(true);
    expect(columnNames(db, "intake_item_doses").has("supplement_id")).toBe(
      false
    );

    // Boot tasks ran: the bootstrap admin + profile 1 and the canonical seed.
    expect(
      (db.prepare("SELECT COUNT(*) AS c FROM logins").get() as { c: number }).c
    ).toBe(1);
    expect(
      (
        db.prepare("SELECT COUNT(*) AS c FROM canonical_biomarkers").get() as {
          c: number;
        }
      ).c
    ).toBeGreaterThan(0);

    db.close();
  });
});

describe("migrate() — idempotency (up-to-date DB replays as a no-op)", () => {
  it("can be run twice on the same database without throwing or changing schema", () => {
    const db = newDb();
    migrate(db);
    const before = db
      .prepare(
        "SELECT group_concat(sql, ';') AS s FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name"
      )
      .get() as { s: string };

    expect(() => migrate(db)).not.toThrow();

    const after = db
      .prepare(
        "SELECT group_concat(sql, ';') AS s FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name"
      )
      .get() as { s: string };
    expect(after.s).toBe(before.s);
    db.close();
  });
});
