import { requireSession } from "@/lib/auth";
import { getWorkoutHeatmap } from "@/lib/queries";
import { EmptyState } from "@/components/ui";
import WorkoutHeatmapView from "@/components/WorkoutHeatmap";

// Trends → Fitness → workout-density heatmap (issue #186). The GitHub-style
// contribution calendar of workouts — one cell per profile-local day, colored by
// session count, each active day deep-linking to its Timeline view. The "how
// often" companion to the HR-zone "how hard" card (#159). Plain divs (no chart
// lib), server-fetched grid + a small client hover layer.
//
// #1492: it honors the hub's SHARED WINDOW instead of an unconditional trailing 12
// months. `weeks` (from the window's length) and `end` (the window's last day) come
// from the Fitness lens — 90D draws ~13 columns, All time keeps the 12-month cap —
// and the copy compacted with it: the grid is legible without a paragraph, and
// this card no longer sits above every nested tab as a pre-chart wall (it now
// follows the volume chart inside Volume & cadence).
export default async function WorkoutHeatmapSection({
  weeks,
  end,
}: {
  weeks?: number;
  end?: string;
}) {
  const { profile } = await requireSession();
  const data = getWorkoutHeatmap(profile.id, weeks, end);

  return (
    <div className="card" data-testid="workout-heatmap-section">
      <h2 className="mb-1 font-semibold text-slate-800 dark:text-slate-100">
        Workout density
      </h2>
      <p className="mb-3 text-xs text-slate-500 dark:text-slate-400">
        Every workout day in this window, shaded by session count. Tap a day to
        open it on the Timeline.
      </p>

      {data.totalSessions === 0 ? (
        <EmptyState
          message="No workouts logged in this window yet. Log a session to start filling in your calendar."
          action={{ href: "/training?tab=log", label: "Go to Log" }}
        />
      ) : (
        <WorkoutHeatmapView data={data} />
      )}
    </div>
  );
}
