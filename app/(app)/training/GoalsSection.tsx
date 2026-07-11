import {
  getGoals,
  getGoalProgressMap,
  getFrequencyTargetProgress,
  getActivitySuggestions,
} from "@/lib/queries";
import { getUnitPrefs, getWeekMode } from "@/lib/settings";
import { requireSession } from "@/lib/auth";
import { frequencyScopeLabel } from "@/lib/goals";
import FrequencyTargets from "@/app/(app)/goals/FrequencyTargets";
import GoalsManager from "./GoalsManager";
import GoalPacingFindings from "./GoalPacingFindings";

// Goals (with a create/edit modal) on top, weekly frequency targets below.
export default async function GoalsSection() {
  const { login, profile } = await requireSession();
  const units = getUnitPrefs(login.id);
  const wu = units.weightUnit;
  const goals = getGoals(profile.id);
  // Map → plain object so it can cross into the client GoalsManager.
  const goalProgress = Object.fromEntries(
    getGoalProgressMap(profile.id, goals)
  );
  const targets = getFrequencyTargetProgress(profile.id);
  const weekMode = getWeekMode(profile.id);
  const lifts = getActivitySuggestions(profile.id).lifts;

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
        weightUnit={wu}
      />

      {/* Weekly frequency targets, below the goals. */}
      <div className="card mt-6">
        <h3 className="font-semibold text-slate-800 dark:text-slate-100">
          Weekly routine
        </h3>
        <p className="mt-0.5 text-xs text-slate-400 dark:text-slate-500">
          “Hit X at least N times per week.” Counts distinct training days{" "}
          {weekMode === "rolling"
            ? "over the last 7 days"
            : "in the current week"}
          . Click a routine to edit it.
        </p>
        <FrequencyTargets
          items={targets.map((t) => ({
            id: t.target.id,
            scopeKind: t.target.scope_kind,
            scopeValue: t.target.scope_value,
            label: frequencyScopeLabel(
              t.target.scope_kind,
              t.target.scope_value
            ),
            count: t.count,
            perWeek: t.per_week,
            met: t.met,
          }))}
        />
      </div>
    </section>
  );
}
