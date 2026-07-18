import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 057 (issue #700 — the flagged-LABS follow-up adapter). The finding →
// follow-up → resolution chain shipped its core + imaging adapter in migration 050;
// this extends the SAME care_plan_items chain with the FLAGGED-LAB adapter, whose
// source finding and resolving record are both medical_records rows (a flagged
// biomarker result → a later repeat draw of the same #482 biomarker family). Per the
// migration-050 design note ("a new adapter appends its own FK column + a kind string
// without touching the core"), this needs NO new record type — biomarkers, flags, and
// care_plan_items already exist — only two nullable link columns:
//   - source_medical_record_id INTEGER REFERENCES medical_records(id) — the flagged
//     lab reading that motivated the follow-up ("Recheck A1c — for the flagged 8.2%").
//     Nullable, NO ON DELETE (house style): deleting the reading NULLs this link first
//     (the record delete via captureDelete + the import footprint clear/move), never
//     cascade-drops the follow-up (#199-#203 row-ops).
//   - resolved_by_medical_record_id INTEGER REFERENCES medical_records(id) — the later
//     reading the resolution was recorded against. Nullable, NO ON DELETE — same NULL-
//     first row-ops handling as the source link.
// (source_kind — the adapter discriminator, now 'labs' — and recommended_interval_days /
// resolution / resolved_at already exist from migration 050; only the two medical_records
// FK columns + an index are new.)
//
// SQLite permits a REFERENCES clause on a BRAND-NEW nullable column (default NULL) — no
// create→copy→drop→rename dance (the migration 050/026 precedent). The runner applies
// every migration with foreign_keys OFF and restores it, so every stored REFERENCES is
// enforced at runtime on the app's foreign_keys=ON connection.
//
// REPLAY SAFETY: the non-version-gated migrate() wrapper replays up() unconditionally,
// so each ADD COLUMN is guarded behind a column-presence check. Production applies it
// exactly once behind the user_version gate. Determinism: reads only the DB catalog.

function columnNames(db: Database.Database, table: string): string[] {
  return (
    db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
  ).map((r) => r.name);
}

export function up(db: Database.Database): void {
  const cols = new Set(columnNames(db, "care_plan_items"));
  // Table absent (shouldn't happen after baseline) → nothing to alter.
  if (cols.size === 0) return;
  if (!cols.has("source_medical_record_id")) {
    db.exec(
      `ALTER TABLE care_plan_items
         ADD COLUMN source_medical_record_id INTEGER REFERENCES medical_records(id);`
    );
  }
  if (!cols.has("resolved_by_medical_record_id")) {
    db.exec(
      `ALTER TABLE care_plan_items
         ADD COLUMN resolved_by_medical_record_id INTEGER REFERENCES medical_records(id);`
    );
  }
  // Index the follow-up source link so the labs builder's "linked follow-ups for this
  // profile" read and the record-delete NULL-sweep stay cheap (mirrors migration 050's
  // idx_care_plan_items_source_imaging).
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_care_plan_items_source_medical
       ON care_plan_items(source_medical_record_id)
       WHERE source_medical_record_id IS NOT NULL;`
  );
}

export const migration: Migration = {
  id: 57,
  name: "057-followup-labs",
  up,
};
