// DB INTEGRATION TIER — the #3424 migration, asserted by BEHAVIOUR.
//
// WHAT IT IS NOW. Two ADD COLUMNs and nothing else:
// `integration_sync_events.superseded`, so a push that deleted stored rows says so in
// Data → Review, and `metric_samples.pushed_at`, the stamp the supersede reads to
// decide whether an incoming row is newer than the one it would delete.
//
// WHAT IT DELIBERATELY IS NOT. The first cut also replayed the supersede rule over
// stored history at boot. An adversarial review measured that replay at 595 s for a
// single 100k-row group, 2m24s end-to-end on a database with 30,000 one-minute buckets,
// and showed it killing a concurrent boot with SQLITE_BUSY after 122 s — while writing
// no `integration_sync_events` row at all, so the deletions it made were invisible in
// Review. The historical repair is decoupled to #3439. The tests below therefore assert
// what a column-only migration owes: it applies, it re-applies, it touches no row, and
// it leaves both columns NULLABLE.
//
// SYNTHETIC ONLY: fictional profiles, invented step counts, deep-past dates, no PHI.

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { up } from "@/lib/migrations/versions/20260821-hc-overlap-supersede";

/** The two tables this migration alters, in their pre-migration shape. */
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
      edited INTEGER,
      activity_external_id TEXT
    );

    CREATE TABLE integration_sync_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id INTEGER NOT NULL,
      source_id TEXT NOT NULL,
      at TEXT NOT NULL,
      ok INTEGER NOT NULL,
      inserted INTEGER,
      updated INTEGER,
      unchanged INTEGER,
      suppressed INTEGER,
      edited INTEGER
    );

    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  // The prod pileup from #3424's own table, so "it touches no row" is asserted against
  // the exact shape the removed replay used to delete.
  const insert = mem.prepare(
    `INSERT INTO metric_samples
       (id, profile_id, source, origin, metric, date, started_at, ended_at, value, edited)
     VALUES (?, 1, 'health-connect', 'com.fitbit.FitbitMobile', ?, ?, ?, ?, ?, 0)`
  );
  insert.run(
    1,
    "steps",
    "2026-08-20",
    "2026-08-20T04:00:00Z",
    "2026-08-21T02:11:00Z",
    11609
  );
  insert.run(
    2,
    "steps",
    "2026-08-20",
    "2026-08-20T07:00:00Z",
    "2026-08-21T03:05:00Z",
    11721
  );
  insert.run(
    3,
    "active_kcal",
    "2026-08-19",
    "2026-08-19T04:00:00Z",
    "2026-08-20T04:00:00Z",
    298
  );
  insert.run(
    4,
    "active_kcal",
    "2026-08-19",
    "2026-08-19T07:00:00Z",
    "2026-08-20T07:00:00Z",
    298
  );
  return mem;
}

function columns(mem: Database.Database, table: string): Set<string> {
  return new Set(
    (
      mem.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
    ).map((r) => r.name)
  );
}

function ids(mem: Database.Database): number[] {
  return (
    mem.prepare("SELECT id FROM metric_samples ORDER BY id").all() as {
      id: number;
    }[]
  ).map((r) => r.id);
}

describe("20260821-hc-overlap-supersede", () => {
  it("adds both columns", () => {
    const mem = seed();
    expect(columns(mem, "integration_sync_events").has("superseded")).toBe(
      false
    );
    expect(columns(mem, "metric_samples").has("pushed_at")).toBe(false);
    up(mem);
    expect(columns(mem, "integration_sync_events").has("superseded")).toBe(
      true
    );
    expect(columns(mem, "metric_samples").has("pushed_at")).toBe(true);
  });

  it("is REPLAY-SAFE — a second and third run add nothing and throw nothing", () => {
    const mem = seed();
    up(mem);
    const after = [...columns(mem, "metric_samples")].sort();
    up(mem);
    up(mem);
    expect([...columns(mem, "metric_samples")].sort()).toEqual(after);
  });

  it("applies against a HALF-APPLIED database", () => {
    // One column already there — the shape a crash between the two ALTERs leaves.
    const mem = seed();
    mem.exec(
      "ALTER TABLE integration_sync_events ADD COLUMN superseded INTEGER;"
    );
    up(mem);
    expect(columns(mem, "metric_samples").has("pushed_at")).toBe(true);
  });

  it("DELETES NOTHING — not even the prod pileup the removed replay targeted", () => {
    // MUTATION: put the replay back and this goes red. It is the assertion that says
    // the boot-time deletion is gone, and #3439 owns bringing it back safely.
    const mem = seed();
    up(mem);
    expect(ids(mem)).toEqual([1, 2, 3, 4]);
    // A BEFORE DELETE trigger proves no DELETE was even ISSUED, which surviving rows
    // alone cannot: a delete that matched nothing looks identical from the outside.
    const fresh = seed();
    fresh.exec(
      `CREATE TRIGGER no_deletes BEFORE DELETE ON metric_samples
       BEGIN SELECT RAISE(ABORT, 'the migration issued a DELETE'); END;`
    );
    expect(() => up(fresh)).not.toThrow();
    expect(ids(fresh)).toEqual([1, 2, 3, 4]);
  });

  it("leaves both columns NULLABLE, so a row written without them still lands", () => {
    const mem = seed();
    up(mem);
    mem
      .prepare(
        `INSERT INTO integration_sync_events (profile_id, source_id, at, ok)
         VALUES (1, 'health-connect', '2026-08-21T00:00:00Z', 1)`
      )
      .run();
    const ev = mem
      .prepare("SELECT superseded FROM integration_sync_events")
      .get() as { superseded: number | null };
    expect(ev.superseded).toBe(null);
    const stored = mem
      .prepare("SELECT pushed_at FROM metric_samples WHERE id = 1")
      .get() as { pushed_at: string | null };
    expect(stored.pushed_at).toBe(null);
  });

  it("is ALL-OR-NOTHING — a failure part way leaves NEITHER column", () => {
    const mem = seed();
    const broken = new Proxy(mem, {
      get(target, prop, receiver) {
        if (prop === "exec") {
          return (sql: string) => {
            // Let the first ALTER through, fail the second.
            if (sql.includes("metric_samples")) throw new Error("boom");
            return target.exec(sql);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as Database.Database;
    expect(() => up(broken)).toThrow(/boom/);
    expect(columns(mem, "integration_sync_events").has("superseded")).toBe(
      false
    );
    expect(columns(mem, "metric_samples").has("pushed_at")).toBe(false);
  });
});
