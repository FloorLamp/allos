import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 168 (issue #2232): illness_episodes joins the day-window vocabulary —
// `started_at`/`ended_at` become `start_date`/`end_date`, and the stored end becomes
// the INCLUSIVE last active day.
//
// The old columns were wrong twice, per the #2205 phase 3 census (PR #2229):
//   1. The `_at` suffix means "an absolute instant" everywhere else in the schema, but
//      these hold profile-local DAYS (#94 `date` semantics, untouched here).
//   2. `ended_at` was EXCLUSIVE — the first day the episode was NOT active — while
//      every other stored day-window end in the schema is the INCLUSIVE last member
//      day (`intake_item_doses.end_date` / dose-schedule validity, "Both bounds are
//      INCLUSIVE"; `protocols.end_date`, window = [start_date, end_date ?? today];
//      `encounters.end_date`, displayed as the visit's last day; menstrual cycles'
//      `period_end`, the last bleeding day).
//
// So this is a rename PLUS a value rewrite: a non-NULL `ended_at` becomes
// `date(ended_at, '-1 day')` — the same day the episode's own readers always derived
// as "last active day" — and a NULL end (an ongoing episode) stays NULL. Membership
// and duration are preserved exactly: [start, end) under the old convention covers
// the same days as [start_date, end_date] under the new one. Every reader flips its
// boundary predicate in this same change (`ended_at > d` → `end_date >= d`), and the
// off-by-one compensations (`shiftDateStr(ended_at, -1)`, `date(?, '-1 day')` on
// condition sync) are deleted rather than moved.
//
// INTERACTION WITH FROZEN MIGRATION 046. Its backfill imports the live
// `episodesForSituation` pairing, whose output deliberately stays on the change-log's
// stop-event shape (end = the stop day, i.e. the old exclusive end) precisely so a
// from-scratch replay writes 046-era values that THIS migration then converts. Do not
// "fix" that function to emit inclusive ends — it would make fresh replays subtract a
// day twice.
//
// Rebuild, not ALTER: the 162/163 pattern (CREATE __new, INSERT…SELECT with the
// transformation, DROP, RENAME, re-create the indexes) keeps the whole swap one
// statement sequence and lets the value rewrite ride the copy. The runner applies
// migrations with foreign_keys OFF, so the children keyed on illness_episodes(id)
// (profile_share_links, symptom_logs, episode_stopped_meds, episode_encounters) are
// untouched by the drop; the rename restores the parent name their FKs reference.
//
// AUTOINCREMENT high-water mark: episode ids must never recycle (the recently-resolved
// dismissal and stale-nudge ack sets rely on it), and a DROP discards the
// sqlite_sequence entry — so the old `seq` is captured first and restored after the
// rename if the copy's own max id came in lower (e.g. the newest episode had been
// deleted).
//
// REPLAY-SAFE. The DB test tier replays migrations through the non-version-gated
// migrate() wrapper. Guarded on the stored table SQL: once the table carries
// `end_date` the whole migration is a no-op, so the -1 day rewrite can never fire
// twice. The rewrite itself is GLOB-guarded to well-formed YYYY-MM-DD values; any
// malformed value passes through unchanged rather than being guessed at.

const DAY_GLOB = "[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]";

function tableSql(db: Database.Database, name: string): string {
  return (
    (
      db
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?"
        )
        .get(name) as { sql: string } | undefined
    )?.sql ?? ""
  );
}

export function up(db: Database.Database): void {
  if (tableSql(db, "illness_episodes").includes("end_date")) return;

  const prior = db
    .prepare(`SELECT seq FROM sqlite_sequence WHERE name = 'illness_episodes'`)
    .get() as { seq: number } | undefined;

  db.exec(`
    CREATE TABLE illness_episodes__new (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id INTEGER NOT NULL REFERENCES profiles(id),
      situation  TEXT NOT NULL,
      start_date TEXT,
      end_date   TEXT,
      note       TEXT,
      outcome    TEXT
    );
    INSERT INTO illness_episodes__new
      (id, profile_id, situation, start_date, end_date, note, outcome)
      SELECT id, profile_id, situation, started_at,
             CASE WHEN ended_at GLOB '${DAY_GLOB}'
                  THEN date(ended_at, '-1 day') ELSE ended_at END,
             note, outcome
        FROM illness_episodes;
    DROP TABLE illness_episodes;
    ALTER TABLE illness_episodes__new RENAME TO illness_episodes;
    CREATE INDEX IF NOT EXISTS idx_illness_episodes_profile
      ON illness_episodes(profile_id, start_date);
    CREATE INDEX IF NOT EXISTS idx_illness_episodes_open
      ON illness_episodes(profile_id, situation, end_date);
  `);

  if (prior != null) {
    // Restore the pre-rebuild high-water mark when it exceeds the copied rows' own
    // max (the INSERT re-seeded sqlite_sequence only up to the surviving max id, and
    // an empty table re-created no entry at all). sqlite_sequence carries no unique
    // constraint, so the upsert is spelled out.
    const now = db
      .prepare(
        `SELECT seq FROM sqlite_sequence WHERE name = 'illness_episodes'`
      )
      .get() as { seq: number } | undefined;
    if (now == null) {
      db.prepare(
        `INSERT INTO sqlite_sequence (name, seq) VALUES ('illness_episodes', ?)`
      ).run(prior.seq);
    } else if (now.seq < prior.seq) {
      db.prepare(
        `UPDATE sqlite_sequence SET seq = ? WHERE name = 'illness_episodes'`
      ).run(prior.seq);
    }
  }
}

export const migration: Migration = {
  id: 168,
  name: "168-illness-episode-day-window",
  up,
};
