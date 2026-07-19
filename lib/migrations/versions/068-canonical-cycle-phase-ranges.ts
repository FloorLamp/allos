import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 068 (issue #718): cycle-phase-aware reference ranges. Adds the
// `ranges_by_cycle_phase` JSON column to canonical_biomarkers — the phase-keyed
// reference overrides (follicular / luteal) for the phase-dependent reproductive
// hormones (FSH, LH, estradiol, progesterone). It parallels `ranges_by_status`
// (migration in baseline) exactly: a JSON object the boot-time seed populates from
// the committed canonical dataset and lib/reference-range.selectCyclePhaseRange reads.
//
// When the profile logs a menstrual cycle (#714, the phase-on-date feed
// lib/cycle.cyclePhaseOnDate), the flag reconcile derives each hormone record's cycle
// phase from its OWN collection date and picks the matching phase range — ABOVE the
// coarse reproductive-status proxy — so a mid-luteal progesterone reads its luteal
// range instead of false-flagging "high" against the follicular/coarse range. With no
// cycle log the column stays inert and behavior is byte-identical to before. The
// FLAG_LOGIC_VERSION bump (v8) + the new field in FLAG_RELEVANT_FIELDS make the
// boot-time reconcileFlagsIfCanonicalChanged re-derive the affected profiles' hormone
// flags once (a no-op for profiles with no cycle data).
//
// Guarded ADD COLUMN (idempotent) so the non-version-gated migrate() test wrapper can
// replay the whole migration list without hitting "duplicate column name"; production
// runs it exactly once (the user_version gate). Determinism (spec): reads only the DB
// + its own constants.

function columnNames(db: Database.Database, table: string): Set<string> {
  return new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
      (r) => r.name
    )
  );
}

export function up(db: Database.Database): void {
  if (!columnNames(db, "canonical_biomarkers").has("ranges_by_cycle_phase")) {
    db.exec(
      `ALTER TABLE canonical_biomarkers ADD COLUMN ranges_by_cycle_phase TEXT;`
    );
  }
}

export const migration: Migration = {
  id: 68,
  name: "068-canonical-cycle-phase-ranges",
  up,
};
