import Link from "next/link";
import { requireSession } from "@/lib/auth";
import { today } from "@/lib/db";
import { getWorkoutTypeDays } from "@/lib/queries";
import { getWeekStart } from "@/lib/settings";
import { ACTIVITY_TYPE_LABELS } from "@/lib/activity-meta";
import { ACTIVITY_TYPES } from "@/lib/types";
import { dayHistoryStart } from "@/lib/day-history";
import { EmptyState } from "@/components/ui";
import DayHistory from "@/components/DayHistory";

// Trends → Fitness leads with the workout history: the generalized day-history
// (lib/day-history.ts) over the window's sessions — a CALENDAR (how often, the
// #186 density question, replacing the bespoke WorkoutHeatmap) and a MATRIX
// (training WHAT — one row per activity type, the canonical ACTIVITY_TYPES
// identity, never a re-derived family from free-text titles). Card-less, a
// page-level section, so the grids run edge to edge on phones.
export default async function WorkoutHistorySection({
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
    <section data-testid="workout-history">
      <div className="mb-1 flex items-center justify-between">
        <h2 className="font-semibold text-slate-800 dark:text-slate-100">
          Workout history
        </h2>
        <Link
          href="/training"
          className="text-sm font-medium text-brand-700 hover:underline dark:text-brand-400"
        >
          Training →
        </Link>
      </div>
      <p className="mb-3 text-sm text-slate-500 dark:text-slate-400">
        Every workout day in this window, then the same days split by activity
        type. Tap a day to open it on the Timeline.
      </p>
      {values.length === 0 ? (
        <EmptyState
          message="No workouts logged in this window yet. Log a session to start filling in your calendar."
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
          testId="workout-day-history"
        />
      )}
    </section>
  );
}
