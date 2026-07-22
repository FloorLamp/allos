import LineChartCard from "@/components/LineChartCard";
import { chartSeries } from "@/lib/chart-colors";
import type { OuraScores } from "@/lib/queries";

// Oura's own daily scores, surfaced on the Sleep page (issue #1069) as ATTRIBUTION,
// not assessment: each tile names the vendor ("Oura sleep score" / "Oura
// readiness", never a bare "sleep score") and cites that it's Oura's proprietary
// 0–100 index — the app neither explains nor endorses the formula (the #1032
// coverage-honesty tone). These are STORE-WHAT-THE-SOURCE-SAID display values; they
// feed NO engine (the reverse-allowlist guard pins that). A formatter only over the
// getOuraScores model — no math here. Absent scores render nothing (the caller
// hides the whole section when both are null).

function ScoreTile({
  testid,
  label,
  score,
  color,
}: {
  testid: string;
  label: string;
  score: {
    latest: number;
    date: string;
    trend: { date: string; value: number }[];
  };
  color: string;
}) {
  return (
    <div className="card" data-testid={testid}>
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <h3 className="font-semibold text-slate-800 dark:text-slate-100">
          {label}
        </h3>
        <span className="text-xs text-slate-500 dark:text-slate-400">
          as of {score.date}
        </span>
      </div>
      <div className="flex items-baseline gap-2">
        <span
          className="text-3xl font-bold tabular-nums text-slate-800 dark:text-slate-100"
          data-testid={`${testid}-value`}
          style={{ color }}
        >
          {Math.round(score.latest)}
        </span>
        <span className="text-sm text-slate-500 dark:text-slate-400">
          / 100
        </span>
      </div>
      {score.trend.length > 1 && (
        <div className="mt-3">
          <LineChartCard
            data={score.trend}
            label={label}
            color={color}
            heightClass="h-40"
          />
        </div>
      )}
    </div>
  );
}

export default function OuraScores({ scores }: { scores: OuraScores }) {
  if (!scores.sleep && !scores.readiness) return null;
  return (
    <section data-testid="oura-scores">
      <div className="mb-2 flex items-center gap-2">
        <h2 className="section-label text-slate-500 dark:text-slate-400">
          From Oura
        </h2>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        {scores.sleep && (
          <ScoreTile
            testid="oura-sleep-score"
            label="Oura sleep score"
            score={scores.sleep}
            color={chartSeries.violet}
          />
        )}
        {scores.readiness && (
          <ScoreTile
            testid="oura-readiness-score"
            label="Oura readiness"
            score={scores.readiness}
            color={chartSeries.emerald}
          />
        )}
      </div>
      <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
        Oura&rsquo;s proprietary daily scores, shown as reported and not
        combined into an Allos assessment.
      </p>
    </section>
  );
}
