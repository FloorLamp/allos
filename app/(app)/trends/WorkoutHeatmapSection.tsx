import { requireSession } from "@/lib/auth";
import { getWorkoutHeatmap } from "@/lib/queries";
import { EmptyState } from "@/components/ui";
import WorkoutHeatmapView from "@/components/WorkoutHeatmap";

// Trends → Fitness → workout-density heatmap (issue #186). The GitHub-style
// contribution calendar of workouts — one cell per profile-local day over the
// trailing ~12 months, colored by session count, each active day deep-linking to
// its Timeline view. The "how often" companion to the HR-zone "how hard" card
// (#159). Plain divs (no chart lib), server-fetched grid + a small client hover
// layer. Always rendered above the Strength/Cardio/Sport strip.
export default async function WorkoutHeatmapSection() {
  const { profile } = await requireSession();
  const data = getWorkoutHeatmap(profile.id);

  return (
    <section data-testid="workout-heatmap-section" className="mb-6">
      <div className="card">
        <h3 className="mb-1 font-semibold text-slate-800 dark:text-slate-100">
          Workout density
        </h3>
        <p className="mb-4 text-xs text-slate-400 dark:text-slate-500">
          Every workout day over the last 12 months, shaded by how many sessions
          you logged. Hover a day for detail; click it to open that day on the
          Timeline.
        </p>

        {data.totalSessions === 0 ? (
          <EmptyState message="No workouts logged in the last 12 months yet. Log a session on the Training page to start filling in your calendar." />
        ) : (
          <WorkoutHeatmapView data={data} />
        )}
      </div>
    </section>
  );
}
