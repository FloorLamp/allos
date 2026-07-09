// DB INTEGRATION TIER (not the pure unit suite in lib/__tests__).
//
// These tests open real better-sqlite3 handles against in-memory databases to
// exercise lib/db.ts's `migrate()` on both a FRESH database and an EXISTING
// ("upgrade") database. The distinction matters: `migrate()` uses
// `CREATE TABLE IF NOT EXISTS` (a no-op on an existing DB) plus additive
// `addColumnIfMissing()` / `CREATE INDEX IF NOT EXISTS` calls. A statement that
// references a column added by `addColumnIfMissing` BEFORE that call runs is
// invisible on a fresh DB (the column is in the CREATE block) but crashes on an
// upgraded DB (the table pre-exists without the column). That is exactly the
// #157 boot crash: an inline index on `intake_items(profile_id, document_id)`.
//
// The whole suite runs via `npm run test:db` (vitest.db.config.ts) and is gated
// in CI. Deterministic: `:memory:` only, no network, no data/allos.db reliance.

import Database from "better-sqlite3";
import { describe, it, expect } from "vitest";
import { migrate, ADDITIVE_COLUMNS } from "@/lib/db";

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
    ]) {
      expect(tables.has(t)).toBe(true);
    }

    // ...including additive columns that only exist post-CREATE-block.
    expect(columnNames(db, "intake_items").has("document_id")).toBe(true);
    expect(columnNames(db, "activities").has("source")).toBe(true);
    expect(columnNames(db, "medical_records").has("canonical_name")).toBe(true);
    // Issue #9's raw-payload pointer column.
    expect(columnNames(db, "integration_sync_events").has("raw_ref")).toBe(
      true
    );

    db.close();
  });
});

describe("migrate() — idempotency", () => {
  it("can be run twice on the same database without throwing", () => {
    const db = newDb();
    migrate(db);
    expect(() => migrate(db)).not.toThrow();
    db.close();
  });
});

describe("migrate() — upgrade path (existing DB)", () => {
  it("re-adds every additive column stripped from an old-release schema", () => {
    // 1. Build the full current schema, capturing the additive-column surface
    //    from THIS run so the derivation is self-updating: any future column
    //    added via addColumnIfMissing is automatically stripped + re-checked.
    const db = newDb();
    ADDITIVE_COLUMNS.length = 0;
    migrate(db);

    // Dedupe (a column may be ensured on multiple boots/paths; here, once).
    // Exclude `profile_id`: it is a FOUNDATIONAL column from the pre-#67
    // single-profile era, not an ordinary additive field. Its profile-scoping
    // indexes (e.g. idx_medical_canonical_ci, idx_intake_items_document) are
    // deliberately created before the backfill loop re-adds profile_id, so a
    // schema stripped of profile_id models a pre-multi-user DB — a distinct,
    // much larger migration surface that this #157 tripwire does not target.
    // Every other additive column (including intake_items.document_id, the exact
    // #157 column) is stripped and re-checked.
    const FOUNDATIONAL_COLUMNS = new Set(["profile_id"]);
    const additive = Array.from(
      new Map(
        ADDITIVE_COLUMNS.map((c) => [`${c.table}.${c.column}`, c])
      ).values()
    ).filter((c) => !FOUNDATIONAL_COLUMNS.has(c.column));
    // Guard against silent degradation: the schema has dozens of additive
    // columns, so a near-empty set means the recording hook regressed.
    expect(additive.length).toBeGreaterThan(20);

    // 2. Reconstruct a plausible PRE-additive ("old release") state: for each
    //    recorded (table, column), drop any manual index whose SQL references
    //    the column, then DROP the column itself (SQLite >= 3.35). This turns
    //    the fresh schema into what an older DB looked like before the columns
    //    (and #157's index) were introduced. FK enforcement off during surgery.
    db.pragma("foreign_keys = OFF");
    const stripped = new Set<string>();
    const skipped: { key: string; reason: string }[] = [];
    for (const { table, column } of additive) {
      const key = `${table}.${column}`;
      // Drop user-defined indexes that reference this column (auto-indexes have
      // NULL sql and can't be dropped by hand — skip those). migrate() recreates
      // its indexes with CREATE INDEX IF NOT EXISTS, so over-dropping is safe.
      const idxs = db
        .prepare(
          `SELECT name, sql FROM sqlite_master
             WHERE type = 'index' AND tbl_name = ?
               AND sql IS NOT NULL AND name NOT LIKE 'sqlite_%'`
        )
        .all(table) as { name: string; sql: string }[];
      for (const idx of idxs) {
        if (new RegExp(`\\b${column}\\b`).test(idx.sql)) {
          try {
            db.exec(`DROP INDEX "${idx.name}"`);
          } catch {
            // Best-effort — if it can't be dropped the column drop below will
            // fail and land in `skipped`, which is fine for a non-critical col.
          }
        }
      }
      try {
        db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
        stripped.add(key);
      } catch (err) {
        // A genuinely undroppable column (e.g. still referenced by a surviving
        // constraint) is skipped so the rest still exercise the upgrade path.
        skipped.push({ key, reason: String(err) });
      }
    }
    db.pragma("foreign_keys = ON");

    // The intake_items.document_id case — the exact #157 bug — MUST be
    // exercised; if it silently stopped being strippable the test is worthless.
    expect(
      stripped.has("intake_items.document_id"),
      `intake_items.document_id must be strippable to reproduce #157; skipped: ${JSON.stringify(
        skipped.filter((s) => s.key === "intake_items.document_id")
      )}`
    ).toBe(true);

    // Confirm the strip really removed the column (table now looks "old").
    expect(columnNames(db, "intake_items").has("document_id")).toBe(false);

    // 3. THE UPGRADE: re-run migrate() on the stripped DB. This is precisely the
    //    boot an existing deployment performs. It must NOT throw...
    expect(() => migrate(db)).not.toThrow();

    // ...and every stripped column must be back afterwards.
    for (const key of stripped) {
      const [table, column] = key.split(/\.(.*)/s);
      expect(
        columnNames(db, table).has(column),
        `expected ${key} to be re-added by migrate()`
      ).toBe(true);
    }

    // Issue #9's raw_ref is a plain additive TEXT column (no dependent index), so
    // it must be part of the stripped set and re-added by the upgrade boot.
    expect(stripped.has("integration_sync_events.raw_ref")).toBe(true);
    expect(columnNames(db, "integration_sync_events").has("raw_ref")).toBe(
      true
    );

    db.close();
  });
});
