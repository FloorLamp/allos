import { matchAppointmentForEncounter } from "../appointment-encounter-match";
import { db } from "../db";
import { satisfiedRuleForCompletedKind } from "../preventive-appointment";
import { recordPreventiveDone } from "../queries";

// Close the appointment → encounter loop for encounters produced by one import.
// The caller runs this inside the import transaction, after encounter insertion.
export function autoCompleteAppointmentsFromEncounters(
  profileId: number,
  docId: number
): void {
  const encounters = db
    .prepare(
      `SELECT id, date, provider_id AS providerId
         FROM encounters
        WHERE profile_id = ? AND document_id = ?`
    )
    .all(profileId, docId) as {
    id: number;
    date: string;
    providerId: number | null;
  }[];
  if (encounters.length === 0) return;

  const readScheduled = db.prepare(
    `SELECT id, scheduled_at AS scheduledAt, provider_id AS providerId,
            status, encounter_id AS encounterId, kind
       FROM appointments
      WHERE profile_id = ? AND status = 'scheduled' AND encounter_id IS NULL`
  );
  const completeAndLink = db.prepare(
    `UPDATE appointments
        SET status = 'completed', encounter_id = ?
      WHERE id = ? AND profile_id = ? AND status = 'scheduled'
        AND encounter_id IS NULL`
  );

  for (const encounter of encounters) {
    const candidates = readScheduled.all(profileId) as {
      id: number;
      scheduledAt: string;
      providerId: number | null;
      status: string;
      encounterId: number | null;
      kind: string | null;
    }[];
    const matchId = matchAppointmentForEncounter(
      { date: encounter.date, providerId: encounter.providerId },
      candidates
    );
    if (matchId == null) continue;

    completeAndLink.run(encounter.id, matchId, profileId);
    const matched = candidates.find((candidate) => candidate.id === matchId);
    const ruleKey = satisfiedRuleForCompletedKind(matched?.kind ?? null);
    if (ruleKey) {
      recordPreventiveDone(
        profileId,
        ruleKey,
        encounter.date.slice(0, 10),
        "appointment"
      );
    }
  }
}
