import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 026 (issue #288): the appointment → encounter lifecycle link.
//
// Appointments (future, scheduling) and encounters (past, clinical) are one
// continuum, but the lifecycle seam dropped on the floor: completing an
// appointment set status='completed' and nothing else — no encounter was created
// and no link existed in either direction. This adds the missing back-link so
// "Log this visit" (completing an appointment prefills a linked encounter) and the
// import auto-complete (a synced encounter matching a still-scheduled appointment
// marks it completed + links it) have somewhere to record the connection.
//
//   - encounter_id INTEGER REFERENCES encounters(id) — nullable, the appointment
//     side of the link (the appointment is the child that points at its resulting
//     visit). No ON DELETE action per house style: deleting the encounter NULLS
//     this link first (row-ops convention — see deleteEncounter and the import
//     footprint clear/move), never cascade-drops the appointment.
//
// UNLIKE migration 024 (which REBUILT appointments to attach a FK to what would
// have been a bare column), this is a plain ADD COLUMN: SQLite permits a REFERENCES
// clause on a BRAND-NEW column as long as its default is NULL (which a nullable
// column has), so no create→copy→drop→rename dance is needed. The runner applies
// every migration with foreign_keys disabled and restores it after, so even the
// FK-bearing add is validated only against future writes.
//
// REPLAY SAFETY: the non-version-gated migrate() wrapper replays every up()
// unconditionally, so this is guarded — skipped once appointments already has an
// encounter_id column. Production applies it exactly once behind the user_version
// gate. Determinism: reads only the DB catalog.

function columnNames(db: Database.Database, table: string): string[] {
  return (
    db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
  ).map((r) => r.name);
}

export function up(db: Database.Database): void {
  const cols = columnNames(db, "appointments");
  // Table absent (shouldn't happen after baseline) or already linked → no-op.
  if (cols.length === 0 || cols.includes("encounter_id")) return;
  db.exec(
    `ALTER TABLE appointments
       ADD COLUMN encounter_id INTEGER REFERENCES encounters(id);`
  );
}

export const migration: Migration = {
  id: 26,
  name: "026-appointment-encounter-link",
  up,
};
