import type Database from "better-sqlite3";

// Intake/medication one-off migrations, extracted verbatim from lib/db.ts. Called
// from migrate() after intake_items + its `kind` column exist. Behavior-preserving.

// Medication history / lifecycle (issue #209, Phase 1). Two profile-owned CHILD
// tables of intake_items — reached through the parent for profile scoping (every
// read JOINs intake_items and filters ii.profile_id). Both FK item_id →
// intake_items(id) ON DELETE CASCADE, so deleteProfile (which deletes the parent
// intake_items rows) and the #203 document-delete clean them up automatically via
// the parent; no explicit deletes are needed for them. Idempotent: CREATE TABLE
// IF NOT EXISTS + a backfill guarded by NOT EXISTS so a reboot never duplicates a
// course. Uses db.exec (not .prepare) for the global backfill, matching the other
// boot-time, profile-agnostic migrations in migrate().
export function migrateMedicationHistory(db: Database.Database) {
  db.exec(`
    -- One episode (course) of taking a medication. started_on is the episode
    -- start; stopped_on NULL means it's still open (the med is currently taken).
    -- stop_reason is a controlled string (validated in lib/medication-history);
    -- free-text detail for the stop lives in notes. Restarting a med opens a NEW
    -- course rather than editing the old one, so the full history is preserved.
    CREATE TABLE IF NOT EXISTS medication_courses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id INTEGER NOT NULL REFERENCES intake_items(id) ON DELETE CASCADE,
      started_on TEXT,
      stopped_on TEXT,
      stop_reason TEXT,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_med_courses_item ON medication_courses(item_id);

    -- A side effect noted against a medication, optionally linked to the course it
    -- occurred during (course_id → medication_courses, SET NULL if that course row
    -- is later removed). resolved marks it no longer ongoing. A side effect can be
    -- promoted into an allergies/intolerance row (see the medicine actions).
    CREATE TABLE IF NOT EXISTS intake_item_side_effects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id INTEGER NOT NULL REFERENCES intake_items(id) ON DELETE CASCADE,
      course_id INTEGER REFERENCES medication_courses(id) ON DELETE SET NULL,
      effect TEXT NOT NULL,
      severity TEXT,
      noted_on TEXT,
      notes TEXT,
      resolved INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_side_effects_item
      ON intake_item_side_effects(item_id);
  `);

  // Backfill (idempotent): give every existing medication that has NO course yet
  // exactly one initial course, started on its created_at date. The course is
  // left OPEN only when the med is currently active (active=1); an already-paused/
  // discontinued med (active=0) backfills to a CLOSED course (stopped_on =
  // created_at date) so it lands in Past and never contradicts its active flag —
  // upholding the invariant active=1 ⇔ an open course. The NOT EXISTS guard makes
  // a reboot a no-op, so this never duplicates a course. Global + profile-agnostic
  // like the other boot migrations, hence db.exec.
  db.exec(`
    INSERT INTO medication_courses (item_id, started_on, stopped_on, created_at)
      SELECT ii.id, date(ii.created_at),
             CASE WHEN ii.active = 1 THEN NULL ELSE date(ii.created_at) END,
             datetime('now')
        FROM intake_items ii
       WHERE ii.kind = 'medication'
         AND NOT EXISTS (
           SELECT 1 FROM medication_courses c WHERE c.item_id = ii.id
         );
  `);
}
