import { requireSession } from "@/lib/auth";
import { today } from "@/lib/db";
import { getCardioIntensityMix, getCardioVolumeByWeek } from "@/lib/queries";
import { formatMinutes } from "@/lib/duration";
import type { FitnessWindow } from "@/lib/trends-fitness";
import { EmptyState } from "@/components/ui";
import StackedBarCard from "@/components/StackedBarCard";
import ChartCard from "@/components/ChartCard";
import TrainingZonesSection from "./TrainingZonesSection";

// Intensity → bar/legend color (the same vocabulary the /training cardio section
// used, kept so the mix bar reads identically wherever it renders).
const INTENSITY_COLOR: Record<string, string> = {
  Easy: "bg-emerald-500",
  Moderate: "bg-amber-500",
  Hard: "bg-rose-500",
  Unspecified: "bg-slate-400",
};

// Trends → Fitness → **Zones & cardio** (#1492): how hard the window's aerobic
// work was.
//
// Two windowed reads of EXISTING computations (#221), never forks:
//   • getTrainingZoneData — the #159 zone model, weekly zone minutes, Zone 2
//     target and the easy/hard polarization split, now scoped to the window
//   • getCardioVolumeByWeek / getCardioIntensityMix — the weekly cardio-minutes
//     stack and the intensity mix, now scoped to the window
export default async function FitnessZonesSection({
  window,
  weeks,
}: {
  window: FitnessWindow;
  weeks: number;
}) {
  const { profile } = await requireSession();
  const todayStr = today(profile.id);
  const since = window.from ?? undefined;
  const weekly = getCardioVolumeByWeek(profile.id, weeks, since, window.to);
  const mix = getCardioIntensityMix(profile.id, since, window.to);
  const mixTotal = mix.reduce((s, b) => s + b.minutes, 0);

  return (
    <section
      id="zones"
      className="scroll-mt-28 space-y-6"
      data-testid="fitness-zones"
    >
      <TrainingZonesSection
        weeks={weeks}
        end={window.to}
        includesToday={window.to >= todayStr}
      />

      {/* Weekly minutes are an AGGREGATE over logged cardio sessions; Training →
          Analyze holds the per-session detail each bar is built from. */}
      <ChartCard
        testid="fitness-cardio-volume"
        title="Weekly cardio volume"
        detailHref="/training?tab=analyze"
        detailTitle="cardio volume"
        description="Minutes per week in this window, by activity."
      >
        {weekly.data.length === 0 ? (
          <EmptyState
            message="No cardio in this window. Widen the range, or log a run, ride, or swim."
            action={{ href: "/training?tab=log", label: "Go to Log" }}
          />
        ) : (
          <StackedBarCard
            data={weekly.data}
            series={weekly.series}
            unit=" min"
            labelPrefix="Week of "
          />
        )}
      </ChartCard>

      {mixTotal > 0 && (
        <div className="card" data-testid="fitness-intensity-mix">
          <h2 className="mb-3 font-semibold text-slate-800 dark:text-slate-100">
            Intensity mix
          </h2>
          <div className="flex h-3 w-full overflow-hidden rounded-full bg-slate-100 dark:bg-ink-800">
            {mix.map((b) => (
              <div
                key={b.intensity}
                className={INTENSITY_COLOR[b.intensity] ?? "bg-slate-400"}
                style={{ width: `${(b.minutes / mixTotal) * 100}%` }}
                title={`${b.intensity}: ${formatMinutes(b.minutes)}`}
              />
            ))}
          </div>
          <ul className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-xs text-slate-500 dark:text-slate-400">
            {mix.map((b) => (
              <li key={b.intensity} className="flex items-center gap-1.5">
                <span
                  className={`h-2.5 w-2.5 rounded-full ${INTENSITY_COLOR[b.intensity] ?? "bg-slate-400"}`}
                />
                {b.intensity} — {formatMinutes(b.minutes)} · {b.sessions}×
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
