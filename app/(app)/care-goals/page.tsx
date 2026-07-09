import { requireSession } from "@/lib/auth";
import { getCareGoals } from "@/lib/queries";
import { PageHeader } from "@/components/ui";
import CareGoalForm from "./CareGoalForm";
import CareGoalList from "./CareGoalList";
import { addCareGoal } from "./actions";

export const dynamic = "force-dynamic";

// Care goals: clinical goals/targets recorded in the profile's health records
// (Goals section, LOINC 61146-7, or a FHIR Goal resource), plus manual add/edit/
// delete. Each row shows the goal, its target date, and status. NB: these are
// clinical goals FROM RECORDS — DISTINCT from the user's own fitness/body goals on
// the "Goals" page (/goals).
export default function CareGoalsPage() {
  const { profile } = requireSession();
  const goals = getCareGoals(profile.id);

  return (
    <div>
      <PageHeader
        title="Health goals"
        subtitle="Clinical goals & targets from your health records (Goals section) — e.g. an A1c or blood-pressure target set by a provider. Add them manually or import from uploaded records. (Distinct from your personal fitness Goals.)"
      />

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="min-w-0 space-y-4 lg:col-span-2">
          <CareGoalList items={goals} />
        </div>

        <div className="min-w-0 space-y-4">
          <CareGoalForm action={addCareGoal} />
          <p className="px-1 text-xs text-slate-400 dark:text-slate-500">
            Informational only, not medical advice. Imported goals come from
            uploaded health records (Goals section).
          </p>
        </div>
      </div>
    </div>
  );
}
