import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 065 (issue #716): per-item answers for an in-app-administered mental-health
// instrument (PHQ-9 / GAD-7).
//
// The instrument SCORE reuses the observation substrate (#860/#944): it is a numeric
// `medical_records` biomarker row (canonical_name "PHQ-9"/"GAD-7", value_num = total),
// so trending/series come for free. This table holds the ONE thing no store carries — the
// per-item answers (0..3) captured when the user taps through the questionnaire in-app,
// REQUIRED for the item-9 (suicidal-ideation) handling. An OUTSIDE score entered as a
// total-only reading simply has no rows here and degrades to total-only handling.
//
// instrument_responses — DIRECTLY profile-owned (born `profile_id INTEGER NOT NULL
// REFERENCES profiles(id)`) so it joins OWNED_TABLES (lib/owned-tables.ts); that single
// edit propagates to deleteProfile + the profile-scoping leak test. `medical_record_id`
// links the SCORE row this answer set belongs to, `ON DELETE CASCADE` so deleting the
// score (app runtime, foreign_keys ON) clears its answers automatically — deleteProfile
// runs with foreign_keys OFF and instead clears this table by profile_id in the
// OWNED_TABLES sweep (both paths covered, the #716 row-ops side-state discipline).
// UNIQUE(medical_record_id, item_index) makes a re-administration UPDATE an item in place
// rather than duplicate.
//
// CREATE ... IF NOT EXISTS keeps the non-version-gated migrate() replay a pure no-op.
// Determinism: reads only its own DDL constants.

export function up(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS instrument_responses (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id        INTEGER NOT NULL REFERENCES profiles(id),
      medical_record_id INTEGER NOT NULL REFERENCES medical_records(id) ON DELETE CASCADE,
      item_index        INTEGER NOT NULL,
      answer            INTEGER NOT NULL,
      created_at        TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (medical_record_id, item_index)
    );
    CREATE INDEX IF NOT EXISTS idx_instrument_responses_profile
      ON instrument_responses(profile_id);
    CREATE INDEX IF NOT EXISTS idx_instrument_responses_record
      ON instrument_responses(medical_record_id);
  `);
}

export const migration: Migration = {
  id: 65,
  name: "065-instrument-responses",
  up,
};
