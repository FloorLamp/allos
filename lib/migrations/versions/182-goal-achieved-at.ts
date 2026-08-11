import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 182 (issue #2394): `goals.achieved_at TEXT` NULL — the instant a goal was
// marked achieved.
//
// WHY THE FIX HAS TO START AT THE SCHEMA. The weekly recap's "Goals reached" line
// windowed on `target_date` — when the goal was DUE — because that was the only date
// the table carried. `status` flipped to `achieved` and nothing recorded WHEN, so a
// goal reached early was announced in the week its deadline happened to fall (a month
// later), a goal reached late was never announced at all, and a goal with no deadline —
// which is every goal on the profile the issue was filed from — could not be announced
// under any circumstances. The filter could not be corrected without this column.
//
// WHAT IT MEANS: the instant `status` became `achieved`, in lib/date.ts's canonical
// `utcInstant` shape (`YYYY-MM-DDTHH:MM:SSZ`). It is a LIFECYCLE instant — a transition
// in the goal row's own life — not the moment the underlying performance happened, which
// the app does not observe. The recap attributes it to a profile-local day through
// `localDayOf`, the one instant→day path.
//
// BACKFILLED AS NULL, DELIBERATELY (the issue's decision 1). An existing achieved goal
// has no recorded achievement time, and inventing one — from `created_at`, from
// `target_date`, from the migration's own clock — would announce a goal reached months
// ago in the recap of whatever week this deploy lands in. NULL is the honest answer, and
// the line simply never mentions those goals. `getOutcomeGoals` returns the column, and
// the recap's reached-line requires a non-null value, so "achieved, time unknown" is
// silence rather than a retroactive announcement.
//
// NO DEFAULT, for the same reason 165 gave: a clock DEFAULT would stamp every goal at
// INSERT, which is a creation stamp wearing the achievement column's name. The single
// writer is `setStatus` (app/(app)/training/goal-actions.ts), which binds `instantNow()`
// on the flip to `achieved` and NULLs the column on a flip back to `active` — an
// un-achieved goal has not been achieved, and re-achieving it is a new event.
//
// DECLARED, NOT JUST ADDED. The column is registered in lib/time-columns.ts (semantic
// `lifecycle`, grain `instant`, convention `canonical`) and in
// `CANONICAL_INSTANT_COLUMNS` in lib/__tests__/instant-writer-scan.test.ts in this same
// change, so it is born on the convention rather than converted onto it later and the
// first writer is bound to lib/date.ts rather than to SQL's own bare-shaped clock.
//
// REPLAY-SAFE and determinate: it reads only the DB catalog and adds one nullable
// column, so a second application is a no-op and no row changes.

export function up(db: Database.Database): void {
  const cols = db.prepare(`PRAGMA table_info(goals)`).all() as {
    name: string;
  }[];
  // The DB test tier replays every migration over an at-rest database through the
  // non-version-gated migrate() wrapper, and SQLite has no `ADD COLUMN IF NOT EXISTS`.
  if (cols.some((c) => c.name === "achieved_at")) return;
  db.exec(`ALTER TABLE goals ADD COLUMN achieved_at TEXT`);
}

export const migration: Migration = {
  id: 182,
  name: "182-goal-achieved-at",
  up,
};
