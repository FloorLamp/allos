import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// A place for the rank a source STATES about a visit diagnosis (#2589).
//
// `encounters.diagnoses` is a "; "-joined summary of display names, so a source
// system that says "this one is the primary diagnosis" has nowhere structured to
// put it. FHIR R4 says it as data — `Encounter.diagnosis.rank` (positiveInt,
// 1 = primary) and `.use` (the diagnosis-role CodeableConcept) — and the mapper
// read neither, so the fact was discarded at the door. This column is where it
// lands: a JSON array of `{ name, rank?, use? }`, keyed by the display name
// exactly as it appears in the summary (see lib/visit-diagnosis-rank.ts).
//
// PURELY ADDITIVE, AND DELIBERATELY SO. Two earlier attempts at #2589 rewrote
// stored diagnosis text at boot and were withdrawn: `"X - Primary"` and
// `"Hyperparathyroidism - Secondary"` are the same string shape, so a rule that
// strips one strips the other, and it deleted a real diagnosis from a health
// record to prove it. Nothing here reads, rewrites, reorders or deletes an
// existing row. Every existing encounter — CDA-sourced, AI-extracted or typed by
// hand — keeps a NULL in the new column and renders exactly as it did before.
//
// Nothing backfills it either, and nothing can: C-CDA R2.1's Encounter Diagnosis
// act (2.16.840.1.113883.10.20.22.4.80) defines no rank element, which is why
// Epic welded the word into the displayName in the first place. Only a re-import
// of a FHIR source fills this in.
export function up(db: Database.Database): void {
  const cols = db.prepare("PRAGMA table_info(encounters)").all() as {
    name: string;
  }[];
  if (!cols.some((c) => c.name === "diagnosis_ranks")) {
    db.exec(`ALTER TABLE encounters ADD COLUMN diagnosis_ranks TEXT`);
  }
}

export const migration: Migration = {
  name: "20260813-encounter-diagnosis-ranks",
  up,
};
