import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 004: make dose edits stop rewriting/destroying adherence history.
//
// A supplement's scheduled doses (intake_item_doses) were previously mutated in
// place and hard-deleted on edit, while the adherence log (intake_item_logs)
// stored only a dose_id FK with ON DELETE CASCADE. Two consequences:
//
//   • Removing a dose row on edit (a schedule restructure, e.g. 2×500 mg →
//     1×1000 mg) cascaded away EVERY historical log for that dose — months of
//     adherence history silently destroyed.
//   • A log carried no record of what was taken: history displays joined the
//     live dose row, so editing an amount retroactively rewrote what every past
//     confirmation appears to have been.
//
// This migration adds the storage for both fixes:
//
//   • intake_item_doses.retired — a soft-retire flag. The edit reconcile now
//     RETIRES a removed dose that has logs (hard-deleting only log-less ones),
//     so history survives a schedule restructure. Every "current schedule" read
//     filters retired = 0 (via getSupplementDoses); history reads keep joining
//     the retired row.
//   • intake_item_logs.amount — the dose amount snapshotted at confirm time.
//     Backfilled from the current dose rows (the best information available —
//     until now the live row was exactly what history displayed anyway). New
//     confirmations write the snapshot; display prefers it over the live row.
//
// Idempotent by construction (guarded ADD COLUMNs, a WHERE-amount-IS-NULL
// backfill) so the non-version-gated `migrate()` test wrapper can replay it;
// production runs it exactly once behind the user_version gate. Determinism
// rule (spec): reads only the DB + its own constants.

function columnNames(db: Database.Database, table: string): Set<string> {
  return new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
      (r) => r.name
    )
  );
}

export function up(db: Database.Database): void {
  if (!columnNames(db, "intake_item_doses").has("retired")) {
    db.exec(
      `ALTER TABLE intake_item_doses ADD COLUMN retired INTEGER NOT NULL DEFAULT 0;`
    );
  }
  if (!columnNames(db, "intake_item_logs").has("amount")) {
    db.exec(`ALTER TABLE intake_item_logs ADD COLUMN amount TEXT;`);
  }

  // Backfill existing logs from their (still-live) dose rows. dose_id is NOT
  // NULL + ON DELETE CASCADE, so every existing log has a matching dose.
  db.exec(
    `UPDATE intake_item_logs
        SET amount = (SELECT d.amount FROM intake_item_doses d
                       WHERE d.id = intake_item_logs.dose_id)
      WHERE amount IS NULL;`
  );
}

export const migration: Migration = {
  id: 4,
  name: "004-dose-history",
  up,
};
