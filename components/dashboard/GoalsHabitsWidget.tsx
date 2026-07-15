import Link from "next/link";
import { WeeklyTargets } from "@/components/WeeklyTargets";
import LogActivityButton from "@/components/LogActivityButton";
import { summarizeDashboardHabits } from "@/lib/dashboard-widgets";
import { frequencyScopeLabel, goalBarClass, goalPct } from "@/lib/goals";
import type { GoalProgress } from "@/lib/goal-progress";
import type { FrequencyTargetProgress } from "@/lib/queries";
import type { Goal } from "@/lib/types";
import WidgetHeader from "./WidgetHeader";

// One overview question, one card: outcome goals and the weekly behaviors that
// support them. These used to be adjacent Active goals / Weekly routine widgets,
// repeating the same Training destination and competing for dashboard space.
export default function GoalsHabitsWidget({
  goals,
  goalProgress,
  freqTargets,
}: {
  goals: Goal[];
  goalProgress: Map<number, GoalProgress>;
  freqTargets: FrequencyTargetProgress[];
}) {
  const {
    open: allOpenTargets,
    shown: openTargets,
    completedCount: completedTargets,
    hiddenOpenCount,
  } = summarizeDashboardHabits(freqTargets);
  const hasOpenTrainingTarget = allOpenTargets.some(
    (target) => target.target.scope_kind !== "food_group"
  );
  const hasOpenFoodTarget = allOpenTargets.some(
    (target) => target.target.scope_kind === "food_group"
  );

  return (
    <div className="card" data-testid="goals-habits">
      <WidgetHeader
        title="Goals and habits"
        href="/training"
        linkLabel="Manage"
      />

      {goals.length === 0 && freqTargets.length === 0 ? (
        <p className="text-sm text-slate-400 dark:text-slate-500">
          No goals or weekly habits yet —{" "}
          <Link
            href="/training"
            className="text-brand-600 hover:underline dark:text-brand-400"
          >
            set them up in Training
          </Link>
          .
        </p>
      ) : (
        <div className="grid gap-5 lg:grid-cols-2">
          {goals.length > 0 && (
            <section aria-label="Active goals">
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                Active goals
              </h3>
              <ul className="space-y-3">
                {goals.map((goal) => {
                  const pct = goalPct(goal, goalProgress.get(goal.id));
                  return (
                    <li key={goal.id}>
                      <div className="flex items-center justify-between gap-3 text-sm">
                        <span className="truncate font-medium text-slate-700 dark:text-slate-200">
                          {goal.title}
                        </span>
                        {pct != null && (
                          <span className="shrink-0 text-xs text-slate-400 dark:text-slate-500">
                            {pct}%
                          </span>
                        )}
                      </div>
                      {pct != null && (
                        <div className="mt-1 h-2 w-full rounded-full bg-slate-100 dark:bg-ink-800">
                          <div
                            className={`h-2 rounded-full transition-colors ${goalBarClass(pct)}`}
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          )}

          {freqTargets.length > 0 && (
            <section aria-label="Weekly habits">
              <div className="mb-2 flex items-center justify-between gap-3">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                  Still to do this week
                </h3>
                {completedTargets > 0 && (
                  <span className="text-xs text-emerald-600 dark:text-emerald-400">
                    {completedTargets} complete
                  </span>
                )}
              </div>
              {openTargets.length > 0 ? (
                <WeeklyTargets
                  targets={openTargets.map((target) => ({
                    id: target.target.id,
                    label: frequencyScopeLabel(
                      target.target.scope_kind,
                      target.target.scope_value
                    ),
                    count: target.count,
                    perWeek: target.per_week,
                    met: target.met,
                  }))}
                />
              ) : (
                <p className="text-sm text-emerald-600 dark:text-emerald-400">
                  All weekly habits complete.
                </p>
              )}
              {hiddenOpenCount > 0 && (
                <Link
                  href="/training"
                  className="mt-2 inline-block text-xs font-medium text-slate-500 hover:text-brand-600 hover:underline dark:text-slate-400 dark:hover:text-brand-400"
                >
                  +{hiddenOpenCount} more to do →
                </Link>
              )}
              {openTargets.length > 0 && (
                <div className="mt-3 flex flex-wrap items-center gap-3">
                  {hasOpenTrainingTarget && (
                    <LogActivityButton className="text-xs font-medium text-brand-600 hover:underline dark:text-brand-400">
                      Log activity →
                    </LogActivityButton>
                  )}
                  {hasOpenFoodTarget && (
                    <Link
                      href="/nutrition"
                      className="text-xs font-medium text-brand-600 hover:underline dark:text-brand-400"
                    >
                      Log food serving →
                    </Link>
                  )}
                </div>
              )}
            </section>
          )}
        </div>
      )}
    </div>
  );
}
