// DB INTEGRATION TIER — the guard on ./migrated-db.ts (#3471).
//
// `migratedDb()` hands a test a database that was NEVER migrated: it is a byte
// copy of one that was, taken once per worker. Two things have to stay true for
// that substitution to be honest, and neither is visible in a green run of the
// tests that use it:
//
//   1. IT IS THE SAME DATABASE a real replay produces. If it ever is not, the
//      tests that switched to it stop asking their question about the current
//      schema and start asking it about a stale one — green, and meaningless.
//   2. THE COPIES ARE INDEPENDENT. Every caller gets its own handle and writes
//      to it. If those handles shared pages, a test would see a neighbour's rows
//      and the failure would depend on WHICH RAN FIRST — the shape that passes in
//      the order you happen to run it and fails in the order CI happens to pack.
//
// So this file compares the snapshot against `replayedDb()` — the real chain,
// which is what the callers used to do — rather than against a second copy of
// itself, and it proves independence by writing rather than by asserting it.

import Database from "better-sqlite3";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { migratedDb, replayedDb } from "./migrated-db";

let snap: Database.Database;
let real: Database.Database;

beforeAll(() => {
  snap = migratedDb();
  real = replayedDb();
});

afterAll(() => {
  snap.close();
  real.close();
});

function tableNames(db: Database.Database): string[] {
  return (
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
      )
      .all() as { name: string }[]
  ).map((r) => r.name);
}

// THE TWO WAYS A BOOT'S OWN OUTPUT LEGITIMATELY DIFFERS BETWEEN TWO RUNS, and
// nothing else is allowed to. Both are properties of WHEN and WHERE the boot ran,
// never of the schema:
//
//   • an INSTANT — `schema_migrations.applied_at`, the seeded rows' `created_at`,
//     and one settings value that embeds an instant inside JSON. Matched on the
//     value rather than by naming columns, so an instant that appears in a new
//     column or nested in a new JSON blob is covered without this list moving.
//   • the BOOTSTRAP PASSWORD HASH, which is scrypt over a random salt, so it
//     differs between two runs of identical code.
//
// Anything else that differs is a real divergence and must fail here.
function stable(value: unknown): unknown {
  if (typeof value !== "string") return value;
  return value
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/g, "<instant>")
    .replace(/scrypt\$[0-9]+\$[0-9]+\$[0-9]+\$[0-9a-f]+\$[0-9a-f]+/g, "<hash>");
}

// THE THIRD DIFFERENCE, and the guard found it rather than the author: the
// `photo_metadata_backfill` settings row. `runPhotoMetadataBackfill` (a boot task)
// writes a `running` marker and then kicks a DETACHED async sweep that rewrites it
// to `done` — see lib/photo/metadata-backfill.ts. So its value at any instant is a
// function of the event loop, not of the schema: the snapshot, taken a moment after
// its boot, holds `done`, while a database replayed and read in the same tick holds
// `running`. Neither is wrong and neither is stable, so the row's VALUE is masked
// while its presence is still compared by the row counts above.
const ASYNC_PROGRESS_SETTINGS = new Set(["photo_metadata_backfill"]);

function rows(db: Database.Database, table: string): string {
  const all = db.prepare(`SELECT * FROM "${table}"`).all() as Record<
    string,
    unknown
  >[];
  return JSON.stringify(
    all.map((row) =>
      Object.fromEntries(
        Object.entries(row).map(([k, v]) => [
          k,
          table === "settings" &&
          k === "value" &&
          ASYNC_PROGRESS_SETTINGS.has(String(row["key"]))
            ? "<async boot-task progress>"
            : stable(v),
        ] as const)
      )
    )
  );
}

describe("migratedDb() stands in for a real migration replay (#3471)", () => {
  it("carries the identical schema — every table, index, trigger and view", () => {
    const master = (db: Database.Database) =>
      db
        .prepare(
          "SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name"
        )
        .all();
    // Not a count: the CREATE SQL itself, so a column that lost its CHECK or an
    // index that lost a column is caught, not just a missing object.
    expect(master(snap)).toEqual(master(real));
    // A non-trivial floor, so the assertion above cannot pass on two empty DBs.
    expect(tableNames(snap).length).toBeGreaterThan(100);
  });

  it("is stamped at the same schema version the chain ends on", () => {
    expect(snap.pragma("user_version", { simple: true })).toBe(
      real.pragma("user_version", { simple: true })
    );
    expect(snap.pragma("user_version", { simple: true })).toBeGreaterThan(200);
  });

  it("carries the same rows the boot tasks seed, table by table", () => {
    const names = tableNames(real);
    expect(tableNames(snap)).toEqual(names);
    // Counts first and separately: masking cannot hide a missing or extra row,
    // so a seed the snapshot lost is caught even if its columns are all volatile.
    const counts = (db: Database.Database) =>
      Object.fromEntries(
        names.map((t) => [
          t,
          (db.prepare(`SELECT count(*) n FROM "${t}"`).get() as { n: number }).n,
        ])
      );
    expect(counts(snap)).toEqual(counts(real));
    // A floor on the thing being compared, so this cannot go green by finding
    // nothing: the boot seeds the canonical result definitions and profile 1.
    const seeded = counts(real);
    expect(seeded["canonical_result_definitions"]).toBeGreaterThan(50);
    expect(seeded["profiles"]).toBe(1);
    for (const t of names) expect([t, rows(snap, t)]).toEqual([t, rows(real, t)]);
  });
});

describe("migratedDb() hands out independent databases (#3471)", () => {
  it("a write on one handle is invisible to handles made BEFORE and AFTER it", () => {
    const earlier = migratedDb();
    const writer = migratedDb();
    writer.exec("INSERT INTO profiles (name) VALUES ('isolation probe')");
    const later = migratedDb();

    const names = (db: Database.Database) =>
      (db.prepare("SELECT name FROM profiles ORDER BY id").all() as {
        name: string;
      }[]).map((r) => r.name);

    // The writer really wrote — without this the two assertions below would pass
    // on a probe that never happened, which is the way an isolation check fails
    // open.
    expect(names(writer)).toContain("isolation probe");
    // Order is the whole question: a snapshot handed out by reference would leak
    // to whichever handle read after the write, so both directions are asserted.
    expect(names(earlier)).not.toContain("isolation probe");
    expect(names(later)).not.toContain("isolation probe");
    expect(names(earlier)).toEqual(names(later));

    earlier.close();
    writer.close();
    later.close();
  });

  it("a schema change on one handle does not reach the next one", () => {
    const mutated = migratedDb();
    mutated.exec("CREATE TABLE isolation_probe (x INTEGER)");
    expect(
      mutated
        .prepare(
          "SELECT count(*) n FROM sqlite_master WHERE name = 'isolation_probe'"
        )
        .get()
    ).toEqual({ n: 1 });

    const fresh = migratedDb();
    expect(
      fresh
        .prepare(
          "SELECT count(*) n FROM sqlite_master WHERE name = 'isolation_probe'"
        )
        .get()
    ).toEqual({ n: 0 });

    mutated.close();
    fresh.close();
  });
});
