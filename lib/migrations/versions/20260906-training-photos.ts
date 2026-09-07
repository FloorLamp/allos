import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Issue #3285 item 3 — training photos, a tenant of the #1119 photo core.
//
// ONE TABLE, TWO OWNERS. A photo is of a logged SESSION (`activity_id`) or of an
// EVENT (`endurance_plan_id`) — bib, podium, venue — and never of both. The owner
// is a nullable FK PAIR with an exactly-one CHECK rather than a second photo
// domain, because the store keys a DOMAIN (one dir, one privacy tier, one dedup
// scope), not a foreign key: see lib/training-photo-write.ts for the argument.
// The CHECK is what makes "a photo with no owner" and "a photo owned twice"
// unrepresentable, so no reader needs a guard for either.
//
// BOTH FKs CASCADE. A photo whose owner is gone has no other home — there is no
// second column to fall back to and a NULLed owner would violate the CHECK — so
// deleting the session or the event takes its pictures with it. That is the
// activity_videos posture (098-videos), and it is why the `activity` undo kind
// captures this table alongside the clips: the rows come back with the session,
// and their content-named files are reclaimed only at PURGE (#1847).
//
// NO `date` COLUMN, DELIBERATELY. Every other photo domain dates a photo because
// nothing else does; here the OWNER carries the date already (`activities.date`,
// `endurance_plans.event_date`), so storing a second copy would be one fact in
// two places, free to drift the moment a session's date is corrected. Readers
// derive it in the SELECT, which the CHECK makes total: exactly one owner, and
// both owners' date columns are NOT NULL.
//
// House rules: NEW profile-OWNED table (born `profile_id INTEGER NOT NULL`),
// joins OWNED_TABLES; per-profile content-hash dedup is the write core's rule and
// UNIQUE(profile_id, content_hash) pins it at the schema level too. NOT an
// import-footprint table (manual capture only). CREATE ... IF NOT EXISTS keeps the
// migrate() replay a pure no-op.
//
// Determinism: creates a table and its indexes. Reads nothing, writes no rows.
export function up(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS training_photos (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id        INTEGER NOT NULL REFERENCES profiles(id),
      activity_id       INTEGER REFERENCES activities(id) ON DELETE CASCADE,
      endurance_plan_id INTEGER REFERENCES endurance_plans(id) ON DELETE CASCADE,
      stored_path       TEXT NOT NULL,
      thumb_path        TEXT,
      content_hash      TEXT NOT NULL,
      mime_type         TEXT,
      size_bytes        INTEGER,
      caption           TEXT,
      created_at        TEXT NOT NULL DEFAULT (datetime('now')),
      CHECK ((activity_id IS NULL) <> (endurance_plan_id IS NULL))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_training_photos_hash
      ON training_photos(profile_id, content_hash);
    CREATE INDEX IF NOT EXISTS idx_training_photos_activity
      ON training_photos(activity_id) WHERE activity_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_training_photos_plan
      ON training_photos(endurance_plan_id) WHERE endurance_plan_id IS NOT NULL;
  `);
}

export const migration: Migration = {
  name: "20260906-training-photos",
  up,
};
