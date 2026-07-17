import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 049 (issue #859 item 4): symptom photos — attach a photo to a symptom-day
// so "is the rash spreading?" is answered by comparing dated images. Rides the EXISTING
// medical-uploads posture (per-profile dirs, content-hash dedup, profile-scoped
// serving) but its OWN table + files dir, so a rash photo never lands in the medical
// document pipeline / passport.
//
//   symptom_photos — one row per stored photo. Profile-OWNED (born
//   `profile_id INTEGER NOT NULL REFERENCES profiles(id)`), so it joins OWNED_TABLES
//   (lib/owned-tables.ts) and deleteProfile clears it + unlinks its files. `date` binds
//   the photo to a symptom-DAY (the same membership-by-date model illness episodes use
//   — an episode gathers it by range, no FK to an episode); `symptom` is an OPTIONAL
//   bind to a specific symptom-day row (its stable key), NULL for a whole-day photo.
//   `content_hash` powers per-profile dedup (a UNIQUE partial index).
//
// PHI POSTURE (#859): photos are EXCLUDED from share-link summaries + the printable by
// default — nothing in this table is read by the episode share/print path
// (assembleIllnessEpisode); the episode PAGE reads it through its own gather. So the
// safe default (exclude) is structural, not a flag.
//
// CREATE ... IF NOT EXISTS keeps the non-version-gated migrate() replay a no-op.
// Determinism: reads only the DB + its own constants.

export function up(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS symptom_photos (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id   INTEGER NOT NULL REFERENCES profiles(id),
      date         TEXT NOT NULL,
      symptom      TEXT,
      stored_path  TEXT NOT NULL,
      content_hash TEXT,
      mime_type    TEXT,
      size_bytes   INTEGER,
      caption      TEXT,
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_symptom_photos_profile
      ON symptom_photos(profile_id, date DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_symptom_photos_dedup
      ON symptom_photos(profile_id, content_hash)
      WHERE content_hash IS NOT NULL;
  `);
}

export const migration: Migration = {
  id: 49,
  name: "049-symptom-photos",
  up,
};
