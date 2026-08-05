import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 156 (issue #2024): the USER-DECLARED precision of an injury constraint.
//
// An injury row stays what it always was — the user's explicit training constraint, not a
// diagnosis — but the constraint could only be declared at one coarse level (a whole
// MuscleRegion), so marking one shoulder-related movement removed every recommendation in
// that region, and every recovering constraint received the same fixed 60% suggestion.
// These five nullable columns let the user say what they actually mean:
//
//   • laterality  — which side, for display and future side-aware consumers. The engine
//                   picks exercises rather than sides, so a declared side is DISCLOSED as
//                   a limitation on a bilateral lift, never silently "honored".
//   • movements   — JSON MovementPattern[] ('push'/'pull'/'legs'/'core', the existing
//                   lib/lifts vocabulary), when the constraint is a pattern.
//   • exercises   — JSON of CANONICAL exercise identities (exerciseHistoryKey), when the
//                   constraint is specific lifts. Never raw labels.
//   • load_factor — the user's own recovering load preference as a fraction; NULL keeps
//                   the app's disclosed 60% fallback.
//   • review_date — a date the user wants to revisit the constraint on. It only ever
//                   produces a suggest-to-review affordance; nothing relaxes, transitions
//                   or expires a constraint automatically.
//
// APPEND-ONLY and fully backward compatible: every existing row reads back with all five
// NULL/empty, which resolves to exactly a region-scoped constraint — the pre-#2024
// behavior, byte for byte. No backfill, no rebuild.
//
// The `laterality` CHECK admits NULL so existing rows satisfy it; ADD COLUMN with a CHECK
// is evaluated on write, and no existing row carries a value. Determinism (spec): reads
// only the DB + its own constants.

function columnNames(db: Database.Database, table: string): Set<string> {
  return new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
      (row) => row.name
    )
  );
}

export function up(db: Database.Database): void {
  const cols = columnNames(db, "injuries");
  if (!cols.has("laterality")) {
    db.exec(
      `ALTER TABLE injuries ADD COLUMN laterality TEXT
         CHECK (laterality IS NULL OR laterality IN ('left','right','bilateral'))`
    );
  }
  if (!cols.has("movements")) {
    db.exec(`ALTER TABLE injuries ADD COLUMN movements TEXT`);
  }
  if (!cols.has("exercises")) {
    db.exec(`ALTER TABLE injuries ADD COLUMN exercises TEXT`);
  }
  if (!cols.has("load_factor")) {
    db.exec(`ALTER TABLE injuries ADD COLUMN load_factor REAL`);
  }
  if (!cols.has("review_date")) {
    db.exec(`ALTER TABLE injuries ADD COLUMN review_date TEXT`);
  }
}

export const migration: Migration = {
  id: 156,
  name: "156-injury-scope",
  up,
};
