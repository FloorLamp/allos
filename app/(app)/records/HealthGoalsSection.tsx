import { getCareGoalsForProfiles } from "@/lib/queries";
import { stampSubjects, type ProfileScope } from "@/lib/scope";
import CareGoalForm from "@/app/(app)/care-goals/CareGoalForm";
import CareGoalList from "@/app/(app)/care-goals/CareGoalList";
import { addCareGoal } from "@/app/(app)/care-goals/actions";

// Health goals (former /care-goals index, #1042 phase 6): clinical goals/targets
// recorded in the profile's health records (Goals section, LOINC 61146-7, or a
// FHIR Goal resource), plus manual add/edit/delete — now the #health-goals
// section of /records. Each row shows the goal, its target date, and status. NB:
// these are clinical goals FROM RECORDS — DISTINCT from the user's own
// fitness/body goals on the "Goals" page (/goals).
// Multi-view (#1328): care_goals is a truly-flat list (no cross-document dedup, no
// per-profile derivation), so it reads the view-set with a SET-BASED `profile_id IN`
// query (getCareGoalsForProfiles, the registered cross-profile module) rather than a
// per-profile loop. Subject chips + per-item write gates via the stamped rows; single
// view (viewIds = [acting]) is byte-identical.
export default function HealthGoalsSection({ scope }: { scope: ProfileScope }) {
  const multi = scope.viewIds.length > 1;
  const goals = stampSubjects(scope, getCareGoalsForProfiles(scope.viewIds));

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <div className="min-w-0 space-y-4 lg:col-span-2">
        <CareGoalList
          items={goals}
          multiView={
            multi ? { actingProfileId: scope.actingProfileId } : undefined
          }
        />
      </div>

      <div className="min-w-0 space-y-4">
        <CareGoalForm action={addCareGoal} />
        <p className="px-1 text-xs text-slate-500 dark:text-slate-400">
          Imported goals come from uploaded health records (Goals section).
        </p>
      </div>
    </div>
  );
}
