// Scheduled-appointment reads (issue #213, Phase 2). Profile-scoped: every
// statement filters profile_id. The provider name is resolved through a
// correlated subquery into the shared, GLOBAL providers registry (the same
// pattern getMedicalRecords / getImmunizations use) so the FK link stays on the
// profile-owned appointments row while the provider row it points at is global.

import { db } from "../db";
import type { Appointment } from "../types";

// Column list + the joined provider_name, shared by both reads so they stay in
// lockstep. The subquery is NULL when provider_id is null (an unlinked visit).
const SELECT_COLS = `
  id, profile_id, scheduled_at, provider_id,
  (SELECT p.name FROM providers p WHERE p.id = appointments.provider_id)
    AS provider_name,
  title, location, notes, status, created_at`;

// Every appointment for a profile, soonest first. Used by the management page.
export function getAppointments(profileId: number): Appointment[] {
  return db
    .prepare(
      `SELECT ${SELECT_COLS} FROM appointments
       WHERE profile_id = ?
       ORDER BY scheduled_at ASC, id ASC`
    )
    .all(profileId) as Appointment[];
}

// Only the still-scheduled appointments (completed/cancelled drop off), soonest
// first — the forward-looking set the Upcoming aggregation bands. A past-and-
// still-scheduled row is included on purpose so it can surface as Overdue.
export function getScheduledAppointments(profileId: number): Appointment[] {
  return db
    .prepare(
      `SELECT ${SELECT_COLS} FROM appointments
       WHERE profile_id = ? AND status = 'scheduled'
       ORDER BY scheduled_at ASC, id ASC`
    )
    .all(profileId) as Appointment[];
}
