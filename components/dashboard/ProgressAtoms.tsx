import Link from "next/link";
import { WeeklyTargets } from "@/components/WeeklyTargets";
import CardSectionHeader from "@/components/CardSectionHeader";
import { dashboardHabitDomain } from "@/lib/dashboard-presentation";
import { goalBarClass, goalPaceTone, goalPct } from "@/lib/outcome-goals";
import { frequencyScopeLabel } from "@/lib/frequency-targets";
import type { GoalProgress } from "@/lib/goal-progress";
import type { FrequencyTargetProgress } from "@/lib/queries";
import type { OutcomeGoal } from "@/lib/types";

export function GoalProgressAtom({
  goal,
  progress,
  today,
}: {
  goal: OutcomeGoal;
  progress: GoalProgress | undefined;
  today: string;
}) {
  const pct = goalPct(goal, progress);
  const paceOpts = {
    createdAt: goal.created_at,
    targetDate: goal.target_date,
    today,
  };
  return (
    <div className="card" data-testid="goal-progress-atom">
      <CardSectionHeader title="Goals and habits" href="/training?tab=goals" />
      <div className="grid gap-5">
        <section aria-label="Active goals">
          <h3 className="mb-2 section-label">Active goals</h3>
          <ul className="space-y-3">
            <li>
              <div className="flex items-center justify-between gap-3 text-sm">
                {pct != null ? (
                  <span className="truncate font-medium text-slate-700 dark:text-slate-200">
                    {goal.title}
                  </span>
                ) : (
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
          </ul>
        </section>
      </div>
    </div>
  );
}

export function HabitProgressAtom({
  progress,
}: {
  progress: FrequencyTargetProgress;
}) {
  const domain = dashboardHabitDomain(progress.target.scope_kind);
  const href =
    domain === "food"
      ? ("/nutrition" as const)
      : domain === "practice"
        ? ("/wellness" as const)
        : ("/training?tab=goals" as const);
  return (
    <div className="card" data-testid="habit-progress-atom">
      <CardSectionHeader title="Goals and habits" href={href} />
      <div className="grid gap-5">
        <section aria-label="Weekly target">
          <h3 className="mb-2 section-label">This week</h3>
          <WeeklyTargets
            targets={[
              {
                id: progress.target.id,
                label: frequencyScopeLabel(
                  progress.target.scope_kind,
                  progress.target.scope_value
                ),
                count: progress.count,
                perWeek: progress.per_week,
                met: progress.met,
                pace: progress.pace,
              },
            ]}
          />
        </section>
      </div>
    </div>
  );
}
