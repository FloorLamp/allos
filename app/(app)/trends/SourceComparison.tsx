import {
  getBodyMetricSeriesBySource,
  getHrSeriesBySource,
  getMetricSeriesBySource,
  type MetricSourceSeries,
} from "@/lib/queries";
import { getMetricSourcePriority } from "@/lib/settings";
import {
  COMPARABLE_METRICS,
  sourceColor,
  type ComparableMetric,
} from "@/lib/metric-source-priority";
import { getIntegration } from "@/lib/integrations/registry";
import { DOCUMENT_SOURCE_PREFIX } from "@/lib/body-metric-extract";
import { dispWeight, round } from "@/lib/units";
import type { BodyMetricKind, IntegrationId } from "@/lib/types";
import type { WeightUnit } from "@/lib/settings";
import type { CompareSeries } from "@/components/SourceCompareChartInner";
import SourceCompareChart from "@/components/SourceCompareChart";
import PrimarySourcePicker from "./PrimarySourcePicker";

// "Compare sources" (issue #14): for every metric that more than one source is
// reporting, a per-source overlay chart plus the primary-source picker. Renders
// NOTHING for a single-source profile — the section only exists when there is
// genuinely something to compare, so the Body tab stays calm.

function sourceLabel(source: string): string {
  if (source === "manual") return "Manual";
  if (source.startsWith(DOCUMENT_SOURCE_PREFIX)) return "Document";
  return getIntegration(source as IntegrationId)?.name ?? source;
}

// Convert a canonical series value to its display value for the card.
function displayValue(
  metric: ComparableMetric,
  value: number,
  wu: WeightUnit
): number {
  if (metric.key === "weight") return dispWeight(value, wu);
  if (metric.key === "sleep_min") return round(value / 60, 1); // minutes → hours
  return round(value, metric.decimals);
}

interface ComparisonCard {
  metric: ComparableMetric;
  unit: string;
  series: CompareSeries[];
  current: string;
}

export default function SourceComparison({
  profileId,
  weightUnit,
}: {
  profileId: number;
  weightUnit: WeightUnit;
}) {
  const priority = getMetricSourcePriority(profileId);
  const cards: ComparisonCard[] = [];
  for (const metric of COMPARABLE_METRICS) {
    const raw: MetricSourceSeries[] =
      metric.kind === "sample"
        ? getMetricSeriesBySource(profileId, metric.key)
        : metric.kind === "body"
          ? getBodyMetricSeriesBySource(profileId, metric.key as BodyMetricKind)
          : getHrSeriesBySource(profileId);
    if (raw.length < 2) continue; // nothing to compare
    const unit = metric.key === "weight" ? ` ${weightUnit}` : metric.unit;
    cards.push({
      metric,
      unit,
      series: raw.map((s) => ({
        key: s.source,
        label: sourceLabel(s.source),
        color: sourceColor(s.source),
        data: s.data.map((d) => ({
          date: d.date,
          value: displayValue(metric, d.value, weightUnit),
        })),
      })),
      current: priority[metric.key] ?? "",
    });
  }
  if (cards.length === 0) return null;

  return (
    <div className="space-y-6" data-testid="source-comparison">
      <div>
        <h2 className="font-semibold text-slate-800 dark:text-slate-100">
          Compare sources
        </h2>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          More than one source is reporting these metrics. Each line is one
          source; pick a primary source to make it authoritative for totals and
          latest-value readouts (Automatic prefers manual entries, then Health
          Connect).
        </p>
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        {cards.map(({ metric, unit, series, current }) => (
          <div
            key={metric.key}
            className="card"
            data-testid={`source-compare-${metric.key}`}
          >
            <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="font-semibold text-slate-800 dark:text-slate-100">
                {metric.title}
              </h3>
              <PrimarySourcePicker
                metric={metric.key}
                current={current}
                options={series.map((s) => ({ value: s.key, label: s.label }))}
              />
            </div>
            <SourceCompareChart series={series} unit={unit} />
            <div
              className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500 dark:text-slate-400"
              data-testid={`source-legend-${metric.key}`}
            >
              {series.map((s) => (
                <span key={s.key} className="inline-flex items-center gap-1.5">
                  <span
                    className="inline-block h-2 w-2 rounded-full"
                    style={{ backgroundColor: s.color }}
                    aria-hidden
                  />
                  {s.label}
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
