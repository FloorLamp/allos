// DB INTEGRATION TIER — migration 172 (#2272): activities.type grows an
// `unclassified` member. "The source did not say" is a stated absence, and the row
// must be able to hold it instead of asserting a `sport` no provider ever claimed.
//
// The rebuild follows migration 058 (which added `recovery` for #840) exactly, so
// what earns a test here is the same list 058's shape implies:
//   1. the widened CHECK actually admits `unclassified` — and still refuses a value
//      outside the five;
//   2. existing rows are byte-untouched, ids included: there is deliberately NO
//      backfill, because an already-stored `sport` may be a correct call the user has
//      since relied on;
//   3. `activities` is an FK PARENT, and the runner applies migrations with
//      foreign_keys OFF, so the drop-and-rename must not take the children with it;
//   4. the two secondary indexes come back, including the UNIQUE partial one the
//      importer's idempotency depends on;
//   5. replay safety — the migrate() wrapper is not version-gated, so a second run on
//      a converged DB is a pure no-op (a second rebuild is data movement for nothing);
//   6. every surviving id is preserved and a new row is minted above them — activity
//      ids key the post-workout one-shot markers and the import pair decisions.

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { up } from "@/lib/migrations/versions/172-unclassified-activity-type";
import { db } from "@/lib/db";

// The pre-172 shape: migration 058's table plus `elapsed_min` (the additive ALTER
// from migration 106), which is what a live database actually carries.
function legacyDb(): Database.Database {
  const mem = new Database(":memory:");
  mem.exec(`
    CREATE TABLE profiles (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    INSERT INTO profiles (id, name) VALUES (1, 'Rebuild');
    CREATE TABLE equipment (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT);
    INSERT INTO equipment (id, name) VALUES (7, 'Bike');
    CREATE TABLE activities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id INTEGER NOT NULL REFERENCES profiles(id),
      date TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('strength','cardio','sport','recovery')),
      title TEXT NOT NULL,
      notes TEXT,
      duration_min INTEGER,
      distance_km REAL,
      intensity TEXT,
      start_time TEXT,
      end_time TEXT,
      components TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      source TEXT,
      external_id TEXT,
      avg_hr REAL,
      max_hr REAL,
      elevation_m REAL,
      avg_speed_kmh REAL,
      max_speed_kmh REAL,
      relative_effort REAL,
      avg_power_w REAL,
      max_power_w REAL,
      weighted_avg_power_w REAL,
      avg_cadence REAL,
      avg_temp_c REAL,
      kilojoules REAL,
      workout_type TEXT,
      edited INTEGER DEFAULT 0,
      updated_at TEXT,
      est_calories REAL,
      equipment_id INTEGER REFERENCES equipment(id),
      elapsed_min INTEGER
    );
    CREATE INDEX idx_activities_profile_date ON activities(profile_id, date);
    CREATE UNIQUE INDEX idx_activities_external
      ON activities(profile_id, external_id) WHERE external_id IS NOT NULL;
    CREATE TABLE exercise_sets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      activity_id INTEGER NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
      exercise TEXT NOT NULL
    );
  `);
  // Mirrors the runner: migrations run with foreign_keys OFF.
  mem.pragma("foreign_keys = OFF");
  return mem;
}

function seed(
  mem: Database.Database,
  id: number,
  type: string,
  over: Record<string, unknown> = {}
): void {
  mem
    .prepare(
      `INSERT INTO activities
         (id, profile_id, date, type, title, duration_min, avg_hr, source,
          external_id, edited, equipment_id, elapsed_min)
       VALUES (@id, 1, @date, @type, @title, @duration_min, @avg_hr, @source,
               @external_id, @edited, @equipment_id, @elapsed_min)`
    )
    .run({
      id,
      date: "2026-08-07",
      type,
      title: `Session ${id}`,
      duration_min: 60,
      avg_hr: null,
      source: null,
      external_id: null,
      edited: 0,
      equipment_id: null,
      elapsed_min: null,
      ...over,
    });
}

function tableSql(mem: Database.Database): string {
  return (
    mem
      .prepare(
        `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'activities'`
      )
      .get() as { sql: string }
  ).sql;
}

