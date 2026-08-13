import type Database from "better-sqlite3";
import type { Migration } from "../runner";
import { sweepOrphanedCascadeRows } from "../cascade-delete";

// Issue #2680 — clear the cascade orphans earlier row-deleting migrations left.
//
// WHAT WENT WRONG. `runMigrations` applies every migration with
// `foreign_keys = OFF` (lib/migrations/runner.ts, issue #95), which is correct and
// stays: SQLite's own table-rebuild procedure requires it, and rebuilding a table
// that is itself an FK parent with enforcement ON would fire the cascades on the
// DROP and wipe the children. The undocumented consequence is that
// `ON DELETE CASCADE` fires for NOTHING inside a migration — so a migration that
// deletes a parent row leaves its cascading children behind, where the same delete
// at runtime removes them.
//
// WHO DID IT. Two shipped migrations delete `medical_records` rows in an era where
// that table already had cascading children: 180 (waist circumference → a metric)
// and 20260813-bmi-derived-rows (BMI readings retired). `medical_record_revisions`
// (migration 120) and `instrument_responses` (migration 066) both cascade off
// `medical_records.id`, and neither migration cleared them — their `CHILD_LINKS`
// registries cover the NON-cascading parents, which is the other half of the
// question (see lib/migrations/cascade-delete.ts for the two halves). Both files
// are hash-locked by the immutability manifest and cannot be corrected in place,
// which is why this is a forward repair — the same shape migration 184 took for
// the damage 180's misnamed CHILD_LINKS entries let through (#2444).
//
// Migrations 092 and 101 also delete `medical_records`, but they run BEFORE
// migration 120 in the sequence, so on a fresh database no revision row exists to
// orphan; on an already-migrated one the sweep below reaches whatever they left.
// Migration 118 deletes `activities` and handled its own links BY HAND (its inline
// comment names the FK-off posture explicitly) — it is the precedent, not a
// defect.
//
// WHAT THIS DOES. One pass over the FK graph, deleting every row whose CASCADE
// parent is missing. The blast radius is exactly the set the schema already
// declares must not exist: the reference is non-null and matches no parent row. A
// healthy database loses nothing, and this is a no-op on a fresh install (the
// deletes above have no rows to act on when they run in sequence). SET NULL links
// are deliberately untouched — nulling a column on a SURVIVING row rewrites live
// data, which is a bigger claim than this issue makes.
//
// NO SCHEMA CHANGE, no new table, and nothing added to lib/owned-tables.ts.
//
// WHY NOW, given the orphans are unreachable. Every current reader of
// `medical_record_revisions` joins `medical_records`, so the rows are dead weight
// rather than visible wrong data. But unreachable is a property of TODAY's
// readers, and the database is meanwhile left in a state `PRAGMA foreign_key_check`
// reports as a violation on a healthy install — which is the trap the health
// endpoint's own rules name: a reason that describes the default deployment
// posture. Clearing them is what lets a future integrity probe mean something.
//
// Idempotent: a second run finds no orphan and writes nothing.

export function up(db: Database.Database): void {
  const run = db.transaction(() => {
    sweepOrphanedCascadeRows(db);
  });
  run.immediate();
}

export const migration: Migration = {
  name: "20260813-cascade-orphan-sweep",
  up,
};
