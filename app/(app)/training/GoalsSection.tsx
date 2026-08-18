import {
  getOutcomeGoals,
  getOutcomeGoalProgressMap,
  getActivitySuggestions,
  getLoggedEquipmentByExercise,
} from "@/lib/queries";
import { getEquipment } from "@/lib/equipment";
import { getProfileAge, getUnitPrefs } from "@/lib/settings";
import { requireSession } from "@/lib/auth";
import RightSizeSuggestions from "@/components/RightSizeSuggestions";
import { today } from "@/lib/db";
import { getGoalBiomarkerOptions } from "./goal-target-options";
import GoalsManager from "./GoalsManager";
import GoalPacingFindings from "./GoalPacingFindings";
import { isStrengthTrainingRelevant } from "@/lib/life-stage";
import { kindOf } from "@/lib/types";

// The goals half of the Plan tab (#2892): pacing findings, the goal cards, and
// the right-size offers. The weekly-routine targets card that used to sit below
// moved to the top of PlanSection — Plan is its one editing home.
export default async function GoalsSection() {
  const { login, profile } = await requireSession();
  const units = getUnitPrefs(login.id);
  const strengthTrainingAvailable = isStrengthTrainingRelevant(
    getProfileAge(profile.id)
  );
  const wu = units.weightUnit;
  const goals = getOutcomeGoals(profile.id).filter(
    (goal) => strengthTrainingAvailable || goal.kind !== "exercise"
  );
  // Map → plain object so it can cross into the client GoalsManager.
  const goalProgress = Object.fromEntries(
    getOutcomeGoalProgressMap(profile.id, goals)
  );
  const lifts = strengthTrainingAvailable
    ? getActivitySuggestions(profile.id).lifts
    : [];
  // Load-context inputs for the goal form (#1610). Retired gear is included: it still
  // labels history, and a goal may legitimately track a machine you've stopped using.
  // Both collapse to nothing for a profile with no registry equipment, so the picker
  // simply doesn't render.
  const equipment = getEquipment(profile.id, { includeRetired: true })
    .filter(
      (item) =>
        strengthTrainingAvailable || kindOf(item.category) !== "strength"
    )
    .map((e) => ({ id: e.id, name: e.name }));
  const equipmentByExercise = getLoggedEquipmentByExercise(profile.id);

  return (
    <section
      id="goals"
      className="scroll-mt-[calc(5rem+env(safe-area-inset-top))]"
    >
      {/* Goal-pacing findings (issue #45, domain 6): off-pace goals + safe-rate
          weight-loss caution, above the goal cards. */}
      <div className="mb-6">
        <GoalPacingFindings />
      </div>

      <GoalsManager
        goals={goals}
        goalProgress={goalProgress}
        lifts={lifts}
        equipment={equipment}
        equipmentByExercise={equipmentByExercise}
        weightUnit={wu}
        biomarkerOptions={getGoalBiomarkerOptions(
          profile.id,
          today(profile.id)
        )}
        strengthTrainingAvailable={strengthTrainingAvailable}
      />

      {/* Right-sizing suggestions (#1670) for the weekly routine: a training
          frequency target the profile has been under for four completed weeks,
          offered for the cadence they actually keep or for no target at all. */}
      {strengthTrainingAvailable && (
        <div className="mt-6">
          <RightSizeSuggestions profileId={profile.id} domain="training" />
        </div>
      )}
    </section>
  );
}
