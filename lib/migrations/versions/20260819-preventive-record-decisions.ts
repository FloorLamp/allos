import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Issue #3025 — the durable preventive review-decision store.
//
// A valueless imported REPORT (a Pap cytology, a mammogram read) whose title
// matches exactly one screening rule offers a review-and-confirm candidate;
// prose never changes due status on its own (owner ruling, 2026-08-18). This
// table is the PERSON's answer, one row per (profile, record, rule):
//
//   decision = 'confirmed' — "yes, this record shows the screening was
//     completed", with the date the person confirmed (prefilled from the record
//     date, editable before writing). A confirmed row is the EXPLICIT LINK
//     between the record and the rule: it projects into the same
//     PreventiveSatisfaction stream the manual and inferred events feed
//     (lib/queries/upcoming/preventive.ts) and is deliberately NOT duplicated
//     into preventive_events — the link would be lost and the record's deletion
//     could no longer retract it.
//   decision = 'dismissed' — "this candidate is answered, stop offering it".
//     It suppresses ONLY this record/rule candidate; it asserts nothing about
//     whether the screening happened and never suppresses the preventive item.
//
// The UNIQUE key makes reconfirming idempotent (an upsert moves the date on the
// one row). The record FK cascades: deleting the source record deletes the
// decision, so a confirmation cannot outlive the evidence it points at.
// `confirmed_date` is a profile-local day (YYYY-MM-DD), required exactly for
// confirmed rows — the CHECK makes that a schema fact rather than a convention.
export function up(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS preventive_record_decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id INTEGER NOT NULL REFERENCES profiles(id),
      medical_record_id INTEGER NOT NULL
        REFERENCES medical_records(id) ON DELETE CASCADE,
      rule_key TEXT NOT NULL,
      decision TEXT NOT NULL CHECK (decision IN ('confirmed','dismissed')),
      confirmed_date TEXT
        CHECK ((decision = 'confirmed') = (confirmed_date IS NOT NULL)),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (profile_id, medical_record_id, rule_key)
    )
  `);
  // The cascade's reverse lookup: deleting a medical record must not scan.
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_preventive_record_decisions_record
       ON preventive_record_decisions(medical_record_id)`
  );
}

export const migration: Migration = {
  name: "20260819-preventive-record-decisions",
  up,
};
