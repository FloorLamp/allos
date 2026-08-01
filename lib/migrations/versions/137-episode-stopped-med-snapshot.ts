import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 137 (issue #1808): give `episode_stopped_meds` a med-NAME snapshot and make
// both of its med-side links nullable with ON DELETE SET NULL.
//
// THE BUG. Migration 095 created the table with `item_id INTEGER NOT NULL REFERENCES
// intake_items(id)` and `course_id INTEGER NOT NULL REFERENCES medication_courses(id)`,
// both ON DELETE NO ACTION. `intake_items` is an IMPORT FOOTPRINT table, so a document
// delete OR a reprocess deletes this profile's extracted meds — and the stop record
// refused it. The whole transaction rolled back: a document whose extracted medication
// an illness episode later stopped could be neither deleted nor reprocessed, and the
// failure surfaced as a bare SQLITE_CONSTRAINT_FOREIGNKEY. `course_id` blocks the same
// delete one hop later: `medication_courses` is a CASCADE child of `intake_items`, so
// the med delete cascades into the courses and THAT delete trips `course_id`.
//
// WHY NOT CASCADE (the shape the two sibling child tables use). A reprocess is a routine
// maintenance action that clears and re-inserts the same document's rows. Under CASCADE
// it would silently delete the stop records and re-extract the same med under a new id:
// the med survives, the episode's memory of stopping it is gone, no error, no trace. That
// turns a loud bug into quiet history destruction.
//
// WHY NOT "delete the link rows first" (the shape clearImportedDocumentRows uses for its
// other blocked back-links). Those are all links whose row keeps meaning without them —
// an appointment without its encounter, a care-plan item without its source finding. A
// stop record IS its link: `item_id` was the whole identity of the row, so freeing the
// link by deleting the row loses the narrative it exists to hold, on delete AND on every
// reprocess.
//
// THE HOUSE ANSWER IS SNAPSHOT-AT-WRITE ("confirming a dose snapshots the amount onto the
// log"). The stop record is EPISODE-owned narrative, not document-owned import data, so
// it should outlive the med row. It can now: `med_name` carries what was stopped, and the
// two links degrade to NULL when their med/course goes. The episode still reads "this
// illness ended these medications", by name — the honest state — and the reopen-restore
// checklist (getEpisodeReopenMedRestore) simply stops offering a med whose row is gone,
// which is already how it treats a link that died between end and reopen.
//
// BACKFILL is total: every pre-137 row had a NOT NULL `item_id` under an ENFORCED FK, and
// the FK is precisely why no med it points at was ever deleted. The LEFT JOIN + CASE is
// belt-and-braces for a hand-edited database — a dangling id lands as NULL rather than
// failing the re-enabled FK check, and an unresolvable name lands as '' (never shown).
//
// WHY A REBUILD. SQLite cannot add an ON DELETE action to an existing column, nor drop a
// NOT NULL, so the table is rebuilt by the standard create → copy → drop → rename, like
// migrations 090 / 106 / 124. `episode_stopped_meds` is a FK CHILD only (nothing
// references it), so the DROP strands nothing.
//
// REPLAY SAFETY (the DB-test harness replays every migration unconditionally): the
// rebuild short-circuits once the live table carries `med_name`.

const CREATE = `
  CREATE TABLE episode_stopped_meds (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id INTEGER NOT NULL REFERENCES profiles(id),
    episode_id INTEGER NOT NULL REFERENCES illness_episodes(id),
    -- Nullable + SET NULL: the med/course may be deleted (or re-extracted) out from
    -- under a stop record without taking the record with it.
    item_id    INTEGER REFERENCES intake_items(id) ON DELETE SET NULL,
    course_id  INTEGER REFERENCES medication_courses(id) ON DELETE SET NULL,
    -- The snapshot: the med's name as it read when the episode's end stopped it. '' only
    -- for a row whose med could not be resolved at migration time (never written since).
    med_name   TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );`;

const INDEXES = [
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_episode_stopped_meds_link
     ON episode_stopped_meds(profile_id, episode_id, item_id, course_id);`,
  `CREATE INDEX IF NOT EXISTS idx_episode_stopped_meds_item
     ON episode_stopped_meds(profile_id, item_id);`,
];

function columnNames(db: Database.Database, table: string): string[] {
  return (
    db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
  ).map((r) => r.name);
}

export function up(db: Database.Database): void {
  // MUST run with foreign_keys disabled — the runner and the migrate() test wrapper both
  // toggle it off around migration application (issue #95). One (possibly nested)
  // transaction so the copy and the rename are atomic.
  const run = db.transaction(() => {
    const cols = new Set(columnNames(db, "episode_stopped_meds"));
    if (cols.size === 0) return; // table not present — nothing to converge
    if (cols.has("med_name")) return; // already rebuilt — replay no-op

    const scratch = "episode_stopped_meds__new137";
    db.exec(
      CREATE.replace(
        "CREATE TABLE episode_stopped_meds (",
        `CREATE TABLE ${scratch} (`
      )
    );
    db.exec(
      `INSERT INTO ${scratch}
         (id, profile_id, episode_id, item_id, course_id, med_name, created_at)
       SELECT esm.id, esm.profile_id, esm.episode_id,
              CASE WHEN ii.id IS NULL THEN NULL ELSE esm.item_id END,
              CASE WHEN c.id IS NULL THEN NULL ELSE esm.course_id END,
              COALESCE(ii.name, ''),
              esm.created_at
         FROM episode_stopped_meds esm
         LEFT JOIN intake_items ii ON ii.id = esm.item_id
         LEFT JOIN medication_courses c ON c.id = esm.course_id;`
    );
    db.exec(`DROP TABLE episode_stopped_meds;`);
    db.exec(`ALTER TABLE ${scratch} RENAME TO episode_stopped_meds;`);
    for (const idx of INDEXES) db.exec(idx);
  });
  run.immediate();
}

export const migration: Migration = {
  id: 137,
  name: "137-episode-stopped-med-snapshot",
  up,
};
