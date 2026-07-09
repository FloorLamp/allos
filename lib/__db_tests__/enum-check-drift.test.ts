// DB INTEGRATION TIER (not the pure unit suite in lib/__tests__).
//
// Guards issue #91: inline enum CHECK constraints freeze at first CREATE (because
// migrate() re-applies the schema with `CREATE TABLE IF NOT EXISTS`, a no-op on an
// existing DB) and silently drift from the source enum. Two concerns:
//
//   1. Upgrade path — a DB born with a NARROWER CHECK must, after migrate(), accept
//      a value the source enum has since added (the exact runtime failure #91
//      describes), with existing rows and indexes preserved.
//   2. Drift guard — the ENUM_CHECKS registry that drives boot-time reconciliation
//      must stay in lockstep with the schema's actual inline enum CHECKs, so
//      growing a CHECK in a CREATE block without registering it fails CI instead of
//      failing a self-hoster's upgrade.
//
// Runs via `npm run test:db` (vitest.db.config.ts), :memory: only, no network.

import Database from "better-sqlite3";
import { describe, it, expect } from "vitest";
import { migrate } from "@/lib/db";
import {
  ENUM_CHECKS,
  discoverEnumChecks,
  liveCheckValues,
  type EnumCheck,
} from "@/lib/migrations/enum-checks";

process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "db-test-admin-pw";

function newDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 10000");
  return db;
}

// Independently rebuild a table with a DIFFERENT (here, narrower) enum CHECK,
// simulating a DB born from an older schema. Deliberately NOT the production
// reconcile helper, so the test is an honest end-to-end check of migrate() fixing
// real on-disk drift. Mirrors the SQLite rebuild procedure (foreign_keys off →
// CREATE new → copy → drop → rename → recreate indexes/triggers).
function installOldCheck(
  db: Database.Database,
  table: string,
  column: string,
  oldValues: string[]
): void {
  const { sql } = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?")
    .get(table) as { sql: string };
  const re = new RegExp(
    `CHECK\\s*\\(\\s*"?${column}"?\\s+IN\\s*\\([^)]*\\)\\s*\\)`,
    "i"
  );
  const narrow = `CHECK (${column} IN (${oldValues
    .map((v) => `'${v}'`)
    .join(", ")}))`;
  const patched = sql.replace(re, narrow);
  const temp = `${table}_old`;
  const createSql = patched.replace(
    new RegExp(`^\\s*CREATE\\s+TABLE\\s+"?${table}"?`, "i"),
    `CREATE TABLE ${temp}`
  );
  const aux = db
    .prepare(
      `SELECT sql FROM sqlite_master WHERE tbl_name=? AND type IN ('index','trigger')
         AND sql IS NOT NULL AND name NOT LIKE 'sqlite_%'`
    )
    .all(table) as { sql: string }[];

  db.pragma("foreign_keys = OFF");
  const tx = db.transaction(() => {
    db.exec(`DROP TABLE IF EXISTS ${temp}`);
    db.exec(createSql);
    db.exec(`INSERT INTO ${temp} SELECT * FROM ${table}`);
    db.exec(`DROP TABLE ${table}`);
    db.exec(`ALTER TABLE ${temp} RENAME TO ${table}`);
    for (const a of aux) db.exec(a.sql);
  });
  tx();
  db.pragma("foreign_keys = ON");
}

function key(c: EnumCheck): string {
  return `${c.table}.${c.column}=[${[...c.values].sort().join(",")}]`;
}

describe("enum-check drift guard — registry matches schema", () => {
  it("ENUM_CHECKS exactly covers every inline enum CHECK in the fresh schema", () => {
    const db = newDb();
    migrate(db);

    const discovered = new Set(discoverEnumChecks(db).map(key));
    const registered = new Set(ENUM_CHECKS.map(key));

    const missing = [...discovered].filter((k) => !registered.has(k));
    const extra = [...registered].filter((k) => !discovered.has(k));

    // `missing` = an enum CHECK in the schema not (or wrongly) in ENUM_CHECKS —
    // e.g. someone grew a CHECK in a CREATE block without updating the registry,
    // so upgraded DBs would silently keep the old CHECK. `extra` = a registry
    // entry whose table/column/values no longer match the schema.
    expect(
      missing,
      `enum CHECK(s) in the schema missing from ENUM_CHECKS (register them so #91 reconciliation covers them): ${JSON.stringify(missing)}`
    ).toEqual([]);
    expect(
      extra,
      `ENUM_CHECKS entr(ies) not matching the live schema: ${JSON.stringify(extra)}`
    ).toEqual([]);

    db.close();
  });

  it("registry has no duplicate (table, column) entries", () => {
    const seen = new Set<string>();
    for (const c of ENUM_CHECKS) {
      const k = `${c.table}.${c.column}`;
      expect(seen.has(k), `duplicate ENUM_CHECKS entry for ${k}`).toBe(false);
      seen.add(k);
    }
  });
});

