import { db } from "./db";
import type { OnboardingDataPresence } from "./onboarding";

type StoredPresence = Omit<OnboardingDataPresence, "caregiving">;

// One bounded profile-scoped read for the onboarding checklist. The checks are
// intentionally broad: any real record in the selected domain counts as a first
// value, including data that existed before this login began orientation.
export function getOnboardingDataPresence(profileId: number): StoredPresence {
  const row = db
    .prepare(
      `SELECT
         (EXISTS(SELECT 1 FROM medical_records WHERE profile_id = @profileId) OR
          EXISTS(SELECT 1 FROM medical_documents WHERE profile_id = @profileId)) AS medicalRecords,
         EXISTS(SELECT 1 FROM intake_items
                 WHERE profile_id = @profileId AND kind = 'medication') AS medications,
         (EXISTS(SELECT 1 FROM activities WHERE profile_id = @profileId) OR
          EXISTS(SELECT 1 FROM goals WHERE profile_id = @profileId) OR
          EXISTS(SELECT 1 FROM frequency_targets WHERE profile_id = @profileId)) AS fitness,
         (EXISTS(SELECT 1 FROM body_metrics WHERE profile_id = @profileId) OR
          EXISTS(SELECT 1 FROM medical_records
                 WHERE profile_id = @profileId AND category IN ('lab','biomarker'))) AS metricsLabs,
         (EXISTS(SELECT 1 FROM appointments WHERE profile_id = @profileId) OR
          EXISTS(SELECT 1 FROM immunizations WHERE profile_id = @profileId) OR
          EXISTS(SELECT 1 FROM care_plan_items WHERE profile_id = @profileId)) AS preventiveCare`
    )
    .get({ profileId }) as Record<keyof StoredPresence, number>;

  return {
    medicalRecords: row.medicalRecords === 1,
    medications: row.medications === 1,
    fitness: row.fitness === 1,
    metricsLabs: row.metricsLabs === 1,
    preventiveCare: row.preventiveCare === 1,
  };
}
