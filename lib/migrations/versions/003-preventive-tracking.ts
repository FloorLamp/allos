import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 003 (issue #82): storage for the user-facing preventive-care slice —
// surfacing due/overdue well-visits and screenings in Upcoming, with a manual
// "mark done" and declined / not-applicable overrides.
//
// Two new profile-owned tables, both mirroring `immunization_overrides`'s shape
// so the preventive machinery reads like the immunization one:
//
//   • preventive_events   — the completion SATISFACTION stream feeding the pure
//     assessor (`lib/preventive-status.ts`). One row per "mark done": a rule was
//     satisfied on `date` (a completed visit, or a screening result). `source`
//     is 'manual' for now; a later record-inference pass (a separate issue) will
//     write into this SAME stream with a different source, so nothing here is
//     manual-only. A UNIQUE(profile_id, rule_key, date, source) keeps a repeated
//     mark-done on one day idempotent.
//   • preventive_overrides — one row per rule the profile has opted out of:
//     'declined' (an informed opt-out) or 'not_applicable' (doubles as the
//     anatomy escape hatch, e.g. cervical screening post-hysterectomy, without
//     new demographic modeling). UNIQUE(profile_id, rule_key) so re-setting flips
//     the kind, exactly like immunization_overrides.
//
// Both `rule_key`s reference the stable catalog keys in lib/preventive-catalog.ts
// (never renumbered). Born with `profile_id INTEGER NOT NULL` — every read filters
// it (profile-scoping test) and deleteProfile clears both by profile_id, so both
// are registered in lib/owned-tables.ts.
//
// Replay-safe by construction (CREATE TABLE / INDEX ... IF NOT EXISTS) so the
// non-version-gated `migrate()` test wrapper can re-run it; production applies it
// exactly once behind the user_version gate.

export function up(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS preventive_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id INTEGER NOT NULL REFERENCES profiles(id),
      rule_key TEXT NOT NULL,
      date TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'manual',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(profile_id, rule_key, date, source)
    );
    CREATE INDEX IF NOT EXISTS idx_preventive_events_profile
      ON preventive_events(profile_id, rule_key, date);

    CREATE TABLE IF NOT EXISTS preventive_overrides (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id INTEGER NOT NULL REFERENCES profiles(id),
      rule_key TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('declined','not_applicable')),
      note TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(profile_id, rule_key)
    );
  `);
}

export const migration: Migration = {
  id: 3,
  name: "003-preventive-tracking",
  up,
};
