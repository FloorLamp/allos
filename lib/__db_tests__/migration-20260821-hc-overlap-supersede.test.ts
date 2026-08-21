// DB INTEGRATION TIER — the #3424 repair migration, asserted by BEHAVIOUR.
//
// This migration DELETES health rows at boot, once, with no backup taken beforehand
// and no undo. So the seed below is a database in the shape it actually meets — the
// prod pileup from #3424's own table, plus every neighbour that must survive it — and
// each test names the guard it would catch failing.
//
// The four properties an adversarial reader will ask for, in order:
//   1. it collapses a mixed-anchoring pileup and the day totals come back;
//   2. it is IDEMPOTENT — a second run deletes nothing;
//   3. it is a strict NO-OP on a profile that never travelled;
//   4. it cannot reach a non-Health-Connect row, an edit-locked row, a point reading,
//      or a disjoint sub-daily bucket.
// Plus the two mechanical ones a rebuild-free migration still has to answer: the
// ADD COLUMN replays without throwing, and a failure mid-replay leaves NOTHING behind.
//
// SYNTHETIC ONLY: fictional profiles, invented step counts, deep-past dates, no PHI.

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { up } from "@/lib/migrations/versions/20260821-hc-overlap-supersede";

interface SeedRow {
  id: number;
  profile_id?: number;
  source?: string;
  origin?: string | null;
  metric?: string;
  date: string;
  started_at: string;
  ended_at: string;
  value?: number;
  edited?: number | null;
}

