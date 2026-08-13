import type Database from "better-sqlite3";
import type { Migration } from "../runner";
import { createLogger } from "../../log";
import {
  sweepOrphanedCascadeRows,
  type OrphanSweepEffect,
} from "../cascade-delete";

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
// reports as a violation — one of the kinds it reports (a SET NULL dangler is
// another, and this sweep deliberately leaves those). Clearing the CASCADE kind is
// what lets a future integrity probe mean something about the kind a migration
// creates.
//
// Idempotent: a second run finds no orphan and writes nothing.
//
// AND IT SAYS WHAT IT DID. This deletes health-record rows at boot, once, with no
// backup taken by `createDb()` beforehand and no undo. The one scenario in which
// this migration matters at all is the one where it actually removed something on a
// real install — so discarding the tally would mean nobody could ever learn what
// went. The sweep already computes it per link; every run emits one line, including
// the empty one, because "this ran and found nothing" is the other half of the
// trail. `up()` is the right place for it rather than the sweep: the sweep is a
// pure-ish schema operation several callers could have, and the decision to write
// to the operator's log belongs to the boot-time caller that removes rows.

const log = createLogger("migrate");

function describe(effect: OrphanSweepEffect): string {
  return (
    `${effect.table}.${effect.columns.join("+")} → ${effect.parent}: ` +
    `${effect.rows}`
  );
}

export function up(db: Database.Database): void {
  let effects: OrphanSweepEffect[] = [];
  const run = db.transaction(() => {
    effects = sweepOrphanedCascadeRows(db);
  });
  run.immediate();

  const rows = effects.reduce((n, e) => n + e.rows, 0);
  if (rows === 0) {
    log.info(
      "20260813-cascade-orphan-sweep: no cascade orphans found, nothing removed"
    );
    return;
  }
  // WARN, not info: rows were deleted from a health database and the operator has
  // no other record of it.
  log.warn(
    `20260813-cascade-orphan-sweep: removed ${rows} orphaned row(s) whose ` +
      `ON DELETE CASCADE parent was already gone (#2680)`,
    { rows, links: effects.map(describe) }
  );
}

export const migration: Migration = {
  name: "20260813-cascade-orphan-sweep",
  up,
};
