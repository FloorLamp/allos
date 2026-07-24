// Scheduled-appointment reads. Profile-scoped: every
// statement filters profile_id. The provider name is resolved through a
// correlated subquery into the shared, GLOBAL providers registry (the same
// pattern getMedicalRecords / getImmunizations use) so the FK link stays on the
// profile-owned appointments row while the provider row it points at is global.

import { db } from "../db";
import type { Appointment } from "../types";
import type { KindedAppointment } from "../preventive-appointment";

// Column list + the joined provider_name, shared by both reads so they stay in
// lockstep. The subquery is NULL when provider_id is null (an unlinked visit).
const SELECT_COLS = `
  id, profile_id, scheduled_at, provider_id,
  (SELECT p.name FROM providers p WHERE p.id = appointments.provider_id)
    AS provider_name,
  title, location, notes, status, kind, encounter_id, created_at`;

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

// The appointment that was scheduled for THIS encounter (#288 completed→linked, or
// the import-time appointment↔encounter match) — the visit's scheduling origin, for
// the encounter page's provenance chain ("Scheduled Jun 10 → attended Jun 18",
// #1350). Profile-scoped; null when the visit had no booked appointment. Newest
// booking wins if several ever linked (they shouldn't).
export function appointmentForEncounter(
  profileId: number,
  encounterId: number
): Appointment | null {
  return (
    (db
      .prepare(
        `SELECT ${SELECT_COLS} FROM appointments
         WHERE profile_id = ? AND encounter_id = ?
         ORDER BY scheduled_at DESC, id DESC LIMIT 1`
      )
      .get(profileId, encounterId) as Appointment | undefined) ?? null
  );
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

// A profile's still-scheduled appointments reduced to the shape the pure
// scheduled-match (scheduledMatchForRule) uses — kind + date + status. Profile-
// scoped via getScheduledAppointments. Shared by the Upcoming builder (to quiet a
// due preventive item that already has a matching-kind visit booked, issue #85) AND
// the preventive nudge (issue #183) so the page and the push never diverge on which
// items are covered.
export function kindedScheduled(profileId: number): KindedAppointment[] {
  return getScheduledAppointments(profileId).map((a) => ({
    kind: a.kind,
    scheduledAt: a.scheduled_at,
    status: a.status,
  }));
}
