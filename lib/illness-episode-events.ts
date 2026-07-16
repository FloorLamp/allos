// In-range clinical-event association for an illness episode (issue #856 items 7-8).
// DERIVED, no FKs (the episode-association discipline): everything that happened inside
// the episode's [from, to] window — encounters/visits, appointments, medication COURSES
// started in-range, and documents/labs dated in-range — is gathered by date, so an
// edited/retro episode's associations are automatically correct.
//
// Deliberately SEPARATE from assembleIllnessEpisode (not folded into AssembledEpisode):
// the assembly feeds the PUBLIC /share render, and visits/appointments/documents are
// more than a caregiver should hand out with a read-only illness link. This gather runs
// only on the AUTHED episode page. The date range still comes from the ONE assembly, so
// there is no second range engine. profileId-first, auth-blind, every statement scoped.

import { db } from "./db";

export interface EpisodeEncounterRef {
  id: number;
  date: string;
  type: string | null;
  reason: string | null;
}
export interface EpisodeAppointmentRef {
  id: number;
  scheduledAt: string;
  title: string | null;
}
export interface EpisodeCourseRef {
  id: number;
  itemId: number;
  name: string;
  startedOn: string;
}
export interface EpisodeDocumentRef {
  id: number;
  filename: string;
  docType: string | null;
  date: string;
}

export interface EpisodeInRangeEvents {
  encounters: EpisodeEncounterRef[];
  appointments: EpisodeAppointmentRef[];
  courses: EpisodeCourseRef[];
  documents: EpisodeDocumentRef[];
  total: number;
}

const EMPTY: EpisodeInRangeEvents = {
  encounters: [],
  appointments: [],
  courses: [],
  documents: [],
  total: 0,
};

// Gather the clinical events whose date falls inside [from, to] (inclusive). `from`/`to`
// are the assembled episode's firstDay / lastActiveDay; a null bound yields no events
// (an unknown-start before-log episode has no concrete window to associate against).
export function getEpisodeInRangeEvents(
  profileId: number,
  from: string | null,
  to: string | null
): EpisodeInRangeEvents {
  if (!from || !to) return EMPTY;

  const encounters = db
    .prepare(
      `SELECT id, date, type, reason FROM encounters
        WHERE profile_id = ? AND date >= ? AND date <= ?
        ORDER BY date ASC, id ASC`
    )
    .all(profileId, from, to) as EpisodeEncounterRef[];

  const appointments = db
    .prepare(
      `SELECT id, scheduled_at AS scheduledAt, title FROM appointments
        WHERE profile_id = ? AND date(scheduled_at) >= ? AND date(scheduled_at) <= ?
        ORDER BY scheduled_at ASC, id ASC`
    )
    .all(profileId, from, to) as EpisodeAppointmentRef[];

  // Medication courses reach profile_id through their intake_items parent (no profile_id
  // of their own); a course "started in-range" is the antibiotic the visit produced.
  const courses = db
    .prepare(
      `SELECT mc.id AS id, mc.item_id AS itemId, ii.name AS name,
              mc.started_on AS startedOn
         FROM medication_courses mc
         JOIN intake_items ii ON ii.id = mc.item_id
        WHERE ii.profile_id = ? AND mc.started_on IS NOT NULL
          AND mc.started_on >= ? AND mc.started_on <= ?
        ORDER BY mc.started_on ASC, mc.id ASC`
    )
    .all(profileId, from, to) as EpisodeCourseRef[];

  // Documents/labs: use the clinical document_date when present, else the uploaded date.
  const documents = db
    .prepare(
      `SELECT id, filename, doc_type AS docType,
              COALESCE(document_date, date(uploaded_at)) AS date
         FROM medical_documents
        WHERE profile_id = ?
          AND COALESCE(document_date, date(uploaded_at)) >= ?
          AND COALESCE(document_date, date(uploaded_at)) <= ?
        ORDER BY date ASC, id ASC`
    )
    .all(profileId, from, to) as EpisodeDocumentRef[];

  return {
    encounters,
    appointments,
    courses,
    documents,
    total:
      encounters.length +
      appointments.length +
      courses.length +
      documents.length,
  };
}

// The reverse direction (item 7-8): the episode that CONTAINS a clinical event's date,
// for a "during illness episode" chip on the encounter/condition detail linking back.
// A thin wrapper over the row resolver so detail pages don't import the store directly.
export { episodeForProfileDate } from "./illness-episode";
