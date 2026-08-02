import { encounterTypeKey } from "../../encounter-kind";
import { db } from "../../db";
import { cache } from "../../request-cache";
import type { Encounter } from "../../types";
import { visitContext, type VisitContext } from "../../visit-context";

export const ENCOUNTER_REPRESENTATIVE_IDS = `
  SELECT id FROM (
    SELECT id, ROW_NUMBER() OVER (
      PARTITION BY profile_id, COALESCE(
        CASE WHEN external_id IS NOT NULL
             THEN substr(external_id, instr(external_id, '|') + 1) END,
        date || '|' || COALESCE(end_date, '') || '|' || COALESCE(type, '')
             || '|' || COALESCE(class_code, '') || '|' || COALESCE(reason, '')
      )
      ORDER BY (document_id IS NULL) DESC, id DESC
    ) AS rn
    FROM encounters WHERE profile_id = ?
  ) WHERE rn = 1`;

export const getEncounters = cache(function getEncounters(
  profileId: number
): Encounter[] {
  return db
    .prepare(
      `SELECT e.id, e.date, e.end_date, e.type, e.code, e.code_system,
              e.class_code, e.reason,
              e.diagnoses, e.provider_id, p.name AS provider_name,
              e.location_provider_id, l.name AS location_name,
              l.address AS location_address,
              e.notes, e.source, e.document_id, e.external_id, e.created_at
         FROM encounters e
         LEFT JOIN providers p ON p.id = e.provider_id
         LEFT JOIN providers l ON l.id = e.location_provider_id
        WHERE e.profile_id = ? AND e.id IN (${ENCOUNTER_REPRESENTATIVE_IDS})
        ORDER BY e.date DESC, e.id DESC`
    )
    .all(profileId, profileId) as Encounter[];
});

export function getEncounter(profileId: number, id: number): Encounter | null {
  return (
    (db
      .prepare(
        `SELECT e.id, e.date, e.end_date, e.type, e.code, e.code_system,
                e.class_code, e.reason,
                e.diagnoses, e.provider_id, p.name AS provider_name,
                e.location_provider_id, l.name AS location_name,
                l.address AS location_address,
                e.notes, e.source, e.document_id, e.external_id, e.created_at
           FROM encounters e
           LEFT JOIN providers p ON p.id = e.provider_id
           LEFT JOIN providers l ON l.id = e.location_provider_id
          WHERE e.id = ? AND e.profile_id = ?`
      )
      .get(id, profileId) as Encounter | undefined) ?? null
  );
}

export function visitContextForEncounter(
  profileId: number,
  encounterId: number
): VisitContext | null {
  const current = getEncounter(profileId, encounterId);
  if (!current) return null;
  const typeKeyOf = (encounter: Encounter) =>
    encounterTypeKey(encounter.type, encounter.class_code);
  const others = getEncounters(profileId)
    .filter((encounter) => encounter.id !== encounterId)
    .map((encounter) => ({
      date: encounter.date,
      providerId: encounter.provider_id,
      typeKey: typeKeyOf(encounter),
    }));
  return visitContext(
    {
      date: current.date,
      providerId: current.provider_id,
      providerName: current.provider_name,
      typeKey: typeKeyOf(current),
    },
    others
  );
}
