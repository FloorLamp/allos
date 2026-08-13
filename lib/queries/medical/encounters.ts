import { encounterTypeKey } from "../../encounter-kind";
import { db, hoistedStatement } from "../../db";
import { cache } from "../../request-cache";
import type { Encounter } from "../../types";
import { visitContext, type VisitContext } from "../../visit-context";
import {
  REPRESENTATIVE_SPECS,
  representativeIds,
} from "../../representative-ids";

// One row per visit across overlapping documents (#71) — the original of the
// collapse idiom the clinical lists later adopted. Emitted by the shared builder
// (lib/representative-ids.ts, #2035); the encounters registry row carries the
// identity (the source system's own encounter id when there is one, else the content
// tuple) and the manual-beats-imported preference axis. Takes ONE profile_id bind.
export const ENCOUNTER_REPRESENTATIVE_IDS = representativeIds(
  REPRESENTATIVE_SPECS.encounters
);

// cache() dedups the repeats within ONE request; hoisting (#2110) is the other half,
// and the household fan-out is why both are wanted — the strip asks a different
// profileId per member, so every member is a cache MISS and used to recompile this
// join from scratch. Statement cached per connection, value still per request.
const ENCOUNTERS_STMT = hoistedStatement(
  `SELECT e.id, e.date, e.end_date, e.type, e.code, e.code_system,
          e.class_code, e.reason,
          e.diagnoses, e.diagnosis_ranks,
          e.provider_id, p.name AS provider_name,
          e.location_provider_id, l.name AS location_name,
          l.address AS location_address,
          e.notes, e.source, e.document_id, e.external_id, e.created_at
     FROM encounters e
     LEFT JOIN providers p ON p.id = e.provider_id
     LEFT JOIN providers l ON l.id = e.location_provider_id
    WHERE e.profile_id = ? AND e.id IN (${ENCOUNTER_REPRESENTATIVE_IDS})
    ORDER BY e.date DESC, e.id DESC`
);

export const getEncounters = cache(function getEncounters(
  profileId: number
): Encounter[] {
  return ENCOUNTERS_STMT.all(profileId, profileId) as Encounter[];
});

export function getEncounter(profileId: number, id: number): Encounter | null {
  return (
    (db
      .prepare(
        `SELECT e.id, e.date, e.end_date, e.type, e.code, e.code_system,
                e.class_code, e.reason,
                e.diagnoses, e.diagnosis_ranks,
                e.provider_id, p.name AS provider_name,
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
