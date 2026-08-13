// DB INTEGRATION TIER (not the pure unit suite in lib/__tests__).
//
// Exercises the versioned migration runner (issue #119; name-keyed ledger since
// #2601's follow-up) against real in-memory SQLite handles: the fresh-replay
// path, the schema_migrations ledger, the numbered-era backfill from a
// pre-ledger user_version stamp, no-op re-runs, the dev-only order-divergence
// tolerance, the registry-shape assertions (the numbered era is CLOSED), and the
// downgrade guards that fail a rolled-back build meeting a newer DB.
//
// Runs via `npm run test:db` (vitest.db.config.ts); deterministic, :memory: only.

import Database from "better-sqlite3";
import { describe, it, expect } from "vitest";
import {
  runMigrations,
  readVersion,
  type Migration,
} from "@/lib/migrations/runner";
import { MIGRATIONS } from "@/lib/migrations/versions";

// bootstrapAuth is a per-boot task (not the runner), but importing lib/db.ts is
// unnecessary here — the runner never touches auth. Keep the env quiet regardless.
process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "db-test-admin-pw";

const LEGACY_COUNT = 185;

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

function ledgerNames(db: Database.Database): string[] {
  return (
    db.prepare("SELECT name FROM schema_migrations ORDER BY rowid").all() as {
      name: string;
    }[]
  ).map((r) => r.name);
}

// A tiny synthetic migration for the injectable-registry tests: creates (or
// inserts into) a marker table so application order is observable.
function marker(
  name: string,
  id?: number
): Migration & { applications: () => number } {
  let count = 0;
  return {
    name,
    id,
    up(db) {
      db.exec(`CREATE TABLE IF NOT EXISTS applied_order (name TEXT NOT NULL)`);
      db.prepare(`INSERT INTO applied_order (name) VALUES (?)`).run(name);
      count++;
    },
    applications: () => count,
  };
}

describe("migration runner — registry shape (the real registry)", () => {
  it("the numbered era is a frozen contiguous prefix of exactly 185, then name-keyed only", () => {
    const numbered = MIGRATIONS.filter((m) => m.id !== undefined);
    expect(numbered.length).toBe(LEGACY_COUNT);
    numbered.forEach((m, i) => {
      expect(m.id).toBe(i + 1);
      expect(MIGRATIONS[i]).toBe(m); // ids sit at the FRONT of the array
    });
    // Everything after the numbered prefix is name-keyed, date-slug named.
    for (const m of MIGRATIONS.slice(LEGACY_COUNT)) {
      expect(m.id).toBeUndefined();
      expect(m.name).toMatch(/^\d{8}-[a-z0-9-]+$/);
    }
    // Names are the ledger's primary key.
    expect(new Set(MIGRATIONS.map((m) => m.name)).size).toBe(MIGRATIONS.length);
  });
});

describe("migration runner — fresh replay", () => {
  it("runs every migration, records every name, and stamps user_version to the count", () => {
    const db = newDb();
    expect(readVersion(db)).toBe(0);
    runMigrations(db);
    expect(readVersion(db)).toBe(MIGRATIONS.length);
    expect(ledgerNames(db)).toEqual(MIGRATIONS.map((m) => m.name));

    // Baseline built the schema — spot-check a representative slice.
    const tables = tableNames(db);
    for (const t of ["profiles", "logins", "activities", "medical_records"]) {
      expect(tables.has(t)).toBe(true);
    }
    db.close();
  });

  it("is a total no-op when re-run on a current database", () => {
    const db = newDb();
    runMigrations(db);
    const before = readVersion(db);
    const ledgerBefore = ledgerNames(db);
    const schemaBefore = db
      .prepare(
        "SELECT group_concat(name) AS s FROM sqlite_master WHERE type='table' ORDER BY name"
      )
      .get() as { s: string };

    expect(() => runMigrations(db)).not.toThrow();
    expect(readVersion(db)).toBe(before);
    expect(ledgerNames(db)).toEqual(ledgerBefore);
    const schemaAfter = db
      .prepare(
        "SELECT group_concat(name) AS s FROM sqlite_master WHERE type='table' ORDER BY name"
      )
      .get() as { s: string };
    expect(schemaAfter.s).toBe(schemaBefore.s);
    db.close();
  });
});

