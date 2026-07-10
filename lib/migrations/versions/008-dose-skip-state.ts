import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 008: a first-class "skipped" dose state (issue #232).
//
// Adherence used to have two states: a dose was taken (an intake_item_logs row)
// or it was absent — and "absent" conflated *forgot* with *deliberately chose
// not to* (took it early, doctor said pause, side-effect day). A skip is now a
// first-class LOG ROW so everything built on the per-(dose,date) dedup keeps
// working unchanged (idempotency, edit-reconcile retirement, the amount
// snapshot), while adherence, escalation, and every reminder surface can tell a
// decided skip from a real miss.
//
//   • intake_item_logs.status — 'taken' | 'skipped', NOT NULL DEFAULT 'taken'.
//     The default leaves every EXISTING log row a taken dose (its historical
//     meaning), so no backfill is needed. A CHECK pins the two-value enum; SQLite
//     permits a CHECK on ADD COLUMN as long as the default satisfies it.
//   • intake_item_logs.skip_reason — optional free text (nullable; no taxonomy in
//     v1). Only ever set on a skipped row.
//
// A skipped row snapshots amount NULL (nothing was consumed) and never decrements
// on-hand supply — the confirm/skip write paths enforce that, not this migration.
//
// Idempotent by construction (guarded ADD COLUMNs behind a PRAGMA table_info
// check) so the non-version-gated `migrate()` test wrapper can replay it;
// production runs it exactly once behind the user_version gate. Determinism rule
// (spec): reads only the DB + its own constants.

function columnNames(db: Database.Database, table: string): Set<string> {
  return new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
      (r) => r.name
    )
  );
}

export function up(db: Database.Database): void {
  const cols = columnNames(db, "intake_item_logs");
  if (!cols.has("status")) {
    db.exec(
      `ALTER TABLE intake_item_logs
         ADD COLUMN status TEXT NOT NULL DEFAULT 'taken'
           CHECK (status IN ('taken','skipped'));`
    );
  }
  if (!cols.has("skip_reason")) {
    db.exec(`ALTER TABLE intake_item_logs ADD COLUMN skip_reason TEXT;`);
  }
}

export const migration: Migration = {
  id: 8,
  name: "008-dose-skip-state",
  up,
};
