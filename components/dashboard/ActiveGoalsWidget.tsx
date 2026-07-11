import { goalBarClass, goalPct } from "@/lib/goals";
import type { Goal } from "@/lib/types";
import type { GoalProgress } from "@/lib/goal-progress";
import WidgetHeader from "./WidgetHeader";

// Active-goals list (extracted from page.tsx, behavior-preserving).
export default function ActiveGoalsWidget({
  goals,
  goalProgress,
}: {
  goals: Goal[];
  goalProgress: Map<number, GoalProgress>;
}) {
  return (
    <div className="card">
      <WidgetHeader
        title="Active goals"
        href="/training"
        linkLabel="All goals"
      />
      {goals.length === 0 ? (
        <p className="text-sm text-slate-400 dark:text-slate-500">
          No active goals.
        </p>
      ) : (
        <ul className="space-y-3">
          {goals.map((g) => {
            const pct = goalPct(g, goalProgress.get(g.id));
            return (
              <li key={g.id}>
                <div className="flex items-center justify-between text-sm">
                  <span className="font-medium text-slate-700 dark:text-slate-200">
                    {g.title}
                  </span>
                  {pct != null && (
                    <span className="text-xs text-slate-400 dark:text-slate-500">
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
      )}
    </div>
  );
}
