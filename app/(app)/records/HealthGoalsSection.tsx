import { MEDICAL_DISCLAIMER } from "@/lib/disclaimers";
import { getCareGoals } from "@/lib/queries";
import CareGoalForm from "@/app/(app)/care-goals/CareGoalForm";
import CareGoalList from "@/app/(app)/care-goals/CareGoalList";
import { addCareGoal } from "@/app/(app)/care-goals/actions";

// Health goals (former /care-goals index, #1042 phase 6): clinical goals/targets
// recorded in the profile's health records (Goals section, LOINC 61146-7, or a
// FHIR Goal resource), plus manual add/edit/delete — now the #health-goals
// section of /records. Each row shows the goal, its target date, and status. NB:
// these are clinical goals FROM RECORDS — DISTINCT from the user's own
// fitness/body goals on the "Goals" page (/goals).
export default function HealthGoalsSection({
  profileId,
}: {
  profileId: number;
}) {
  const goals = getCareGoals(profileId);

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <div className="min-w-0 space-y-4 lg:col-span-2">
        <CareGoalList items={goals} />
      </div>

      <div className="min-w-0 space-y-4">
        <CareGoalForm action={addCareGoal} />
        <p className="px-1 text-xs text-slate-500 dark:text-slate-400">
          {MEDICAL_DISCLAIMER} Imported goals come from uploaded health records
          (Goals section).
        </p>
      </div>
    </div>
  );
}
