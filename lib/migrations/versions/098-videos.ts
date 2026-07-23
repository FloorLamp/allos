import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 098 (issue #1224 phase 1): the video-capture domains — symptom /
// episode clips and training form-check clips — over the shared video core
// (container-sniffed, capped, content-hash-dedup at ingest; files stored AS-IS,
// no re-encode, under data/uploads/<domain>-videos/<profileId>/). The upload-first
// sibling of the #1119 photo core.
//
// TWO tables share ONE migration version (they ship together and neither depends
// on the other's rows):
//
//   symptom_videos — one row per stored clip attached to a symptom-DAY (the same
//   membership-by-date model illness episodes use — an episode gathers it by
//   range, no FK to an episode). `symptom` optionally pins a specific symptom-day.
//   Mirrors symptom_photos (#859 item 4) exactly, plus the video-only columns.
//
//   activity_videos — one row per stored clip attached to an ACTIVITY (a form
//   check). `activity_id` FK carries ON DELETE CASCADE so a plain activity delete
//   removes its clips (the rows are captured into the undo buffer first —
//   UNDO_KINDS.activity, lib/undo-delete.ts — so a mis-tap delete is undoable;
//   #199/#200). `exercise` optionally names a lift for per-lift filtering.
//
// House rules: BOTH are NEW profile-OWNED tables (born `profile_id INTEGER NOT
// NULL REFERENCES profiles(id)`), so they join OWNED_TABLES (lib/owned-tables.ts)
// and deleteProfile clears their rows + unlinks their files (path-contained).
// NOT observation-store tenants (#860/#944): a clip is file-backed MEDIA with a
// thin metadata row — the lesion_photos/symptom_photos/progress_photos precedent,
// not a dated reading. NOT import-footprint tables (manual capture only). Per-
// profile content-hash dedup is pinned by a UNIQUE partial index. `kind` (video/
// audio) is server-derived from the container sniff. `has_location` records that
// an embedded GPS atom was DETECTED (never the coordinate) to drive the privacy
// note. CREATE ... IF NOT EXISTS keeps the migrate() replay a pure no-op.
//
// The runner applies every migration with foreign_keys OFF and restores it after,
// so the activity_videos → activities FK attaches cleanly on a rebuilt schema.
export function up(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS symptom_videos (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id    INTEGER NOT NULL REFERENCES profiles(id),
      date          TEXT NOT NULL,
      symptom       TEXT,
      stored_path   TEXT NOT NULL,
      poster_path   TEXT,
      content_hash  TEXT,
      mime_type     TEXT,
      kind          TEXT NOT NULL DEFAULT 'video' CHECK (kind IN ('video','audio')),
      duration_sec  REAL,
      size_bytes    INTEGER,
      has_location  INTEGER NOT NULL DEFAULT 0,
      caption       TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_symptom_videos_profile
      ON symptom_videos(profile_id, date DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_symptom_videos_dedup
      ON symptom_videos(profile_id, content_hash)
      WHERE content_hash IS NOT NULL;

    CREATE TABLE IF NOT EXISTS activity_videos (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id    INTEGER NOT NULL REFERENCES profiles(id),
      activity_id   INTEGER NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
      exercise      TEXT,
      stored_path   TEXT NOT NULL,
      poster_path   TEXT,
      content_hash  TEXT,
      mime_type     TEXT,
      kind          TEXT NOT NULL DEFAULT 'video' CHECK (kind IN ('video','audio')),
      duration_sec  REAL,
      size_bytes    INTEGER,
      has_location  INTEGER NOT NULL DEFAULT 0,
      caption       TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_activity_videos_profile
      ON activity_videos(profile_id, activity_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_activity_videos_dedup
      ON activity_videos(profile_id, content_hash)
      WHERE content_hash IS NOT NULL;
  `);
}

export const migration: Migration = {
  id: 98,
  name: "098-videos",
  up,
};
