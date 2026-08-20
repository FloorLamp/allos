import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// #3335 — the set grid's per-set RPE column becomes opted into, and everybody who
// was already using it keeps it.
//
// The column used to occupy the set grid for every profile. It now renders only for
// a profile holding the `strength_rpe` row in `profile_settings` (lib/rpe-tracking.ts,
// the only minter of an `RpeTracking`). Without this back-fill, shipping that change
// would take a working column away from the people who log RPE every session — a
// migration to opt-in reading as data loss.
//
// So: every profile with at least one set carrying a rating is opted in here, once.
//
// THIS IS A ONE-TIME MOVE, NOT A READ RULE. The alternative — "opted in if the row
// exists OR the profile has RPE data" — would be a SECOND way to be opted in, which
// is a second producer, which is the drift the structural seam exists to prevent
// (docs/internals/substances.md, "Where the opt-in boundary is"). A profile back-filled
// here can afterwards opt back out like anyone else, and this migration will not
// silently re-opt them in, because it has already run.
//
// The value is "on" only so the settings table reads sensibly; PRESENCE is the whole
// signal, and opting out DELETES the row. `INSERT OR IGNORE` because a profile could
// in principle already hold the key.
//
// Nullable-signal safe: a profile with no rated set is left exactly as it was, which
// is the correct answer for someone who never engaged the control.
//
// Determinism: reads only the DB.
export function up(db: Database.Database): void {
  db.prepare(
    `INSERT OR IGNORE INTO profile_settings (profile_id, key, value)
       SELECT DISTINCT a.profile_id, 'strength_rpe', 'on'
         FROM exercise_sets s
         JOIN activities a ON a.id = s.activity_id
        WHERE s.rpe IS NOT NULL`
  ).run();
}

export const migration: Migration = {
  name: "20260820-rpe-column-opt-in",
  up,
};