function seed(rows: SeedRow[]): Database.Database {
  const mem = new Database(":memory:");
  mem.exec(`
    CREATE TABLE profiles (id INTEGER PRIMARY KEY AUTOINCREMENT);
    INSERT INTO profiles DEFAULT VALUES;
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
    CREATE UNIQUE INDEX idx_metric_samples_natural
      ON metric_samples(profile_id, metric, source, COALESCE(origin, ''), started_at);
    CREATE INDEX idx_metric_samples_md ON metric_samples(profile_id, metric, date);

    CREATE TABLE integration_sync_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id INTEGER NOT NULL,
      source_id TEXT NOT NULL,
      inserted INTEGER,
      updated INTEGER,
      unchanged INTEGER,
      suppressed INTEGER,
      edited INTEGER
    );

    CREATE TABLE import_tombstones (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id INTEGER NOT NULL,
      target_table TEXT NOT NULL,
      natural_key TEXT NOT NULL
    );
  `);
  const insert = mem.prepare(
    `INSERT INTO metric_samples
       (id, profile_id, source, origin, metric, date, started_at, ended_at, value, edited)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const r of rows) {
    insert.run(
      r.id,
      r.profile_id ?? 1,
      r.source ?? "health-connect",
      // `in`, not `??`: an explicit `origin: null` is a DIFFERENT identity from the
      // default origin, and `??` would have silently turned it back into the default.
      "origin" in r ? r.origin : "com.fitbit.FitbitMobile",
      r.metric ?? "steps",
      r.date,
      r.started_at,
      r.ended_at,
      r.value ?? 1,
      r.edited ?? 0
    );
  }
  return mem;
}

function ids(mem: Database.Database): number[] {
  return (
    mem.prepare("SELECT id FROM metric_samples ORDER BY id").all() as {
      id: number;
    }[]
  ).map((r) => r.id);
}

/** The reader's question: what does a profile-local day now sum to? */
function dayTotal(
  mem: Database.Database,
  metric: string,
  date: string,
  profile = 1
): number {
  const row = mem
    .prepare(
      `SELECT COALESCE(SUM(value), 0) AS total FROM metric_samples
        WHERE profile_id = ? AND metric = ? AND date = ?`
    )
    .get(profile, metric, date) as { total: number };
  return row.total;
}

// #3424's "Confirmed on prod" table, as rows: a New-York-anchored bucket (04:00Z
// start) and the Los-Angeles-anchored one that re-cut the same day (07:00Z start),
// both filed under 2026-08-20 and both summing into it.
const PROD_PILEUP: SeedRow[] = [
  {
    id: 1,
    metric: "steps",
    date: "2026-08-20",
    started_at: "2026-08-20T04:00:00Z",
    ended_at: "2026-08-21T02:11:00Z",
    value: 11609,
  },
  {
    id: 2,
    metric: "steps",
    date: "2026-08-20",
    started_at: "2026-08-20T07:00:00Z",
    ended_at: "2026-08-21T03:05:00Z",
    value: 11721,
  },
  {
    id: 3,
    metric: "active_kcal",
    date: "2026-08-19",
    started_at: "2026-08-19T04:00:00Z",
    ended_at: "2026-08-20T04:00:00Z",
    value: 298,
  },
  {
    id: 4,
    metric: "active_kcal",
    date: "2026-08-19",
    started_at: "2026-08-19T07:00:00Z",
    ended_at: "2026-08-20T07:00:00Z",
    value: 298,
  },
];

describe("20260821-hc-overlap-supersede — the repair replay", () => {
  it("collapses the prod pileup and the day totals come back", () => {
    const mem = seed(PROD_PILEUP);
    expect(dayTotal(mem, "steps", "2026-08-20")).toBe(23330); // the reported defect
    expect(dayTotal(mem, "active_kcal", "2026-08-19")).toBe(596);

    up(mem);

    expect(ids(mem)).toEqual([2, 4]);
    expect(dayTotal(mem, "steps", "2026-08-20")).toBe(11721);
    expect(dayTotal(mem, "active_kcal", "2026-08-19")).toBe(298);
  });

  it("is IDEMPOTENT — a second run deletes nothing more", () => {
    const mem = seed(PROD_PILEUP);
    up(mem);
    const after = ids(mem);
    up(mem);
    expect(ids(mem)).toEqual(after);
    up(mem);
    expect(ids(mem)).toEqual(after);
  });

  it("is a strict NO-OP for a profile that never changed zone", () => {
    const clean = Array.from({ length: 6 }, (_, i) => {
      const d = 10 + i;
      const day = `2026-08-${String(d).padStart(2, "0")}`;
      const next = `2026-08-${String(d + 1).padStart(2, "0")}`;
      return {
        id: i + 1,
        date: day,
        started_at: `${day}T04:00:00Z`,
        ended_at: `${next}T04:00:00Z`,
        value: 8000 + i,
      };
    });
    const mem = seed(clean);
    up(mem);
    expect(ids(mem)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("leaves a day of DISJOINT sub-daily buckets completely alone", () => {
    // A fine-grained exporter setting (#1065). MUTATION: make the boundary test
    // inclusive and 23 of these 24 rows die at boot with no undo.
    const hourly = Array.from({ length: 24 }, (_, h) => ({
      id: h + 1,
      date: "2026-08-20",
      started_at: `2026-08-20T${String(h).padStart(2, "0")}:00:00Z`,
      ended_at: `2026-08-20T${String(h + 1).padStart(2, "0")}:00:00Z`,
      value: 100 + h,
    }));
    const mem = seed(hourly);
    up(mem);
    expect(ids(mem)).toHaveLength(24);
  });
});

describe("what the migration must never reach", () => {
  it("never deletes a non-Health-Connect row, however it overlaps", () => {
    // MUTATION: drop `WHERE source = 'health-connect'` from the SELECT and every one
    // of these pairs collapses — Withings, Oura, Strava and manual rows all lose data
    // to a rule that was never about them.
    const rows: SeedRow[] = [];
    let id = 0;
    for (const source of ["withings", "oura", "strava", "manual"]) {
      rows.push({
        id: ++id,
        source,
        origin: null,
        date: "2026-08-20",
        started_at: "2026-08-20T04:00:00Z",
        ended_at: "2026-08-21T02:11:00Z",
        value: 11609,
      });
      rows.push({
        id: ++id,
        source,
        origin: null,
        date: "2026-08-20",
        started_at: "2026-08-20T07:00:00Z",
        ended_at: "2026-08-21T03:05:00Z",
        value: 11721,
      });
    }
    const mem = seed(rows);
    up(mem);
    expect(ids(mem)).toHaveLength(8);
  });

  it("never deletes an EDIT-LOCKED row", () => {
    const mem = seed([{ ...PROD_PILEUP[0], edited: 1 }, PROD_PILEUP[1]]);
    up(mem);
    expect(ids(mem)).toEqual([1, 2]);
  });

  it("reads a NULL lock as unlocked, like the #608 sweep", () => {
    const mem = seed([{ ...PROD_PILEUP[0], edited: null }, PROD_PILEUP[1]]);
    up(mem);
    expect(ids(mem)).toEqual([2]);
  });

  it("never deletes a POINT reading a day bucket merely contains", () => {
    const mem = seed([
      ...PROD_PILEUP.slice(0, 2),
      {
        id: 5,
        metric: "hrv_ms",
        date: "2026-08-20",
        started_at: "2026-08-20T09:00:00Z",
        ended_at: "2026-08-20T09:00:00Z",
        value: 42,
      },
    ]);
    up(mem);
    expect(ids(mem)).toEqual([2, 5]);
  });

  it("never crosses a profile, a metric, or an origin", () => {
    const mem = seed([
      { ...PROD_PILEUP[0], id: 1 },
      { ...PROD_PILEUP[1], id: 2, profile_id: 2 },
      { ...PROD_PILEUP[1], id: 3, metric: "distance_km" },
      { ...PROD_PILEUP[1], id: 4, origin: "com.google.android.apps.fitness" },
      { ...PROD_PILEUP[1], id: 5, origin: null },
    ]);
    up(mem);
    expect(ids(mem)).toEqual([1, 2, 3, 4, 5]);
  });

  it("writes NO tombstone for a row it removed — the delete is sync-internal", () => {
    const mem = seed(PROD_PILEUP);
    up(mem);
    const n = mem
      .prepare("SELECT COUNT(*) AS n FROM import_tombstones")
      .get() as { n: number };
    expect(n.n).toBe(0);
  });
});

describe("the mechanical obligations of a boot-time migration", () => {
  it("adds integration_sync_events.superseded, and replays without throwing", () => {
    // MUTATION: remove the PRAGMA table_info guard around the ADD COLUMN and the second
    // run throws "duplicate column name" — which takes the whole boot with it, since
    // the non-version-gated migrate() wrapper replays every name-keyed migration.
    const mem = seed([]);
    const columns = () =>
      (
        mem.prepare("PRAGMA table_info(integration_sync_events)").all() as {
          name: string;
        }[]
      ).map((c) => c.name);
    expect(columns()).not.toContain("superseded");
    up(mem);
    expect(columns()).toContain("superseded");
    expect(() => up(mem)).not.toThrow();
    expect(columns().filter((c) => c === "superseded")).toHaveLength(1);
  });

  it("leaves the column NULLABLE, so a rolled-back build still writes events", () => {
    // A deploy that rolls back to the previous build meets a migrated database. That
    // build's INSERT names every column EXCEPT this one, so a NOT NULL here would make
    // every sync event fail to record.
    const mem = seed([]);
    up(mem);
    const col = (
      mem.prepare("PRAGMA table_info(integration_sync_events)").all() as {
        name: string;
        notnull: number;
        dflt_value: string | null;
      }[]
    ).find((c) => c.name === "superseded")!;
    expect(col.notnull).toBe(0);
    expect(col.dflt_value).toBe(null);
    expect(() =>
      mem
        .prepare(
          "INSERT INTO integration_sync_events (profile_id, source_id, inserted) VALUES (1, 'health-connect', 3)"
        )
        .run()
    ).not.toThrow();
  });

  it("is ALL-OR-NOTHING — a failure mid-replay leaves the rows untouched", () => {
    // The replay runs inside one IMMEDIATE transaction. Half-applied is the state an
    // operator can neither detect nor undo, so it must not be reachable: break the
    // DELETE and the pileup must still be intact afterwards.
    const mem = seed(PROD_PILEUP);
    const realPrepare = mem.prepare.bind(mem);
    const patched = mem as unknown as { prepare: typeof mem.prepare };
    patched.prepare = ((sql: string) => {
      if (sql.startsWith("DELETE FROM metric_samples")) {
        throw new Error("simulated disk failure mid-replay");
      }
      return realPrepare(sql);
    }) as typeof mem.prepare;
    expect(() => up(mem)).toThrow(/simulated disk failure/);
    patched.prepare = realPrepare;
    expect(ids(mem)).toEqual([1, 2, 3, 4]);
    expect(dayTotal(mem, "steps", "2026-08-20")).toBe(23330);
    // And the column add rolled back with it, so the next boot re-applies cleanly.
    up(mem);
    expect(ids(mem)).toEqual([2, 4]);
  });

  it("does nothing at all on a database that predates the instant columns", () => {
    // A very old database reaches this migration before 20260815-metric-sample-instants
    // has renamed start_time/end_time. There is nothing to repair on one — the bug
    // needs the origin-keyed natural key — so it must return rather than throw.
    const mem = new Database(":memory:");
    mem.exec(`
      CREATE TABLE metric_samples (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        profile_id INTEGER NOT NULL,
        source TEXT NOT NULL,
        metric TEXT NOT NULL,
        date TEXT NOT NULL,
        start_time TEXT NOT NULL,
        end_time TEXT NOT NULL,
        value REAL NOT NULL
      );
      INSERT INTO metric_samples (profile_id, source, metric, date, start_time, end_time, value)
        VALUES (1, 'health-connect', 'steps', '2026-08-20', '2026-08-20T04:00:00Z', '2026-08-21T02:11:00Z', 11609);
      CREATE TABLE integration_sync_events (id INTEGER PRIMARY KEY AUTOINCREMENT);
    `);
    expect(() => up(mem)).not.toThrow();
    expect(ids(mem)).toEqual([1]);
  });
});
