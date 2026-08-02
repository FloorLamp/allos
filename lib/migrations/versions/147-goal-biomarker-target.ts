import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 147 (issue #1853): let a goal TARGET A BIOMARKER — "LDL under 100 by
// June", "A1c below 7", "BP systolic under 120".
//
// Before this, the only measurable goal targets were three body metrics
// (`goals.body_metric`) and exercise lifts. Everything else — every lab value, and
// every vital that is stored as a biomarker reading (blood pressure, SpO2,
// respiratory rate, body temperature) — could only be typed as freeform text, so a
// portal-imported "A1c below 7" landed as inert prose beside the A1c series,
// reference ranges and retest cadence that describe exactly that number.
//
// TWO nullable columns, nothing else — the rest of the target is columns the goals
// table already has, deliberately:
//   • `target_value`   — the number, as body goals already store it.
//   • `unit`           — the unit the number is expressed in. A biomarker target is
//                        meaningless without it (mg/dL vs mmol/L differ by ~39×), and
//                        `unit` is the column freeform goals already use for exactly
//                        this. The write path resolves it through the SAME canonical
//                        unit the biomarker chart plots in, so target and series are
//                        always comparable or explicitly flagged as not.
//   • `target_date`    — the deadline, as every goal already has.
//   • `baseline_value` — the reading at creation, as body goals already capture.
//
//   1. `biomarker_name` — the canonical analyte name the goal targets. This is a
//      DISPLAY/anchor name, not the matching key: readings reach the goal through
//      the #482 FAMILY identity (`biomarkerFamily`, via getBiomarkerSeries), so a
//      goal anchored on "Hemoglobin A1c" is advanced by an eAG re-expression of the
//      same draw. Storing the picked name rather than the family key keeps the goal
//      labelled the way the user chose it (#482: family is how facts REACH a row, it
//      is not what a row IS), and re-deriving the family at read means a later
//      widening of a family reaches already-stored goals with no backfill.
//   2. `target_direction` — 'below' or 'above'. USER-DECLARED, never inferred: "LDL
//      under 100" and "Vitamin D above 100" are different goals with the same number,
//      and a baseline can be missing (a goal set before the first draw), so direction
//      cannot be recovered from baseline-vs-target. It is what makes "met" decidable.
//
// NO cached verdict column. Progress, pace and the off-pace verdict are recomputed
// from the stored evidence on every read (the repo's evidence-stored/verdict-
// recomputed rule), so a new lab result changes the answer without a write.
//
// NO REBUILD. Both columns are new and nullable, and SQLite permits a CHECK on
// ADD COLUMN as long as the (implicit NULL) default satisfies it — the posture
// migrations 008/040/043 already ship. The CHECK is written `IS NULL OR ... IN (...)`
// so every one of the ~N existing goal rows, which keep NULL, stays legal; nothing is
// backfilled and every stored goal keeps its exact current behavior.
//
// `goals` is already profile-owned (lib/owned-tables.ts) — a column is not a table.
//
// Guarded ADD COLUMN + CREATE INDEX IF NOT EXISTS keep a replay a pure no-op.
// Determinism: reads only the DB.

function columnNames(db: Database.Database, table: string): Set<string> {
  return new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
      (r) => r.name
    )
  );
}

export function up(db: Database.Database): void {
  const cols = columnNames(db, "goals");
  if (!cols.has("biomarker_name")) {
    db.exec(`ALTER TABLE goals ADD COLUMN biomarker_name TEXT`);
  }
  if (!cols.has("target_direction")) {
    db.exec(
      `ALTER TABLE goals ADD COLUMN target_direction TEXT
         CHECK (target_direction IS NULL OR target_direction IN ('below','above'))`
    );
  }
  // The goal-side lookup is "does this profile have a live goal on this analyte?",
  // asked once per biomarker detail page render and once per goal-pacing pass.
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_goals_biomarker
      ON goals(profile_id, biomarker_name);
  `);
}

export const migration: Migration = {
  id: 147,
  name: "147-goal-biomarker-target",
  up,
};