describe("migration runner — numbered-era backfill", () => {
  it("a pre-ledger DB stamped at N gains ledger rows for migrations 1..N and receives only the rest", () => {
    // A database written by a pre-ledger release has user_version = N, no
    // schema_migrations table, and (by that release's contiguity invariant)
    // exactly migrations 1..N applied. Simulate one mid-history: apply the first
    // K numbered migrations by hand, stamp K, then hand the DB to the runner.
    const K = 3;
    const db = newDb();
    db.pragma("foreign_keys = OFF");
    for (const m of MIGRATIONS.slice(0, K)) m.up(db);
    db.pragma("foreign_keys = ON");
    db.pragma(`user_version = ${K}`);

    runMigrations(db);
    expect(ledgerNames(db)).toEqual(MIGRATIONS.map((m) => m.name));
    expect(readVersion(db)).toBe(MIGRATIONS.length);
    // The backfilled prefix carries an applied_at like every other row.
    const nullAt = db
      .prepare(
        "SELECT count(*) AS n FROM schema_migrations WHERE applied_at IS NULL OR applied_at = ''"
      )
      .get() as { n: number };
    expect(nullAt.n).toBe(0);
    db.close();
  });

  it("a fully-stamped pre-ledger DB receives nothing and keeps its stamp", () => {
    // An EMPTY DB pre-stamped at the numbered ceiling must NOT have the numbered
    // migrations applied — the backfill trusts the stamp (this is the exact
    // property that lets a fully-migrated deployment skip the replayed history).
    // Name-keyed migrations after the ceiling WOULD still apply, which is the
    // upgrade path working; the real registry's numbered ceiling is asserted
    // above, so slice to it for a pure "nothing to do" case.
    const db = newDb();
    db.pragma(`user_version = ${LEGACY_COUNT}`);
    runMigrations(db, MIGRATIONS.slice(0, LEGACY_COUNT));
    expect(readVersion(db)).toBe(LEGACY_COUNT);
    expect(tableNames(db).has("activities")).toBe(false); // baseline skipped
    expect(ledgerNames(db).length).toBe(LEGACY_COUNT);
    db.close();
  });
});

describe("migration runner — name-keyed era (injected registries)", () => {
  // A two-migration legacy prefix the synthetic cases build on.
  function legacyPair(): (Migration & { applications: () => number })[] {
    return [marker("001-first", 1), marker("002-second", 2)];
  }

  it("applies name-keyed migrations in array order and bumps user_version past the numbered ceiling", () => {
    const db = newDb();
    const regs = [...legacyPair(), marker("20260812-alpha")];
    runMigrations(db, regs);
    expect(ledgerNames(db)).toEqual([
      "001-first",
      "002-second",
      "20260812-alpha",
    ]);
    expect(readVersion(db)).toBe(3);

    // A later boot with one more name-keyed migration applies only it.
    const beta = marker("20260813-beta");
    runMigrations(db, [...regs, beta]);
    expect(beta.applications()).toBe(1);
    expect(regs[2].applications()).toBe(1); // alpha not reapplied
    expect(readVersion(db)).toBe(4);
    db.close();
  });

  it("tolerates dev-only order divergence: a missing earlier migration is applied late, nothing reapplies", () => {
    // The branch-then-merge shape: this DB applied X while main gained Y earlier
    // in the array. After the merge the registry is [..., Y, X]; X stays applied,
    // Y is applied on the next boot.
    const db = newDb();
    const legacy = legacyPair();
    const x = marker("20260812-branch-x");
    runMigrations(db, [...legacy, x]);

    const y = marker("20260812-main-y");
    runMigrations(db, [...legacy, y, x]);
    expect(y.applications()).toBe(1);
    expect(x.applications()).toBe(1);
    expect(
      (
        db.prepare("SELECT name FROM applied_order ORDER BY rowid").all() as {
          name: string;
        }[]
      ).map((r) => r.name)
    ).toEqual([
      "001-first",
      "002-second",
      "20260812-branch-x",
      "20260812-main-y",
    ]);
    expect(readVersion(db)).toBe(4);
    db.close();
  });

  it("refuses a registry that reopens the numbered era after a name-keyed migration", () => {
    const db = newDb();
    const bad = [
      ...legacyPair(),
      marker("20260812-alpha"),
      marker("003-late-number", 3),
    ];
    expect(() => runMigrations(db, bad)).toThrow(/numbered era is CLOSED/i);
    db.close();
  });

  it("refuses duplicate names", () => {
    const db = newDb();
    const bad = [
      ...legacyPair(),
      marker("20260812-alpha"),
      marker("20260812-alpha"),
    ];
    expect(() => runMigrations(db, bad)).toThrow(/Duplicate migration name/);
    db.close();
  });
});

describe("migration runner — downgrade guards", () => {
  it("fails the boot when the ledger names a migration this build does not know, naming it and restore.ts", () => {
    const db = newDb();
    const legacy = [marker("001-first", 1)];
    runMigrations(db, [...legacy, marker("20260812-from-the-future")]);
    // Roll back to a build that never knew the second migration.
    expect(() => runMigrations(db, legacy)).toThrow(/20260812-from-the-future/);
    expect(() => runMigrations(db, legacy)).toThrow(/restore\.ts/);
    db.close();
  });

  it("fails the boot when user_version alone is ahead of the code (pre-ledger DBs), naming both versions", () => {
    const db = newDb();
    const ahead = MIGRATIONS.length + 1;
    db.pragma(`user_version = ${ahead}`);
    expect(() => runMigrations(db)).toThrow(/restore\.ts/);
    expect(() => runMigrations(db)).toThrow(new RegExp(String(ahead)));
    expect(() => runMigrations(db)).toThrow(
      new RegExp(String(MIGRATIONS.length))
    );
    // Nothing was applied.
    expect(readVersion(db)).toBe(ahead);
    db.close();
  });
});
