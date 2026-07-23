import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 096 (issue #1119 phase 2): the physique progress-photo domain —
// dated, pose-tagged body photos over the shared photo core (EXIF-stripped,
// downscaled, thumbnailed at ingest; files under
// data/uploads/progress-photos/<profileId>/).
//
// NOT an observation-store tenant (#860/#944): a progress photo is file-backed
// MEDIA with a thin metadata row — the lesion_photos/symptom_photos photo-table
// precedent (#715/#859), not a dated reading for metric_samples/body_metrics.
// `weight_kg_snapshot` is a display snapshot of the body_metrics weight near the
// photo's date (one computation at write time, so compare can show
// "82.1 kg → 78.4 kg"), never a second weight store.
//
// House rules: NEW profile-OWNED table (born `profile_id INTEGER NOT NULL`),
// joins OWNED_TABLES; `pose` CHECK mirrors lib/progress-photos.ts
// PROGRESS_POSES; per-profile content-hash dedup is enforced by the write core
// (UNIQUE(profile_id, content_hash) pins it at the schema level too).
// `thumb_path` is nullable by design (a future core domain migrated from
// pre-thumbnail rows keeps null). NOT an import-footprint table (manual capture
// only — no document import writes it). CREATE ... IF NOT EXISTS keeps the
// migrate() replay a pure no-op.
export function up(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS progress_photos (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id         INTEGER NOT NULL REFERENCES profiles(id),
      date               TEXT NOT NULL,
      pose               TEXT NOT NULL CHECK (pose IN ('front','side','back','custom')),
      stored_path        TEXT NOT NULL,
      thumb_path         TEXT,
      content_hash       TEXT NOT NULL,
      mime_type          TEXT,
      size_bytes         INTEGER,
      caption            TEXT,
      weight_kg_snapshot REAL,
      created_at         TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_progress_photos_hash
      ON progress_photos(profile_id, content_hash);
    CREATE INDEX IF NOT EXISTS idx_progress_photos_pose_date
      ON progress_photos(profile_id, pose, date);
  `);
}

export const migration: Migration = {
  id: 96,
  name: "096-progress-photos",
  up,
};
