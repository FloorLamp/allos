// DB INTEGRATION TIER (not the pure unit suite in lib/__tests__).
//
// Exercises the versioned migration runner (issue #119) against real in-memory
// SQLite handles: the fresh-replay path, the version stamp, no-op re-runs, the
// "a DB stamped at N only receives N+1…" upgrade property, and the downgrade guard
// that fails a rolled-back build meeting a newer DB.
//
// Runs via `npm run test:db` (vitest.db.config.ts); deterministic, :memory: only.

import Database from "better-sqlite3";
import { describe, it, expect } from "vitest";
import { runMigrations, readVersion } from "@/lib/migrations/runner";
import { MIGRATIONS } from "@/lib/migrations/versions";

// bootstrapAuth is a per-boot task (not the runner), but importing lib/db.ts is
// unnecessary here — the runner never touches auth. Keep the env quiet regardless.
process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "db-test-admin-pw";

function newDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 10000");
  return db;
}

function tableNames(db: Database.Database): Set<string> {
  return new Set(
    (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all() as { name: string }[]
    ).map((r) => r.name)
  );
}

describe("migration runner — registry shape", () => {
  it("has contiguous 1-based ids matching array position", () => {
    MIGRATIONS.forEach((m, i) => {
      expect(m.id).toBe(i + 1);
      expect(typeof m.name).toBe("string");
      expect(m.name.length).toBeGreaterThan(0);
    });
    // No duplicate ids.
    expect(new Set(MIGRATIONS.map((m) => m.id)).size).toBe(MIGRATIONS.length);
  });
});

describe("migration runner — fresh replay", () => {
  it("runs every migration and stamps user_version to MIGRATIONS.length", () => {
    const db = newDb();
    expect(readVersion(db)).toBe(0);
    runMigrations(db);
    expect(readVersion(db)).toBe(MIGRATIONS.length);

    // Baseline built the schema — spot-check a representative slice.
    const tables = tableNames(db);
    for (const t of ["profiles", "logins", "activities", "medical_records"]) {
      expect(tables.has(t)).toBe(true);
    }
    db.close();
  });

  it("is a total no-op when re-run at the current version", () => {
    const db = newDb();
    runMigrations(db);
    const before = readVersion(db);
    const schemaBefore = db
      .prepare(
        "SELECT group_concat(name) AS s FROM sqlite_master WHERE type='table' ORDER BY name"
      )
      .get() as { s: string };

    expect(() => runMigrations(db)).not.toThrow();
    expect(readVersion(db)).toBe(before);
    const schemaAfter = db
      .prepare(
        "SELECT group_concat(name) AS s FROM sqlite_master WHERE type='table' ORDER BY name"
      )
      .get() as { s: string };
    expect(schemaAfter.s).toBe(schemaBefore.s);
    db.close();
  });
});

describe("migration runner — stamped-at-N upgrade path", () => {
  it("a DB stamped at MIGRATIONS.length receives no migrations", () => {
    // An EMPTY DB pre-stamped at the latest version must NOT have baseline applied
    // — the runner trusts the stamp and skips ids <= version. (This is the exact
    // property that lets a fully-migrated deployment skip the replayed history.)
    const db = newDb();
    db.pragma(`user_version = ${MIGRATIONS.length}`);
    runMigrations(db);
    expect(readVersion(db)).toBe(MIGRATIONS.length);
    expect(tableNames(db).has("activities")).toBe(false); // baseline skipped
    db.close();
  });

  it("a DB at version 0 replays from the beginning", () => {
    const db = newDb();
    db.pragma("user_version = 0");
    runMigrations(db);
    expect(readVersion(db)).toBe(MIGRATIONS.length);
    expect(tableNames(db).has("activities")).toBe(true);
    db.close();
  });
});

describe("migration runner — downgrade guard", () => {
  it("fails the boot when user_version is ahead of the code, naming restore.ts", () => {
    const db = newDb();
    const ahead = MIGRATIONS.length + 1;
    db.pragma(`user_version = ${ahead}`);
    expect(() => runMigrations(db)).toThrow(/restore\.ts/);
    // The error names BOTH versions so an operator can see the mismatch.
    expect(() => runMigrations(db)).toThrow(new RegExp(String(ahead)));
    expect(() => runMigrations(db)).toThrow(
      new RegExp(String(MIGRATIONS.length))
    );
    // Nothing was applied.
    expect(readVersion(db)).toBe(ahead);
    db.close();
  });
});
