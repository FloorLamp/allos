import type { SleepMoodPoint } from "@/lib/sleep-summary";
import { chartSeries } from "@/lib/chart-colors";
import LineChartCard from "@/components/LineChartCard";

// Sleep↔mood pairing (issue #1066, the #992 observation rendered inline): nightly
// main-session sleep and the same-day mood valence over the aligned date axis, so
// the two series can be eyeballed together. Observational only — states
// co-occurrence, never a causal or clinical claim (mirrors the #992 copy stance).
// Renders only when the pairing series is non-empty (both domains present).
export default function SleepMoodSection({
  points,
}: {
  points: SleepMoodPoint[];
}) {
  if (points.length < 2) return null;
  const sleep = points.map((p) => ({ date: p.date, value: p.sleepHours }));
  const mood = points.map((p) => ({ date: p.date, value: p.valence }));
  return (
    <div className="card" data-testid="sleep-mood">
      <h2 className="mb-1 font-semibold text-slate-800 dark:text-slate-100">
        Sleep and mood
      </h2>
      <p className="mb-3 text-xs text-slate-500 dark:text-slate-400">
        Your nightly sleep and that day&apos;s mood check-in, side by side.
        These two often move together — this is an observation, not a diagnosis.
      </p>
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <p className="section-label mb-1">Sleep (hours)</p>
          <LineChartCard
            data={sleep}
            label="Sleep"
            color={chartSeries.violet}
            unit=" h"
            heightClass="h-48"
          />
        </div>
        <div>
          <p className="section-label mb-1">Mood (1–5)</p>
          <LineChartCard
            data={mood}
            label="Mood"
            color={chartSeries.brand}
            heightClass="h-48"
            yDomain={[1, 5]}
          />
        </div>
      </div>
    </div>
  );
}
