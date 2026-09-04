import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Issue #3285 item 1 — `endurance_plans` generalizes into an EVENT store.
//
// The table already WAS an event store, narrowed to cardio by two column
// constraints rather than by anything about the domain: a row is a named event on
// a date with a status lifecycle, which is as true of a powerlifting meet as of a
// marathon. What kept a meet out was `discipline TEXT NOT NULL CHECK IN
// ('run','ride','swim')` and `target_distance_km REAL NOT NULL` — a meet has
// neither, so it could not be stored at all.
//
// THE REBUILD. SQLite cannot drop a NOT NULL or widen a CHECK in place, so this is
// the documented create-scratch → copy → drop → rename (migrations 006/011/015/016/
// 018, and 20260827-notify-offers-autoincrement most recently). Safe here: migration
// 057 records that NOTHING FKs into `endurance_plans`, and `PRAGMA
// foreign_key_list` over the tree still agrees — so the drop orphans no child. The
// runner applies migrations with `foreign_keys = OFF` and restores it after, which
// is what the swap requires. Ids are PRESERVED, so the completion milestones keyed
// `endurance-plan:<id>` (lib/endurance-plans.ts) keep naming their own row.
//
// WHAT CHANGES, AND WHAT DELIBERATELY DOES NOT:
//   • `kind` is NEW, `NOT NULL DEFAULT 'race'`, and carries NO CHECK — the issue
//     asks for an OPEN kind (race, competition, meet, tournament, …) and a closed
//     column would have to be rebuilt again for the fifth word anyone wants. Every
//     existing row copies across as 'race', which is what every existing row is.
//   • `discipline` and `target_distance_km` become NULLABLE. They still travel as a
//     PAIR at the type layer (`CoachedEndurancePlan`, lib/endurance-plan.ts): the
//     trajectory engine needs both or neither, so "a discipline with nothing to aim
//     at" is a state the readers cannot represent. The CHECK survives for non-NULL
//     values — a discipline, when present, is still one the classifier knows.
//   • Every other column, the status CHECK, `created_at`'s default, and BOTH indexes
//     are reproduced exactly. An existing row therefore round-trips byte-identically
//     through the rebuild, which is acceptance criterion 2 and is pinned by
//     lib/__db_tests__/migration-20260903-events-generalize.test.ts.
//
// THE ACTIVE-PLAN UNIQUE INDEX, AND WHY A NULL DISCIPLINE IS NOT A LOOPHOLE.
// `idx_endurance_plans_active_discipline` is UNIQUE over (profile_id, discipline)
// WHERE status = 'active', and it is reproduced verbatim. SQLite treats NULLs as
// DISTINCT in a unique index, so many active NULL-discipline events coexist while
// the one-active-plan-per-cardio-discipline rule is untouched for the rows it was
// written for. That is the behaviour we want — a household may have a meet, a
// tournament and a 10K on the calendar at once, but still only one active run plan
// — and because it rests on SQLite NULL semantics rather than on anything visible in
// the DDL, the migration test pins BOTH halves.
//
// REPLAY SAFETY. The non-version-gated `migrate()` test wrapper replays `up()` on an
// already-converged DB, so the rebuild is guarded by a sentinel read off the LIVE
// schema (the `kind` column's presence in the table's own DDL). A second run is a
// pure no-op. Determinism: reads only the DB.
export const migration: Migration = {
  name: "20260903-events-generalize-endurance-plans",
  up(db: Database.Database) {
    const ddl = (
      db
        .prepare(
          `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'endurance_plans'`
        )
        .get() as { sql: string | null } | undefined
    )?.sql;
    if (ddl == null) return; // absent (partial handle) — nothing to rebuild
    if (/\bkind\b/.test(ddl)) return; // already converged

    db.exec(`
      CREATE TABLE endurance_plans__rebuild (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        profile_id      INTEGER NOT NULL REFERENCES profiles(id),
        kind            TEXT NOT NULL DEFAULT 'race',
        event_name      TEXT,
        discipline      TEXT
                          CHECK (discipline IS NULL
                                 OR discipline IN ('run','ride','swim')),
        event_date      TEXT NOT NULL,
        target_distance_km REAL,
        target_time_sec INTEGER,
        status          TEXT NOT NULL DEFAULT 'active'
                          CHECK (status IN ('active','completed','abandoned')),
        session_kinds   TEXT,
        notes           TEXT,
        completed_on    TEXT,
        created_at      TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO endurance_plans__rebuild
        (id, profile_id, kind, event_name, discipline, event_date,
         target_distance_km, target_time_sec, status, session_kinds, notes,
         completed_on, created_at)
        SELECT id, profile_id, 'race', event_name, discipline, event_date,
               target_distance_km, target_time_sec, status, session_kinds, notes,
               completed_on, created_at
          FROM endurance_plans;
      DROP TABLE endurance_plans;
      ALTER TABLE endurance_plans__rebuild RENAME TO endurance_plans;
      CREATE INDEX IF NOT EXISTS idx_endurance_plans_profile
        ON endurance_plans(profile_id, status);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_endurance_plans_active_discipline
        ON endurance_plans(profile_id, discipline)
        WHERE status = 'active';
    `);
    // The rebuild copies explicit ids, so the AUTOINCREMENT counter must not restart
    // below them: seed it past the highest id carried across. (057 declared
    // AUTOINCREMENT, so sqlite_sequence already tracks this table; the DROP removed
    // its row.) DELETE-then-INSERT rather than OR REPLACE — sqlite_sequence has no
    // unique constraint on `name`, so OR REPLACE appends instead of replacing
    // (measured on 20260827-notify-offers-autoincrement).
    db.exec(`DELETE FROM sqlite_sequence WHERE name = 'endurance_plans'`);
    db.exec(
      `INSERT INTO sqlite_sequence (name, seq)
       VALUES ('endurance_plans', COALESCE((SELECT MAX(id) FROM endurance_plans), 0))`
    );
  },
};
