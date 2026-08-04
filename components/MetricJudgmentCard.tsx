import { RANGE_BADGE_META } from "@/lib/reference-range";
import type { MetricJudgment } from "@/lib/metric-judgment";

// The clinical band a streamed reading is read against (#1996).
//
// Before this card, a metric detail page charted a trend against NOTHING: the
// bands that judge it were filed under a canonical biomarker name and the surface
// was keyed by metric slug, so a three-year-old's 120 bpm resting heart rate — a
// value the curated 1–3 band (80–150) exists precisely to interpret — rendered as
// an unannotated line. The judgement now resolves through the reading's #482
// identity, so it reaches the reading wherever that reading is stored.
//
// Pure presentational, like PediatricBpCard beside it: the page resolves the
// judgement once (lib/queries/metric-judgment.ts) and this renders it. Nothing is
// re-derived here — including the verdict, which is the SAME `rangeBadge` the flag
// reconcile applies to a stored row, so the card and the row can never disagree.
export function MetricJudgmentCard({
  judgment,
  unit,
}: {
  judgment: MetricJudgment | null;
  /** The page's display-unit suffix, so the band reads like the chart. */
  unit: string;
}) {
  if (!judgment) return null;
  const badge = RANGE_BADGE_META[judgment.badge];
  const fmt = (n: number) => String(Math.round(n * 100) / 100);
  const band = (low: number | null, high: number | null) =>
    low != null && high != null
      ? `${fmt(low)}–${fmt(high)}${unit}`
      : low != null
        ? `≥ ${fmt(low)}${unit}`
        : high != null
          ? `≤ ${fmt(high)}${unit}`
          : null;
  const reference = band(judgment.low, judgment.high);
  const optimal = band(judgment.optimalLow, judgment.optimalHigh);

  return (
    <div
      data-testid="metric-judgment"
      className="card mb-6 border-l-4 border-l-brand-400 dark:border-l-brand-600"
    >
      <div className="flex flex-wrap items-start gap-x-8 gap-y-3">
        {reference && (
          <div>
            <div className="label">
              Reference range
              {/* The age band that ACTUALLY applied. Naming it is the safety
                  half: an adult range silently applied to a child is the #150
                  failure this generalizes. */}
              {judgment.bandLabel ? ` · ${judgment.bandLabel}` : ""}
            </div>
            <div
              className="text-2xl font-bold text-brand-700 dark:text-brand-300"
              data-testid="metric-judgment-reference"
            >
              {reference}
            </div>
          </div>
        )}
        {optimal && (
          <div>
            <div className="label">Optimal</div>
            <div
              className="text-2xl font-bold text-brand-700 dark:text-brand-300"
              data-testid="metric-judgment-optimal"
            >
              {optimal}
            </div>
          </div>
        )}
        {judgment.badge !== "unknown" && (
          <div>
            <div className="label">Latest</div>
            <span
              className={`badge ${badge.chip}`}
              data-testid="metric-judgment-badge"
            >
              {badge.label}
            </span>
          </div>
        )}
      </div>
      <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
        {judgment.bandLabel
          ? `Judged against the ${judgment.bandLabel} band for ${judgment.canonical}`
          : `Judged against the reference range for ${judgment.canonical}`}
        , the same ranges every reading of this measurement is flagged by.
      </p>
    </div>
  );
}
