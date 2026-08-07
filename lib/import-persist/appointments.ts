import { matchAppointmentForEncounter } from "../appointment-encounter-match";
import { completeScheduledAndLinkEncounterTx } from "../appointment-status";
import { db, writeTx } from "../db";
import { satisfiedRuleForCompletedKind } from "../preventive-appointment";
import { recordPreventiveDone } from "../queries";
import { readAllForUpdate } from "../tx";

// Close the appointment → encounter loop for encounters produced by one import.
// The caller runs this inside the import transaction, after encounter insertion;
// the writeTx here nests as a SAVEPOINT and exists to mint the Tx token the
// status core's CAS requires (#2134) — the candidate read and the swap provably
// share the transaction.
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
    `SELECT id, date, time_of_day AS timeOfDay, provider_id AS providerId,
            status, encounter_id AS encounterId, kind
       FROM appointments
      WHERE profile_id = ? AND status = 'scheduled' AND encounter_id IS NULL`
  );

  writeTx((tx) => {
    for (const encounter of encounters) {
      const candidates = readAllForUpdate<{
        id: number;
        date: string;
        timeOfDay: string | null;
        providerId: number | null;
        status: string;
        encounterId: number | null;
        kind: string | null;
      }>(tx, readScheduled, profileId);
      const matchId = matchAppointmentForEncounter(
        { date: encounter.date, providerId: encounter.providerId },
        candidates
      );
      if (matchId == null) continue;

      // The core's CAS re-states the candidate guard (scheduled + unlinked) in the
      // WHERE; `stale` cannot happen here (the read shares the transaction) but is
      // treated as "skip", never as a claim of completion.
      const swap = completeScheduledAndLinkEncounterTx(
        tx,
        profileId,
        matchId,
        encounter.id
      );
      if (swap.kind !== "applied") continue;
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
  });
}
