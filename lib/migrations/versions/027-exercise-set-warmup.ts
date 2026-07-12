import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 027 (issue #338): a `warmup` flag on exercise_sets.
//
// No warmup concept existed anywhere — every rep-bearing set was a working set, so
// a light warmup single polluted the part's volume total and, under a target,
// read as a missed set on the journal card. This adds an explicit per-set flag so
// warmups can be excluded from the working-set semantics.
//
// COUNTING DECISION (documented — see the query/format layers that honour it): a
// warmup-flagged set is a NON-WORKING set. It is stored and still SHOWN (so it
// round-trips on edit and appears in the set list / journal card text), but it is
// INERT to every derived metric:
//   - target judgment (judgeTargets → card + editor "below target" markers),
//   - volume / tonnage (partTotal, summarizeExercise.totalKg, getVolumeByDate,
//     the exercise-comparison volume, and per-set counts),
//   - strength records & best-set stats (getStrengthByExercise's e1RM / best /
//     top weight — so lastSessionPR's e1RM and weight PRs both EXCLUDE a warmup:
//     a heavy single flagged warmup is not a PR, matching working-set semantics),
//   - the plateau e1RM series (getExerciseE1rmSeries),
//   - the next-set progression seed (sessionBestSet anchor + sessionWorkSets).
//
// NOT NULL DEFAULT 0, so every existing/imported/legacy row is a working set
// exactly as before — the change is a pure no-op on current data and only affects
// sets a user hand-flags going forward. Imported sets have no warmup info, so they
// stay 0 and the #330 load-based working-set approximation remains the fallback
// for import-only histories that predate the flag.
//
// The ADD COLUMN is guarded on PRAGMA table_info so the non-version-gated
// `migrate()` test wrapper (which replays every migration) can't hit "duplicate
// column name"; production applies it once behind the user_version gate.
// Determinism: reads only the DB.

function columnNames(db: Database.Database, table: string): Set<string> {
  return new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
      (r) => r.name
    )
  );
}

export function up(db: Database.Database): void {
  if (!columnNames(db, "exercise_sets").has("warmup")) {
    db.exec(
      `ALTER TABLE exercise_sets ADD COLUMN warmup INTEGER NOT NULL DEFAULT 0;`
    );
  }
}

export const migration: Migration = {
  id: 27,
  name: "027-exercise-set-warmup",
  up,
};