describe("enum-check reconciliation — upgrade path (#91)", () => {
  it("widens a table born with a narrower CHECK so the new enum value inserts", () => {
    const db = newDb();
    migrate(db);

    // Simulate an old DB: activities.type born without 'sport'.
    installOldCheck(db, "activities", "type", ["strength", "cardio"]);
    expect(liveCheckValues(db, "activities", "type")).toEqual([
      "strength",
      "cardio",
    ]);

    // A row valid under the OLD check, to prove the rebuild preserves data.
    db.prepare(
      "INSERT INTO activities (profile_id, date, type, title) VALUES (1,'2026-01-01','cardio','Old run')"
    ).run();

    // Before the fix, inserting the grown value fails on this upgraded DB.
    expect(() =>
      db
        .prepare(
          "INSERT INTO activities (profile_id, date, type, title) VALUES (1,'2026-01-02','sport','Soccer')"
        )
        .run()
    ).toThrow(/CHECK constraint/i);

    // THE UPGRADE: re-run migrate() (a normal boot on the upgraded DB).
    expect(() => migrate(db)).not.toThrow();

    // The live CHECK now matches the source enum...
    const live = liveCheckValues(db, "activities", "type")!;
    expect([...live].sort()).toEqual(["cardio", "sport", "strength"]);

    // ...the new value now inserts...
    expect(() =>
      db
        .prepare(
          "INSERT INTO activities (profile_id, date, type, title) VALUES (1,'2026-01-02','sport','Soccer')"
        )
        .run()
    ).not.toThrow();

    // ...and the pre-existing row survived byte-for-byte.
    const rows = db
      .prepare("SELECT type, title FROM activities ORDER BY date")
      .all() as { type: string; title: string }[];
    expect(rows).toEqual([
      { type: "cardio", title: "Old run" },
      { type: "sport", title: "Soccer" },
    ]);

    db.close();
  });

  it("rebuilds a table with two drifted CHECKs once and keeps its index", () => {
    const db = newDb();
    migrate(db);

    // import_jobs has TWO enum CHECKs (type, status) and a user-defined index.
    installOldCheck(db, "import_jobs", "type", ["workouts"]); // missing 'biomarkers'
    installOldCheck(db, "import_jobs", "status", ["processing", "ready"]); // missing failed/skipped
    db.prepare(
      "INSERT INTO import_jobs (profile_id, type, status) VALUES (1,'workouts','ready')"
    ).run();

    expect(() => migrate(db)).not.toThrow();

    // Both CHECKs reconciled.
    expect([...liveCheckValues(db, "import_jobs", "type")!].sort()).toEqual([
      "biomarkers",
      "workouts",
    ]);
    expect([...liveCheckValues(db, "import_jobs", "status")!].sort()).toEqual([
      "failed",
      "processing",
      "ready",
      "skipped",
    ]);

    // The grown values now insert.
    expect(() =>
      db
        .prepare(
          "INSERT INTO import_jobs (profile_id, type, status) VALUES (1,'biomarkers','failed')"
        )
        .run()
    ).not.toThrow();

    // The user-defined index survived the rebuild.
    const idx = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_import_jobs_created'"
      )
      .get();
    expect(idx).toBeTruthy();

    db.close();
  });

  it("is a no-op on an already-current DB (idempotent, no rebuild)", () => {
    const db = newDb();
    migrate(db);
    // A sentinel row; a spurious rebuild would still preserve it, but the point is
    // migrate() re-runs cleanly with nothing to reconcile.
    db.prepare(
      "INSERT INTO activities (profile_id, date, type, title) VALUES (1,'2026-02-01','sport','Keep me')"
    ).run();
    expect(() => migrate(db)).not.toThrow();
    const row = db
      .prepare("SELECT title FROM activities WHERE date='2026-02-01'")
      .get() as { title: string };
    expect(row.title).toBe("Keep me");
    db.close();
  });
});
