// DB INTEGRATION TIER — 20260830-practice-session-interval: `practice_logs.time`
// becomes `start_time` and `end_time` joins it (#3142).
//
// A COLUMN RENAME ON SHIPPED DATA IS THE CHEAPEST-LOOKING MIGRATION AND THE ONE WITH
// THE MOST WAYS TO LOSE DATA QUIETLY, and "the schema changed" is not the claim worth
// testing — a migration that ADDED an empty `start_time` beside a surviving `time`
// would satisfy every column-set assertion and silently strand every stored session
// clock. So the rows are seeded through the OLD shape and the assertions are about
// VALUES:
//
//   1. every stored "HH:MM" is byte-identical afterwards, under its own id;
//   2. `end_time` exists and is NULL on every pre-existing row — nothing is
//      backfilled from `duration_min`, because `activityWindow` derives that end at
//      READ time and storing it would turn a derivation into a claim;
//   3. AN INSTANT AND A PROFILE-LOCAL DAY ARE DIFFERENT THINGS, and this table is
//      where that bites: the row carries a profile-local `date` + `HH:MM`, and the
//      only thing that turns the pair into an instant is `eventInstant` reading the
//      table's declared `event` column through the profile's timezone. Rename the
//      column without moving the registry entry and the composition silently stops
//      answering. Both seeded profiles sit at offsets where the local day and the
//      UTC day of the SAME session DISAGREE — one either side of the date line — so
//      a reader that fell back to a UTC-truncated day would land on the wrong day
//      and the assertion would see it;
//   4. row identity survives: ids are external identity here (the ⋯ menu's
//      delete/undo token, a correction burst's anchor), so the AUTOINCREMENT
//      high-water must not recycle and the indexes must survive under their frozen
//      names — both of which a REBUILD-based implementation would break;
//   5. replay safety — migrate() is not version-gated, so a second up() is a no-op.

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { runMigrations } from "@/lib/migrations/runner";
import { migrationsBefore } from "@/lib/migrations/versions";
import { up } from "@/lib/migrations/versions/20260830-practice-session-interval";
import { eventInstant, rowLocalDay } from "@/lib/row-instants";

const MIGRATION = "20260830-practice-session-interval";

// Two zones on opposite sides of UTC, both far enough out that a session's local day
// and the UTC day of its instant DISAGREE at the seeded clock.
const AUCKLAND = "Pacific/Auckland"; // +12/+13
const LA = "America/Los_Angeles"; // −7/−8

interface Seeded {
  id: number;
  practice: string;
  date: string;
  time: string | null;
  duration_min: number | null;
  // The instant the stored (date, time) pair denotes in `tz`, and the UTC DAY that
  // instant falls on — different from `date` for every row that states a time.
  tz: string;
  instant: string;
  utcDay: string;
}

// A tap-stamped evening session in Auckland: 2026-03-15 21:30 local is
// 2026-03-15T08:30Z, still the same UTC day — so the row below crosses it instead.
const SEEDS: Seeded[] = [
  {
    // AUCKLAND MORNING — local day 2026-03-15, UTC day 2026-03-14. The local day is
    // AHEAD of the UTC one.
    id: 41,
    practice: "Sauna",
    date: "2026-03-15",
    time: "09:15",
    duration_min: 20,
    tz: AUCKLAND,
    instant: "2026-03-14T20:15:00Z",
    utcDay: "2026-03-14",
  },
  {
    // LOS ANGELES EVENING — local day 2026-03-15, UTC day 2026-03-16. The local day
    // is BEHIND the UTC one, so the two rows bracket the boundary from both sides.
    id: 42,
    practice: "Cold plunge",
    date: "2026-03-15",
    time: "22:40",
    duration_min: 3,
    tz: LA,
    instant: "2026-03-16T05:40:00Z",
    utcDay: "2026-03-16",
  },
  {
    // A BACKDATED CORRECTION states no clock, and that is a decision the rename must
    // not turn into a value.
    id: 43,
    practice: "Meditation",
    date: "2026-03-10",
    time: null,
    duration_min: 10,
    tz: LA,
    instant: "",
    utcDay: "",
  },
];

function beforeRename(): Database.Database {
  const db = new Database(":memory:");
  runMigrations(db, migrationsBefore(MIGRATION));
  db.prepare("INSERT INTO profiles (id, name) VALUES (1, 'Interval')").run();
  const insert = db.prepare(
    `INSERT INTO practice_logs
       (id, profile_id, practice, date, time, duration_min, notes, created_at,
        logged_via)
     VALUES (?, 1, ?, ?, ?, ?, ?, ?, 'page')`
  );
  for (const row of SEEDS) {
    insert.run(
      row.id,
      row.practice,
      row.date,
      row.time,
      row.duration_min,
      `${row.practice} note`,
      "2026-03-15 12:00:00"
    );
  }
  db.prepare("UPDATE sqlite_sequence SET seq = 99 WHERE name = ?").run(
    "practice_logs"
  );
  return db;
}

