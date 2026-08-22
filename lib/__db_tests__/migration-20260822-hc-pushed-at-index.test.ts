// DB INTEGRATION TIER — the index the store-derived supersede reads (#3424).
//
// WHY THIS MIGRATION EXISTS AT ALL, since the one before it went to some trouble to
// touch no row. The owner's ruling of 2026-08-22 moved the victim set off the payload and
// onto the store: the last chunk's transaction asks `metric_samples` which rows carry THIS
// push's stamp and derives everything from that one answer. No index in the table answers
// `WHERE profile_id = ? AND source = ? AND pushed_at = ?` — `idx_metric_samples_natural`
// leads with the natural key, `idx_metric_samples_md` with (profile_id, metric, date) —
// so without this one every Health Connect push scans the profile's whole sample history
// under the write lock.
//
// THE ASSERTION THAT MATTERS is the last one: the REAL statement, against the REAL
// schema, resolves to this index. An index that exists and is not chosen is not a fix,
// and a `CREATE INDEX` test that only asserts the index exists cannot tell the two apart.
//
// SYNTHETIC ONLY: fictional profiles, invented step counts, no PHI.

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { up } from "@/lib/migrations/versions/20260822-hc-pushed-at-index";

function seed(): Database.Database {
  const mem = new Database(":memory:");
  mem.exec(`
    CREATE TABLE profiles (id INTEGER PRIMARY KEY AUTOINCREMENT);
    INSERT INTO profiles DEFAULT VALUES;

    CREATE TABLE metric_samples (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id INTEGER NOT NULL REFERENCES profiles(id),
      source TEXT NOT NULL,
      origin TEXT,
      metric TEXT NOT NULL,
      date TEXT NOT NULL,
      started_at TEXT NOT NULL,
      ended_at TEXT NOT NULL,
      value REAL NOT NULL,
      edited INTEGER NOT NULL DEFAULT 0,
      pushed_at TEXT
    );
    INSERT INTO metric_samples
      (profile_id, source, origin, metric, date, started_at, ended_at, value)
    VALUES
      (1, 'health-connect', 'com.example.app', 'steps', '1999-01-01',
       '1999-01-01T00:00:00Z', '1999-01-02T00:00:00Z', 4100);
  `);
  return mem;
}

const indexSql = (mem: Database.Database): string | null =>
  (
    mem
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_metric_samples_pushed'"
      )
      .get() as { sql: string } | undefined
  )?.sql ?? null;

describe("20260822-hc-pushed-at-index", () => {
  it("creates the index", () => {
    const mem = seed();
    expect(indexSql(mem)).toBeNull();
    up(mem);
    expect(indexSql(mem)).toContain("idx_metric_samples_pushed");
    mem.close();
  });

  it("is PARTIAL on `pushed_at IS NOT NULL`, which is what makes it free on deploy day", () => {
    // The column landed in the migration before this one, so every row is NULL when this
    // runs and the index is built EMPTY — no scan of existing rows. It then holds only the
    // rows Health Connect actually stamps, which is the set the query selects from.
    const mem = seed();
    up(mem);
    expect(indexSql(mem)).toContain("WHERE pushed_at IS NOT NULL");
    mem.close();
  });

  it("is REPLAY-SAFE — a second and third run add nothing and throw nothing", () => {
    const mem = seed();
    up(mem);
    const after = indexSql(mem);
    expect(() => up(mem)).not.toThrow();
    expect(() => up(mem)).not.toThrow();
    expect(indexSql(mem)).toBe(after);
    mem.close();
  });

  it("DELETES NOTHING and CHANGES NOTHING — it is an index and only an index", () => {
    const mem = seed();
    const before = mem
      .prepare("SELECT * FROM metric_samples ORDER BY id")
      .all();
    up(mem);
    expect(
      mem.prepare("SELECT * FROM metric_samples ORDER BY id").all()
    ).toEqual(before);
    mem.close();
  });

  it("is the index SQLite picks for the supersede's own query", () => {
    // THE POINT OF THE MIGRATION, asserted against the real schema through the real
    // statement text (`supersedeMetricSampleOverlaps`, lib/integrations/normalize.ts).
    // MUTATION: drop `mHcPushedAtIndex` from lib/migrations/versions/index.ts and this
    // reads `SCAN metric_samples` or a partial use of `idx_metric_samples_md`.
    const plan = db
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT id, metric, origin, date, started_at, ended_at, edited, pushed_at
           FROM metric_samples
          WHERE profile_id = ? AND source = ? AND pushed_at = ?
          ORDER BY id`
      )
      .all(1, "health-connect", "2026-05-02T00:00:00Z") as { detail: string }[];
    expect(plan.map((r) => r.detail).join(" | ")).toContain(
      "idx_metric_samples_pushed"
    );
  });
});
