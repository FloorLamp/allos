import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 095 (issue #1140 Part B): the reversal record an episode's end must leave so
// its reopen can invert it. Ending an illness with med reconciliation (#880) closes the
// selected meds' courses with reason `illness_resolved` and returns `stoppedItemIds` —
// which the caller discarded. Reopening restarted no meds, leaving the ibuprofen/
// antibiotic it stopped sitting "Past" (the #200/#202 asymmetry: undo must invert the
// side effects, not just the row).
//
// `episode_stopped_meds` persists WHICH meds (and the exact course) this episode's end
// closed. On reopen the restore is SUGGEST-ONLY (#560) and guarded to only restart a med
// whose latest course is STILL that `illness_resolved` close (a manual restart / re-stop
// / delete / edit-form clear between end and reopen moves the latest course off it, and
// is skipped — #202 "links that may have died"). The link is consumed on reopen and
// cleaned on med delete / episode delete+merge (id-keyed, #203).
//
// House rules: NEW profile-OWNED table (born `profile_id INTEGER NOT NULL`), joins
// OWNED_TABLES. `course_id` references the medication_courses CHILD row (no ON DELETE —
// deleting a med clears these links first). NOT an import-footprint table. CREATE ... IF
// NOT EXISTS keeps the migrate() replay a pure no-op.
export function up(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS episode_stopped_meds (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id INTEGER NOT NULL REFERENCES profiles(id),
      episode_id INTEGER NOT NULL REFERENCES illness_episodes(id),
      item_id    INTEGER NOT NULL REFERENCES intake_items(id),
      course_id  INTEGER NOT NULL REFERENCES medication_courses(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_episode_stopped_meds_link
      ON episode_stopped_meds(profile_id, episode_id, item_id, course_id);
    CREATE INDEX IF NOT EXISTS idx_episode_stopped_meds_item
      ON episode_stopped_meds(profile_id, item_id);
  `);
}

export const migration: Migration = {
  id: 95,
  name: "095-episode-stopped-meds",
  up,
};
