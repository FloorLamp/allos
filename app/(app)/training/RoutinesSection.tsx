import { requireSession } from "@/lib/auth";
import {
  getRoutinesWithDays,
  getTrainingTargetsToReplace,
} from "@/lib/routines";
import { ROUTINE_TEMPLATES } from "@/lib/routine-templates";
import { LIFT_OPTIONS } from "@/lib/lifts";
import { frequencyScopeLabel } from "@/lib/goals";
import RoutinesManager from "./RoutinesManager";

// Routines tab (#739): read the profile's routines + the training-scope frequency
// targets an activation would replace, then hand a client manager the catalog
// templates and lift options for the adopt picker / custom builder. All writes go
// through the auth-gated #738 Server Actions — this section only reads.
export default async function RoutinesSection() {
  const { profile } = await requireSession();
  const routines = getRoutinesWithDays(profile.id);
  const replaceTargets = getTrainingTargetsToReplace(profile.id).map((t) => ({
    label: frequencyScopeLabel(t.scope_kind, t.scope_value),
    perWeek: t.per_week,
  }));
  const templates = ROUTINE_TEMPLATES.map((t) => ({
    id: t.id,
    name: t.name,
    description: t.description,
    audience: t.audience,
    dayCount: t.days.length,
  }));

  return (
    <RoutinesManager
      routines={routines}
      templates={templates}
      replaceTargets={replaceTargets}
      liftOptions={LIFT_OPTIONS}
    />
  );
}
