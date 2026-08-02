import { getCareGoalsForProfiles } from "@/lib/queries";
import { stampSubjects, type ProfileScope } from "@/lib/scope";
import CareGoalForm from "@/app/(app)/records/care/overview/CareGoalForm";
import AddEntryPanel from "@/components/AddEntryPanel";
import CareGoalList from "@/app/(app)/records/care/overview/CareGoalList";
import { addCareGoal } from "@/app/(app)/records/care/overview/care-goal-actions";

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
    <div className="space-y-6">
      <AddEntryPanel
        testId="add-health-goal-panel"
        panelId="add-health-goal-panel-body"
        label="Add health goal"
        presentation="modal"
      >
        <CareGoalForm action={addCareGoal} />
      </AddEntryPanel>
      <CareGoalList
        items={goals}
        multiView={
          multi ? { actingProfileId: scope.actingProfileId } : undefined
        }
      />
    </div>
  );
}
