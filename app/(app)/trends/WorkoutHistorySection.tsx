import Link from "next/link";
import { requireSession } from "@/lib/auth";
import { today } from "@/lib/db";
import { getWorkoutActivityDays } from "@/lib/queries";
import { getWeekStart } from "@/lib/settings";
import { dayHistoryStart } from "@/lib/day-history";
import { EmptyState } from "@/components/ui";
import DayHistory from "@/components/DayHistory";

// Trends → Fitness leads with the workout history: the generalized day-history
// (lib/day-history.ts) over the window's sessions — a CALENDAR (how often, the
// #186 density question, replacing the bespoke WorkoutHeatmap) and a MATRIX
// (training WHAT — one row per NAMED activity, keyed on the canonical
// activityHistoryKey of the normalized title, so a PPL routine reads as its
// own rows: Push Day / Pull Day / Legs, with the tail folded). Card-less, a
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
  const activityDays = getWorkoutActivityDays(profile.id, since, end);

  const values = activityDays.map((d) => ({
    date: d.date,
    group: d.key,
    value: d.count,
    detail: d.minutes,
  }));
  // Vocabulary ordered by window volume (sessions desc) — "top N activities";
  // the matrix folds the tail and the chips read most-relevant first.
  const totals = new Map<string, { label: string; total: number }>();
  for (const d of activityDays) {
    const t = totals.get(d.key) ?? { label: d.label, total: 0 };
    t.total += d.count;
    totals.set(d.key, t);
  }
  const groups = [...totals.entries()]
    .sort((a, b) => b[1].total - a[1].total)
    .map(([key, v]) => ({ key, label: v.label }));

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
        Every workout day in this window, then the same days split by activity.
        Tap a day to open it on the Timeline.
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