function columns(db: Database.Database, table: string): string[] {
  return (
    db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
  ).map((row) => row.name);
}

function indexNames(db: Database.Database): string[] {
  return (
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='practice_logs' AND name IS NOT NULL ORDER BY name"
      )
      .all() as { name: string }[]
  )
    .map((row) => row.name)
    .filter((name) => !name.startsWith("sqlite_"));
}

describe(`${MIGRATION}`, () => {
  it("preserves stored sessions, reader semantics, row identity, indexes, and replay safety", () => {
    const db = beforeRename();
    const before = indexNames(db);
    expect(before).toContain("idx_practice_logs_profile_date");

    runMigrations(db);

    const after = columns(db, "practice_logs");
    expect(after).toContain("start_time");
    expect(after).toContain("end_time");
    // The rename MOVED the column; it did not add a second one beside it. This is
    // the assertion an ADD-COLUMN implementation fails while every other one passes.
    expect(after).not.toContain("time");

    expect(
      db
        .prepare(
          "SELECT id, practice, date, start_time, end_time, duration_min, notes FROM practice_logs ORDER BY id"
        )
        .all()
    ).toEqual(
      SEEDS.map((row) => ({
        id: row.id,
        practice: row.practice,
        date: row.date,
        start_time: row.time,
        // NOTHING IS BACKFILLED, `duration_min` included: `activityWindow` derives
        // the end from it at read time, and a stored one would be a claim.
        end_time: null,
        duration_min: row.duration_min,
        notes: `${row.practice} note`,
      }))
    );

    // Row identity: the ids are the app's delete/undo tokens, so a rebuild that let
    // the AUTOINCREMENT high-water recycle would hand a future row a spent token.
    expect(
      db
        .prepare("SELECT seq FROM sqlite_sequence WHERE name = 'practice_logs'")
        .get()
    ).toEqual({ seq: 99 });
    // Later migrations may add indexes to this table; the interval rebuild must keep
    // every index it inherited rather than requiring the final schema to be frozen at
    // this migration's exact index set.
    expect(indexNames(db)).toEqual(expect.arrayContaining(before));
    expect(indexNames(db)).toContain("idx_practice_logs_profile_live");

    // THE COMPOSITION, not the column set. Each row's (date, start_time) pair must
    // still resolve through the profile's timezone to the instant it denoted before —
    // and the seeded UTC day is deliberately NOT the stored local day, so a reader
    // that lost the registry entry and fell back to the day cannot pass by accident.
    for (const row of SEEDS.filter((seed) => seed.time != null)) {
      const stored = db
        .prepare("SELECT * FROM practice_logs WHERE id = ?")
        .get(row.id) as Record<string, unknown>;

      expect(eventInstant("practice_logs", stored, row.tz)).toMatchObject({
        known: true,
        at: row.instant,
        column: "start_time",
        derived: true,
      });
      // The two days really do disagree, so the assertion above had something to
      // discriminate against — a guard whose candidate set is empty passes anywhere.
      expect(row.instant.slice(0, 10)).not.toEqual(row.date);
      expect(row.instant.slice(0, 10)).toEqual(row.utcDay);
      // And the DAY is still the STORED one (#94): a profile-local day attribution
      // is a decision the app already made, never re-derived from the instant.
      expect(rowLocalDay("practice_logs", stored, row.tz)).toMatchObject({
        known: true,
        date: row.date,
        from: "stored",
      });
    }

    const untimed = db
      .prepare("SELECT * FROM practice_logs WHERE id = 43")
      .get() as Record<string, unknown>;
    expect(eventInstant("practice_logs", untimed, LA)).toMatchObject({
      known: false,
      why: "not-recorded",
      column: "start_time",
    });

    const schemaBefore = db
      .prepare("SELECT sql FROM sqlite_master WHERE name = 'practice_logs'")
      .get();
    const rowsBefore = db
      .prepare("SELECT * FROM practice_logs ORDER BY id")
      .all();
    // migrate() is not version-gated, so up() runs again over a converted database.
    expect(() => up(db)).not.toThrow();
    expect(
      db
        .prepare("SELECT sql FROM sqlite_master WHERE name = 'practice_logs'")
        .get()
    ).toEqual(schemaBefore);
    expect(db.prepare("SELECT * FROM practice_logs ORDER BY id").all()).toEqual(
      rowsBefore
    );
  });
});
