import Link from "next/link";
import { WeeklyTargets } from "@/components/WeeklyTargets";
import LogActivityButton from "@/components/LogActivityButton";
import {
  dashboardGoalsHabitsLayout,
  summarizeDashboardHabits,
} from "@/lib/dashboard-widgets";
import {
  frequencyScopeLabel,
  goalBarClass,
  goalPaceTone,
  goalPct,
} from "@/lib/goals";
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
  today,
}: {
  goals: Goal[];
  goalProgress: Map<number, GoalProgress>;
  freqTargets: FrequencyTargetProgress[];
  // The active profile's today (YYYY-MM-DD) — the pace clock for goal bars (#780).
  today: string;
}) {
  const {
    open: allOpenTargets,
    shown: openTargets,
    hidden: hiddenOpenTargets,
    completedCount: completedTargets,
  } = summarizeDashboardHabits(freqTargets);
  const hasGoals = goals.length > 0;
  const hasHabits = freqTargets.length > 0;
  const layout = dashboardGoalsHabitsLayout(hasGoals, hasHabits);
  const hasTrainingContent =
    hasGoals ||
    freqTargets.some((target) => target.target.scope_kind !== "food_group");
  const hasFoodContent = freqTargets.some(
    (target) => target.target.scope_kind === "food_group"
  );
  const hasOpenTrainingTarget = allOpenTargets.some(
    (target) => target.target.scope_kind !== "food_group"
  );
  const hasOpenFoodTarget = allOpenTargets.some(
    (target) => target.target.scope_kind === "food_group"
  );
  const hiddenTrainingTargets = hiddenOpenTargets.filter(
    (target) => target.target.scope_kind !== "food_group"
  );
  const hiddenFoodTargets = hiddenOpenTargets.filter(
    (target) => target.target.scope_kind === "food_group"
  );
  const headerHref =
    hasFoodContent && !hasTrainingContent
      ? ("/nutrition" as const)
      : ("/training?tab=goals" as const);
  return (
    <div className="card" data-testid="goals-habits">
      <WidgetHeader title="Goals and habits" href={headerHref} />

      {goals.length === 0 && freqTargets.length === 0 ? (
        <p className="text-sm text-slate-500 dark:text-slate-400">
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
        <div
          data-testid="goals-habits-sections"
          data-layout={layout}
          className={`grid gap-5 ${layout === "split" ? "lg:grid-cols-2" : ""}`}
        >
          {goals.length > 0 && (
            <section aria-label="Active goals">
              <h3 className="mb-2 section-label">Active goals</h3>
              <ul className="space-y-3">
                {goals.map((goal) => {
                  const pct = goalPct(goal, goalProgress.get(goal.id));
                  const paceOpts = {
                    createdAt: goal.created_at,
                    targetDate: goal.target_date,
                    today,
                  };
                  return (
                    <li key={goal.id}>
                      <div className="flex items-center justify-between gap-3 text-sm">
                        {pct != null ? (
                          <span className="truncate font-medium text-slate-700 dark:text-slate-200">
                            {goal.title}
                          </span>
                        ) : (
                          /* A goal with no measurable target renders no bar — link
                             its title to the goals surface so the row is still a
                             path to the goal, not an inert label (#1219). */
                          <Link
                            href="/training?tab=goals"
                            data-testid="goal-title-link"
                            className="truncate font-medium text-slate-700 hover:text-brand-600 hover:underline dark:text-slate-200 dark:hover:text-brand-400"
                          >
                            {goal.title}
                          </Link>
                        )}
                        {pct != null && (
                          <span className="shrink-0 text-xs text-slate-500 dark:text-slate-400">
                            {pct}%
                          </span>
                        )}
                      </div>
                      {pct != null && (
                        <div className="mt-1 h-2 w-full rounded-full bg-slate-100 dark:bg-ink-800">
                          <div
                            data-testid="goal-bar"
                            data-tone={goalPaceTone(pct, paceOpts)}
                            className={`h-2 rounded-full transition-colors ${goalBarClass(pct, paceOpts)}`}
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
                <h3 className="section-label">Still to do this week</h3>
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
                    pace: target.pace,
                  }))}
                />
              ) : (
                <p className="text-sm text-emerald-600 dark:text-emerald-400">
                  All weekly habits complete.
                </p>
              )}
              {hiddenOpenTargets.length > 0 && (
                <div className="mt-2 flex flex-wrap items-center gap-3">
                  {hiddenTrainingTargets.length > 0 && (
                    <Link
                      href="/training?tab=goals"
                      className="text-xs font-medium text-slate-500 hover:text-brand-600 hover:underline dark:text-slate-400 dark:hover:text-brand-400"
                    >
                      +{hiddenTrainingTargets.length} more training →
                    </Link>
                  )}
                  {hiddenFoodTargets.length > 0 && (
                    <Link
                      href="/nutrition"
                      className="text-xs font-medium text-slate-500 hover:text-brand-600 hover:underline dark:text-slate-400 dark:hover:text-brand-400"
                    >
                      +{hiddenFoodTargets.length} more food habits →
                    </Link>
                  )}
                </div>
              )}
              {(openTargets.length > 0 ||
                (hasFoodContent && hasTrainingContent)) && (
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
                  {hasFoodContent && hasTrainingContent && (
                    <Link
                      href="/nutrition"
                      className="text-xs font-medium text-slate-500 hover:text-brand-600 hover:underline dark:text-slate-400 dark:hover:text-brand-400"
                    >
                      Manage food habits →
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
