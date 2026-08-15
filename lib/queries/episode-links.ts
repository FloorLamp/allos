// Reverse links for the illness episode's derived clinical-event associations
// (#856 items 7-8). The episode detail gathers appointments, medication courses,
// and documents by its inclusive [start, end] window; these readers answer the
// inverse question on each source surface from the SAME stored facts. Promoted
// conditions use their stronger stable external-id link instead of date inference.
//
// An open episode ends at the profile-local `asOf` day for this purpose. It does
// not claim a future appointment merely because end_date is NULL. An unknown-start
// episode contributes no in-range clinical events on the detail page, so the reverse
// readers exclude it too. These are presentation links only: no new FK or ownership.

import { hoistedStatement, today } from "../db";

export interface EpisodeLinkRef {
  id: number;
  situation: string;
  start_date: string | null;
  end_date: string | null;
}

type KeyedEpisodeLink = EpisodeLinkRef & { subjectId: number };

function groupBySubject(
  rows: KeyedEpisodeLink[]
): Record<number, EpisodeLinkRef[]> {
  const out: Record<number, EpisodeLinkRef[]> = {};
  for (const { subjectId, ...episode } of rows) {
    (out[subjectId] ??= []).push(episode);
  }
  return out;
}

const APPOINTMENT_EPISODES_STMT = hoistedStatement(
  `SELECT a.id AS subjectId, ie.id, ie.situation, ie.start_date, ie.end_date
     FROM appointments a
     JOIN illness_episodes ie ON ie.profile_id = a.profile_id
      AND ie.start_date IS NOT NULL
      AND ie.start_date <= a.date
      AND COALESCE(ie.end_date, ?) >= a.date
    WHERE a.profile_id = ?
    ORDER BY a.id, ie.start_date, ie.id`
);

// Every episode whose detail timeline includes each appointment. Batch-shaped for
// the Visits list: one profile read, never an episode query per row.
export function episodesForAppointments(
  profileId: number
): Record<number, EpisodeLinkRef[]> {
  return groupBySubject(
    APPOINTMENT_EPISODES_STMT.all(
      today(profileId),
      profileId
    ) as KeyedEpisodeLink[]
  );
}

const MEDICATION_EPISODES_STMT = hoistedStatement(
  `SELECT DISTINCT ie.id, ie.situation, ie.start_date, ie.end_date
     FROM intake_items ii
     JOIN medication_courses mc ON mc.item_id = ii.id
     JOIN illness_episodes ie ON ie.profile_id = ii.profile_id
      AND ie.start_date IS NOT NULL
      AND ie.start_date <= mc.started_on
      AND COALESCE(ie.end_date, ?) >= mc.started_on
    WHERE ii.id = ? AND ii.profile_id = ? AND mc.started_on IS NOT NULL
    ORDER BY ie.start_date, ie.id`
);

// A medication may have several courses and therefore several episode links. DISTINCT
// keeps two starts inside one episode from rendering the same episode twice.
export function episodesForMedication(
  profileId: number,
  itemId: number
): EpisodeLinkRef[] {
  return MEDICATION_EPISODES_STMT.all(
    today(profileId),
    itemId,
    profileId
  ) as EpisodeLinkRef[];
}

const DOCUMENT_EPISODES_STMT = hoistedStatement(
  `SELECT ie.id, ie.situation, ie.start_date, ie.end_date
     FROM medical_documents d
     JOIN illness_episodes ie ON ie.profile_id = d.profile_id
      AND ie.start_date IS NOT NULL
      AND ie.start_date <= COALESCE(d.document_date, date(d.uploaded_at))
      AND COALESCE(ie.end_date, ?) >= COALESCE(d.document_date, date(d.uploaded_at))
    WHERE d.id = ? AND d.profile_id = ?
    ORDER BY ie.start_date, ie.id`
);

export function episodesForDocument(
  profileId: number,
  documentId: number
): EpisodeLinkRef[] {
  return DOCUMENT_EPISODES_STMT.all(
    today(profileId),
    documentId,
    profileId
  ) as EpisodeLinkRef[];
}

const PROMOTED_CONDITION_EPISODES_STMT = hoistedStatement(
  `SELECT c.id AS subjectId, ie.id, ie.situation, ie.start_date, ie.end_date
     FROM conditions c
     JOIN illness_episodes ie ON ie.profile_id = c.profile_id
      AND c.external_id = 'illness-episode:' || ie.id
    WHERE c.profile_id = ? AND c.source = 'episode'
    ORDER BY c.id, ie.id`
);

// The condition was explicitly promoted from this stable episode id. Dates may have
// been hand-edited under the condition edit lock, so deriving this link by overlap
// would be both weaker and wrong.
export function episodesForPromotedConditions(
  profileId: number
): Record<number, EpisodeLinkRef[]> {
  return groupBySubject(
    PROMOTED_CONDITION_EPISODES_STMT.all(profileId) as KeyedEpisodeLink[]
  );
}
