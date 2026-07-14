import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 034 (issue #684): persist the reading's LOINC on medical_records.
//
// The observation/FHIR importers already resolve a LOINC per reading and use it at
// import time (canonical routing, height/head-circ projection), but it was never
// STORED — so the qualitative flag reconcile (computeQualitativeFlagChanges), which
// reads back from the DB, had only the analyte NAME to classify by. That forced
// classifyQualitativeResult onto fragile name regexes (#549). This column lets the
// reconcile pass the stored LOINC to the classifier's deterministic class hint
// (qualitativeClassForLoinc). Legacy rows stay NULL → name-based fallback, unchanged.
//
// Pure additive DDL: an ADD COLUMN guarded on PRAGMA table_info, so a fresh DB and an
// already-converged one both end identical and the non-version-gated migrate() wrapper
// replays it as a no-op. Determinism (spec): reads only the DB + its own constants.

function columnNames(db: Database.Database, table: string): Set<string> {
  return new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
      (r) => r.name
    )
  );
}

export function up(db: Database.Database): void {
  if (!columnNames(db, "medical_records").has("loinc")) {
    db.exec(`ALTER TABLE medical_records ADD COLUMN loinc TEXT;`);
  }
}

export const migration: Migration = {
  id: 34,
  name: "034-medical-record-loinc",
  up,
};
