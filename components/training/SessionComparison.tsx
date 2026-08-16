import {
  comparisonDifference,
  comparisonTone,
  formatComparisonValue,
} from "@/lib/session-comparison-format";
import type {
  RideComparison,
  RideComparisonMetricKey,
} from "@/lib/ride-detail";
import type { DistanceUnit } from "@/lib/settings";

// ONE presentation of "how this session compares to my own like-for-like ones",
// for every session type (#2566's convergence; owner ruling 2026-08-16). The
// ride page had a considered treatment and the canonical activity page grew a
// second, plainer one — including a tone bug the ride page did not have. Sharing
// the component is what stops that happening again.
//
// The peer MATH is `sessionComparison` in lib; this is only how it reads.

const METRIC_LABELS: Record<RideComparisonMetricKey, string> = {
  speed: "Speed",
  heart_rate: "Heart rate",
  power: "Power",
  weighted_power: "Weighted power",
  cadence: "Cadence",
  elevation: "Elevation",
  relative_effort: "Relative effort",
};

const TONE_CLASS = {
  good: "text-emerald-700 dark:text-emerald-300",
  watch: "text-amber-700 dark:text-amber-300",
  neutral: "text-sky-700 dark:text-sky-300",
} as const;

export default function SessionComparison({
  comparison,
  distanceUnit,
  // Metrics this surface has no vocabulary for. A walk that somehow carries
  // watts is not helped by being told about them.
  omitKeys = [],
  testId = "session-comparison",
}: {
  comparison: RideComparison;
  distanceUnit: DistanceUnit;
  omitKeys?: RideComparisonMetricKey[];
  testId?: string;
}) {
  const metrics = comparison.metrics.filter(
    (metric) => !omitKeys.includes(metric.key)
  );
  if (metrics.length === 0) return null;

  return (
    <div className="card mt-4" data-testid={testId}>
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="font-semibold text-slate-800 dark:text-slate-100">
          How this compares
        </h3>
        <span className="text-xs text-slate-500 dark:text-slate-400">
          {comparison.rideCount} similar{" "}
          {comparison.rideCount === 1 ? "session" : "sessions"}
        </span>
      </div>
      {/* It states its own basis: a "median" over one peer is a comparison in
          name only, and the reader deserves to know which it is. */}
      <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
        Against the median of your own sessions of this kind, within{" "}
        {Math.round(comparison.tolerancePercent)}% of the same{" "}
        {comparison.basis === "distance" ? "distance" : "duration"}.
      </p>
      <ul className="mt-3 space-y-2">
        {metrics.map((metric) => {
          const difference = comparisonDifference(metric, distanceUnit);
          const tone = comparisonTone(metric, difference.relation);
          return (
            <li
              key={metric.key}
              data-testid={`${testId}-${metric.key.replace("_", "-")}`}
              className="flex items-baseline justify-between gap-4 text-sm"
            >
              <span className="text-slate-700 dark:text-slate-200">
                {METRIC_LABELS[metric.key]}
              </span>
              <span className="flex items-baseline gap-2 tabular-nums">
                <span className="font-medium text-slate-800 dark:text-slate-100">
                  {formatComparisonValue(
                    metric.key,
                    metric.current,
                    distanceUnit
                  )}
                </span>
                {/* The whole sentence, not a bare number: "2.1 km/h above 9.6
                    km/h median" is readable where "+2.1" needs a legend. */}
                <span className={`text-xs ${TONE_CLASS[tone]}`}>
                  {difference.value ? `${difference.value} ` : ""}
                  {difference.relation}{" "}
                  {formatComparisonValue(
                    metric.key,
                    metric.median,
                    distanceUnit
                  )}{" "}
                  median
                </span>
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
