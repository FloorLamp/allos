import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 050 (issue #700, #860 Track A / #707 Substrate 1): the finding →
// follow-up → resolution chain, over the EXISTING care_plan_items lifecycle (#658)
// rather than a new table. A care-plan item can now be a tracked FOLLOW-UP: it
// links BACK to the domain record that motivated it (a "source finding" — an
// imaging study first; IOP/dental/skin/labs plug in later), carries the recommended
// interval, and links FORWARD to the later record that resolves it plus the
// resolution outcome. That closes the loop the generic planned-care line left open:
// "follow up in 12 months" becomes "Follow-up CT — for the 6 mm RLL nodule (2026-03)",
// and when the later scan lands the app OFFERS (confirm-first, #560) to mark the
// finding resolved/stable/changed against it, yielding a serial view of one finding.
//
// Columns added to care_plan_items (all nullable — a generic care-plan item sets
// none of them, so the read/write paths are unchanged for the non-follow-up case):
//   - source_kind TEXT — the domain ADAPTER discriminator ('imaging'). The
//     domain-agnostic core reads (source_kind + the matching concrete FK) as one
//     normalized source ref, so a new adapter appends its own FK column + a kind
//     string without touching the core.
//   - source_imaging_study_id INTEGER REFERENCES imaging_studies(id) — the imaging
//     source finding. Nullable, NO ON DELETE (house style): deleting the study NULLs
//     this link first (the imaging delete action + the import footprint clear/move),
//     never cascade-drops the follow-up (#199-#203 row-ops).
//   - recommended_interval_days INTEGER — the follow-up interval (study_date +
//     interval = planned_date at creation), carried so the "recommended in 12 months"
//     legibility line and any re-derivation have one stored source.
//   - resolution TEXT — the outcome once resolved ('resolved' | 'stable' | 'changed'),
//     validated in code (lib/followup.ts normalizeResolution) like the imaging enums,
//     NOT a DB CHECK (an ADD COLUMN carries no rebuild here).
//   - resolved_by_imaging_study_id INTEGER REFERENCES imaging_studies(id) — the later
//     study the resolution was recorded against. Nullable, NO ON DELETE — same NULL-
//     first row-ops handling as the source link.
//   - resolved_at TEXT — when the resolution was recorded.
//
// SQLite permits a REFERENCES clause on a BRAND-NEW nullable column (default NULL) —
// no create→copy→drop→rename dance (the migration 026 precedent). The runner applies
// every migration with foreign_keys OFF and restores it, so every stored REFERENCES
// is enforced at runtime on the app's foreign_keys=ON connection.
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
  if (!cols.has("source_kind")) {
    db.exec(`ALTER TABLE care_plan_items ADD COLUMN source_kind TEXT;`);
  }
  if (!cols.has("source_imaging_study_id")) {
    db.exec(
      `ALTER TABLE care_plan_items
         ADD COLUMN source_imaging_study_id INTEGER REFERENCES imaging_studies(id);`
    );
  }
  if (!cols.has("recommended_interval_days")) {
    db.exec(
      `ALTER TABLE care_plan_items ADD COLUMN recommended_interval_days INTEGER;`
    );
  }
  if (!cols.has("resolution")) {
    db.exec(`ALTER TABLE care_plan_items ADD COLUMN resolution TEXT;`);
  }
  if (!cols.has("resolved_by_imaging_study_id")) {
    db.exec(
      `ALTER TABLE care_plan_items
         ADD COLUMN resolved_by_imaging_study_id INTEGER REFERENCES imaging_studies(id);`
    );
  }
  if (!cols.has("resolved_at")) {
    db.exec(`ALTER TABLE care_plan_items ADD COLUMN resolved_at TEXT;`);
  }
  // Index the follow-up source link so the builder's "linked follow-ups for this
  // profile" read and the imaging-delete NULL-sweep stay cheap.
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_care_plan_items_source_imaging
       ON care_plan_items(source_imaging_study_id)
       WHERE source_imaging_study_id IS NOT NULL;`
  );
}

export const migration: Migration = {
  id: 50,
  name: "050-followup-chain",
  up,
};
