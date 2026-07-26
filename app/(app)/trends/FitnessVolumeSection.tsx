import { requireSession } from "@/lib/auth";
import { getVolumeByDate } from "@/lib/queries";
import { getUnitPrefs } from "@/lib/settings";
import { chartSeries } from "@/lib/chart-colors";
import { dispWeight } from "@/lib/units";
import type { FitnessWindow } from "@/lib/trends-fitness";
import { EmptyState } from "@/components/ui";
import StackedBarCard from "@/components/StackedBarCard";
import WorkoutHeatmapSection from "./WorkoutHeatmapSection";

// Trends → Fitness → **Volume & cadence** (#1492), the tab's first section and
// therefore its first chart: how much work the window held, and how it was spread
// across the days.
//
// The volume chart is BARS, not a line (#1485 D): per-session training volume is a
// discrete quantity per training day, and a line drawn between two sessions a week
// apart implies values on the rest days that were never lifted. Same computation
// as /training's volume series, windowed — `getVolumeByDate` grew `since`/`until`
// rather than the tab growing a second volume engine (#221).
export default async function FitnessVolumeSection({
  window,
  weeks,
}: {
  window: FitnessWindow;
  weeks: number;
}) {
  const { login, profile } = await requireSession();
  const wu = getUnitPrefs(login.id).weightUnit;
  const volume = getVolumeByDate(
    profile.id,
    window.from ?? undefined,
    window.to
  ).map((v) => ({ date: v.date, volume: dispWeight(v.volume, wu, 0) }));

  return (
    <section
      id="volume"
      className="scroll-mt-28 space-y-6"
      data-testid="fitness-volume"
    >
      <div className="card">
        <h2 className="mb-1 font-semibold text-slate-800 dark:text-slate-100">
          Training volume
        </h2>
        <p className="mb-3 text-xs text-slate-500 dark:text-slate-400">
          Working {wu} lifted per session in this window (warmups excluded).
        </p>
        {volume.length === 0 ? (
          <EmptyState
            message="No strength sessions in this window. Widen the range, or log a lift."
            action={{ href: "/training?tab=log", label: "Go to Log" }}
          />
        ) : (
          <StackedBarCard
            data={volume}
            unit={` ${wu}`}
            series={[
              {
                key: "volume",
                label: `Volume (${wu})`,
                color: chartSeries.brand,
              },
            ]}
          />
        )}
      </div>

      {/* Cadence: the workout-density calendar (#186), re-scoped to the same
          window and compacted — a 90D window is ~13 columns, not the old
          unconditional 12-month wall above every nested tab. */}
      <WorkoutHeatmapSection weeks={weeks} end={window.to} />
    </section>
  );
}
