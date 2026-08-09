import { requireSession } from "@/lib/auth";
import { today } from "@/lib/db";
import { getWorkoutTypeDays } from "@/lib/queries";
import { getWeekStart } from "@/lib/settings";
import { ACTIVITY_TYPE_LABELS } from "@/lib/activity-meta";
import { ACTIVITY_TYPES } from "@/lib/types";
import { dayHistoryStart } from "@/lib/day-history";
import { EmptyState } from "@/components/ui";
import DayHistory from "@/components/DayHistory";

// Trends → Fitness → sessions-by-type matrix: the COMPOSITION twin of the
// density heatmap above it. The heatmap answers "how often did I train"; this
// answers "training WHAT" — one row per activity type (the canonical
// ACTIVITY_TYPES identity, never a re-derived family from free-text titles),
// one cell per day, over the same shared window. No calendar half here: the
// workout-density heatmap one card up IS this domain's calendar, and a second
// one would be a literal duplicate.
export default async function WorkoutTypeMatrixSection({
  weeks,
  end,
}: {
  weeks: number;
  end: string;
}) {
  const { profile } = await requireSession();
  const weekStart = getWeekStart(profile.id);
  const since = dayHistoryStart(end, weeks, weekStart);
  const typeDays = getWorkoutTypeDays(profile.id, since, end);

  const values = typeDays.map((d) => ({
    date: d.date,
    group: d.type,
    value: d.count,
    detail: d.minutes,
  }));
  const present = new Set(typeDays.map((d) => d.type));
  const groups = ACTIVITY_TYPES.filter((t) => present.has(t)).map((t) => ({
    key: t,
    label: ACTIVITY_TYPE_LABELS[t],
  }));

  return (
    <div className="card" data-testid="workout-type-matrix">
      <h2 className="mb-1 font-semibold text-slate-800 dark:text-slate-100">
        Sessions by type
      </h2>
      <p className="mb-3 text-xs text-slate-500 dark:text-slate-400">
        The density calendar above, split by what the session was — one row per
        activity type, one cell per day.
      </p>
      {values.length === 0 ? (
        <EmptyState
          message="No workouts logged in this window yet."
          action={{ href: "/training?tab=log", label: "Go to Log" }}
        />
      ) : (
        <DayHistory
          domain="workout"
          values={values}
          groups={groups}
          end={end}
          weeks={weeks}
          weekStart={weekStart}
          today={today(profile.id)}
          showCalendar={false}
          testId="workout-type-history"
        />
      )}
    </div>
  );
}
