import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 020 (issue #430): give intake_item_doses a lifetime.
//
// The adherence-PATTERN detectors (lib/rule-findings.buildAdherencePatternFindings
// → lib/adherence-patterns) walk a fixed 56-day window and mark every due-not-taken
// day a "miss". Nothing bounded that window to the dose's lifetime, so:
//
//   • a dose added N days ago accrued phantom "misses" for the 56−N days BEFORE it
//     existed — defeating the min-history gate (MIN_APPLICABLE_DAYS) that is meant
//     to keep a brand-new dose from reading as a "pattern";
//   • a dose re-timed in place (evening → morning — the edit reconcile updates the
//     row by id so Telegram buttons stay valid) kept its whole pre-edit miss strip,
//     so the engine RE-ACCUSED a user who followed its own "move it earlier" advice
//     for up to eight weeks.
//
// The fix needs a per-dose lower bound. This migration adds the storage:
//
//   • intake_item_doses.created_at — when the dose was first scheduled. Backfilled
//     from the parent intake_items.created_at (the best available lower bound for
//     rows that predate this column); new inserts stamp it.
//   • intake_item_doses.updated_at — set by the edit reconcile whenever the dose's
//     time/schedule changes, so the pattern window restarts at the re-time.
//
// The builder windows each dose's strip at max(window start, dose lifetime start)
// via doseAdherenceSince, so pre-existence days become "not applicable" and a
// re-timed dose is judged only on days it actually sat in its current slot.
//
// SQLite forbids a non-constant DEFAULT (datetime('now')) on ADD COLUMN, so the
// columns are added bare (nullable) and created_at is backfilled by UPDATE; the
// write paths stamp them explicitly. Idempotent by construction (guarded ADD
// COLUMNs + a WHERE-created_at-IS-NULL backfill) so the non-version-gated migrate()
// test wrapper can replay it; production runs it once behind the user_version gate.
// Determinism (spec): reads only the DB + its own constants.

function columnNames(db: Database.Database, table: string): Set<string> {
  return new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
      (r) => r.name
    )
  );
}

export function up(db: Database.Database): void {
  const cols = columnNames(db, "intake_item_doses");
  if (!cols.has("created_at")) {
    db.exec(`ALTER TABLE intake_item_doses ADD COLUMN created_at TEXT;`);
  }
  if (!cols.has("updated_at")) {
    db.exec(`ALTER TABLE intake_item_doses ADD COLUMN updated_at TEXT;`);
  }
  // Backfill created_at from the parent item (item_id is NOT NULL + ON DELETE
  // CASCADE, so every dose has a matching item). The item's creation is the
  // earliest the dose could have existed — a sound lower bound for the window.
  db.exec(
    `UPDATE intake_item_doses
        SET created_at = (SELECT i.created_at FROM intake_items i
                           WHERE i.id = intake_item_doses.item_id)
      WHERE created_at IS NULL;`
  );
}

export const migration: Migration = {
  id: 20,
  name: "020-dose-lifetime",
  up,
};
