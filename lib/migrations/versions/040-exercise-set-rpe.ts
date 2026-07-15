import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 040 (issue #743): a nullable `rpe` on exercise_sets.
//
// RPE (Rate of Perceived Exertion) on the RIR-anchored 5–10 scale is an OPTIONAL
// effort rating logged per set. It COMPOSES with the existing declared intent
// (`target_reps` / `to_failure` on the same row) rather than replacing it — a set
// can carry a rep target AND an RPE. When the anchor set of a session carries one,
// the double-progression engine (lib/coaching/strength.ts) reads it as a MODIFIER
// on its verdicts (top-of-range at RPE ≤ 7 ⇒ a bigger jump; RPE ≥ 9.5 below the
// range floor ⇒ hold/deload). Absent RPE ⇒ byte-for-byte the pre-RPE behavior —
// the nullable-signal invariant, so this column is a pure no-op on existing data.
//
// The CHECK only bounds the value to the 5–10 scale (and admits NULL). The
// HALF-POINT step discipline (5, 5.5, …, 10) is enforced at the ACTION boundary
// (lib/rpe.ts `canonicalRpe`, called by the set-save write path) rather than in
// the CHECK, so an off-step value is snapped/rejected there instead of throwing a
// raw constraint error at the writer. Nullable with no default, so every existing
// / imported / legacy row simply carries NULL — no RPE — exactly as before.
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
  if (!columnNames(db, "exercise_sets").has("rpe")) {
    db.exec(
      `ALTER TABLE exercise_sets ADD COLUMN rpe REAL CHECK (rpe IS NULL OR (rpe >= 5 AND rpe <= 10));`
    );
  }
}

export const migration: Migration = {
  id: 40,
  name: "040-exercise-set-rpe",
  up,
};