describe("migration 172 — activities.type admits `unclassified` (#2272)", () => {
  it("widens the CHECK and still refuses a value outside the five", () => {
    const mem = legacyDb();
    expect(() => seed(mem, 1, "unclassified")).toThrow();
    up(mem);
    expect(tableSql(mem)).toContain("'unclassified'");
    seed(mem, 1, "unclassified");
    expect(
      (
        mem.prepare(`SELECT type FROM activities WHERE id = 1`).get() as {
          type: string;
        }
      ).type
    ).toBe("unclassified");
    // The CHECK is still a CHECK — the new member widens the vocabulary, it does not
    // open the column.
    expect(() => seed(mem, 2, "swimming")).toThrow();
    mem.close();
  });

  it("does NOT backfill: an existing `sport` row survives verbatim", () => {
    // The rule changed; the user's history did not. An already-stored `sport` may be a
    // correct call they have relied on, and rewriting it is not earned by this change.
    const mem = legacyDb();
    seed(mem, 384, "sport", {
      title: "Workout",
      source: "health-connect",
      external_id: "health-connect:2026-08-07T18:30:17Z",
      avg_hr: 142,
      equipment_id: 7,
      elapsed_min: 60,
      edited: 1,
    });
    seed(mem, 385, "strength", { title: "Afternoon Workout" });
    const before = mem
      .prepare(`SELECT * FROM activities ORDER BY id`)
      .all() as Record<string, unknown>[];
    up(mem);
    const after = mem
      .prepare(`SELECT * FROM activities ORDER BY id`)
      .all() as Record<string, unknown>[];
    expect(after).toEqual(before);
    mem.close();
  });

  it("keeps the children of the FK parent through the drop-and-rename", () => {
    // The runner applies migrations with foreign_keys OFF, so DROP TABLE activities
    // does not cascade — and ids are preserved in the copy, so every activity_id link
    // stays valid. Without both, this rebuild would silently delete a session's sets.
    const mem = legacyDb();
    seed(mem, 384, "sport");
    mem
      .prepare(
        `INSERT INTO exercise_sets (activity_id, exercise) VALUES (384, 'Bench press')`
      )
      .run();
    up(mem);
    expect(
      mem
        .prepare(
          `SELECT COUNT(*) AS c FROM exercise_sets WHERE activity_id = 384`
        )
        .get()
    ).toEqual({ c: 1 });
    mem.close();
  });

  it("rebuilds both secondary indexes, including the importer's UNIQUE partial one", () => {
    const mem = legacyDb();
    seed(mem, 1, "cardio", { external_id: "strava:1", source: "strava" });
    up(mem);
    const idx = mem
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'activities'
          AND name LIKE 'idx_%' ORDER BY name`
      )
      .all() as { name: string }[];
    expect(idx.map((i) => i.name)).toEqual([
      "idx_activities_external",
      "idx_activities_profile_date",
    ]);
    // The idempotency guarantee the whole sync layer rests on.
    expect(() =>
      seed(mem, 2, "cardio", { external_id: "strava:1", source: "strava" })
    ).toThrow();
    mem.close();
  });

  it("keeps every surviving id, so a new row is minted ABOVE them", () => {
    // Activity ids are the key of the post-workout one-shot marker and of every import
    // pair decision, so the copy preserves them verbatim and the rebuilt table's
    // sequence continues past the highest survivor. (Like migration 058's rebuild, the
    // AUTOINCREMENT high-water mark of rows ALREADY DELETED is not carried across — the
    // documented create-copy-drop-rename cannot, and nothing keys on a deleted id.)
    const mem = legacyDb();
    seed(mem, 384, "sport");
    seed(mem, 385, "strength");
    up(mem);
    expect(mem.prepare(`SELECT id FROM activities ORDER BY id`).all()).toEqual([
      { id: 384 },
      { id: 385 },
    ]);
    seed(mem, 0, "cardio", { id: null as unknown as number });
    expect(
      (
        mem.prepare(`SELECT MAX(id) AS m FROM activities`).get() as {
          m: number;
        }
      ).m
    ).toBe(386);
    mem.close();
  });

  it("replays as a pure no-op on a converged database", () => {
    const mem = legacyDb();
    seed(mem, 384, "sport");
    up(mem);
    const sqlAfterFirst = tableSql(mem);
    const rowsAfterFirst = mem.prepare(`SELECT * FROM activities`).all();
    up(mem);
    expect(tableSql(mem)).toBe(sqlAfterFirst);
    expect(mem.prepare(`SELECT * FROM activities`).all()).toEqual(
      rowsAfterFirst
    );
    mem.close();
  });

  it("is a no-op when the table is absent (a partial handle)", () => {
    const mem = new Database(":memory:");
    expect(() => up(mem)).not.toThrow();
    mem.close();
  });

  it("the migrated app schema carries the widened CHECK", () => {
    const sql = (
      db
        .prepare(
          `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'activities'`
        )
        .get() as { sql: string }
    ).sql;
    expect(sql).toContain("'unclassified'");
    expect(sql).toContain("'recovery'");
  });
});
