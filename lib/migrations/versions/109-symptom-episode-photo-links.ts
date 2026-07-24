import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 109 (issue #1093): close the two OPEN illness-domain cross-links the
// cross-link audit found (the episode↔visit edge shipped separately as #1053, migration
// 082). Two nullable back-links, both added as NEW columns:
//
//   symptom_photos.symptom_log_id → symptom_logs(id) — a photo attaches to the SPECIFIC
//   log entry it illustrates (not just the profile+date it was born with, migration 049),
//   so two symptoms logged the same day keep DISTINCT photo sets (the #531 "label by the
//   attribute that differs" problem, resolved at the data layer). The `date` stays for
//   display; the log link is the identity. Nullable — a whole-day photo (no symptom) or a
//   photo whose symptom-day isn't logged carries none.
//
//   symptom_logs.episode_id → illness_episodes(id) — a symptom logged while an illness
//   episode is OPEN default-associates to it (logSymptomCore), so the episode cockpit can
//   gather its own evidence and the association survives boundary edits. Nullable — a
//   one-off symptom outside any episode carries none; detach nulls it back.
//
// NO REBUILD NEEDED. SQLite can't attach an FK to an EXISTING column, but it DOES allow a
// NEW nullable REFERENCES column via ALTER TABLE ADD COLUMN (the default is NULL, which
// satisfies the FK trivially) — the exact posture migrations 082 (illness_episodes.
// encounter_id) and 046 (profile_share_links.episode_id) already ship. The runner applies
// migrations with foreign_keys OFF and restores it after, so the ADD is unconstrained.
//
// NO ON DELETE action (matching the whole illness domain's row-op convention, #203): the
// app's write paths clear the side-state explicitly under foreign_keys=ON —
//   • deleting a symptom log first deletes its photos (removeSymptomCore / the custom-
//     symptom deletes route through deletePhotosForSymptomLog);
//   • deleting an episode NULLs its symptoms' episode_id (deleteEpisodeRow); a merge
//     REPARENTS them to the keeper (mergeEpisodeRows), the same children-move-to-keeper
//     treatment that migration's visit-links + stopped-meds already get.
// deleteProfile sweeps the whole subtree with foreign_keys OFF, so its OWNED_TABLES order
// is unaffected; both tables are already profile-owned (no owned-tables.ts change).
//
// Guarded ADD COLUMN + CREATE INDEX IF NOT EXISTS keep the non-version-gated migrate()
// replay a pure no-op. Determinism: reads only the DB + its own constants.

function columnNames(db: Database.Database, table: string): Set<string> {
  return new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
      (r) => r.name
    )
  );
}

export function up(db: Database.Database): void {
  if (!columnNames(db, "symptom_photos").has("symptom_log_id")) {
    db.exec(
      `ALTER TABLE symptom_photos
         ADD COLUMN symptom_log_id INTEGER REFERENCES symptom_logs(id)`
    );
  }
  if (!columnNames(db, "symptom_logs").has("episode_id")) {
    db.exec(
      `ALTER TABLE symptom_logs
         ADD COLUMN episode_id INTEGER REFERENCES illness_episodes(id)`
    );
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_symptom_photos_log
      ON symptom_photos(profile_id, symptom_log_id);
    CREATE INDEX IF NOT EXISTS idx_symptom_logs_episode
      ON symptom_logs(profile_id, episode_id);
  `);
}

export const migration: Migration = {
  id: 109,
  name: "109-symptom-episode-photo-links",
  up,
};
