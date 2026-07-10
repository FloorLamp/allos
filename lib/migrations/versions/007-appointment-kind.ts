import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 007 (issue #85): a nullable `kind` category on appointments.
//
// A booked visit can now name WHAT it is — `well_child | physical | dental |
// vision | screening | other` — so a preventive-care reminder ends in an explicit
// booking rather than only being inferred from the title. The kind drives three
// things (all pure, in lib/preventive-appointment.ts): the prefilled "Book" CTA on
// each preventive Upcoming item, the FUTURE-scheduled "scheduled ✓" suppression
// that quiets a due item once a matching-kind visit is on the calendar, and the
// close-the-loop offer to record a preventive satisfaction when a matching-kind
// visit is completed.
//
// The column is OPTIONAL: existing rows stay NULL, nothing requires it, and a
// NULL kind never matches a rule (no fuzzy title guessing — that stays the job of
// the record-inference layer). The allowed values are validated at the write
// boundary (app/(app)/appointments/actions.ts) against APPOINTMENT_KINDS rather
// than by a column CHECK, so growing the enum later needs no rebuild migration.
//
// Replay-safe by construction: the ADD COLUMN is guarded on PRAGMA table_info so
// the non-version-gated `migrate()` test wrapper (which replays every migration)
// doesn't hit "duplicate column name"; production applies it exactly once behind
// the user_version gate. Determinism: reads only the DB + its own constants. Runs
// AFTER migration 006 (issue #95) rebuilds the appointments table for its
// provider_id FK — this migration makes no assumption about that CREATE sql, it
// simply adds `kind` to whatever appointments table exists at this version.

function columnNames(db: Database.Database, table: string): Set<string> {
  return new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
      (r) => r.name
    )
  );
}

export function up(db: Database.Database): void {
  if (!columnNames(db, "appointments").has("kind")) {
    db.exec(`ALTER TABLE appointments ADD COLUMN kind TEXT;`);
  }
}

export const migration: Migration = {
  id: 7,
  name: "007-appointment-kind",
  up,
};
