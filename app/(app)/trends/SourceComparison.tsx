import {
  getBodyMetricSeriesBySource,
  getHrSeriesBySource,
  getMetricSeriesBySource,
  getMedicalDocuments,
  type MetricSourceSeries,
} from "@/lib/queries";
import { getMetricSourcePriority } from "@/lib/settings";
import {
  COMPARABLE_METRICS,
  documentSourceId,
  documentSourceLabel,
  sourceSeriesColorMap,
  SOURCE_FALLBACK_COLOR,
  type ComparableMetric,
  type DocumentMeta,
} from "@/lib/metric-source-priority";
import { getIntegration } from "@/lib/integrations/registry";
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
//
// Document series (#533): a metric extracted from two documents stays two DISTINCT
// series (foldSourceSeries keeps document:5 and document:7 apart), so each carries
// the document's OWN label (filename/date/#id) and its own de-collided color rather
// than both collapsing to one "Document" / one teal line.

function labelForSource(
  source: string,
  docs: Record<number, DocumentMeta>
): string {
  if (source === "manual") return "Manual";
  if (documentSourceId(source) != null)
    return documentSourceLabel(source, docs);
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
  // Doc id → filename/date, so a 'document:<id>' series labels by the document's own
  // identity instead of a collapsed "Document" (#533).
  const docMeta: Record<number, DocumentMeta> = {};
  for (const d of getMedicalDocuments(profileId)) {
    docMeta[d.id] = { filename: d.filename, document_date: d.document_date };
  }

  interface RawCard {
    metric: ComparableMetric;
    unit: string;
    raw: MetricSourceSeries[];
  }
  const rawCards: RawCard[] = [];
  for (const metric of COMPARABLE_METRICS) {
    const raw: MetricSourceSeries[] =
      metric.kind === "sample"
        ? getMetricSeriesBySource(profileId, metric.key)
        : metric.kind === "body"
          ? getBodyMetricSeriesBySource(profileId, metric.key as BodyMetricKind)
          : getHrSeriesBySource(profileId);
    if (raw.length < 2) continue; // nothing to compare
    const unit = metric.key === "weight" ? ` ${weightUnit}` : metric.unit;
    rawCards.push({ metric, unit, raw });
  }
  if (rawCards.length === 0) return null;

  // One color per distinct source KEY across every card, so a document keeps the
  // same de-collided color on each metric it appears in and no two documents share
  // the fallback teal (#533).
  const colorByKey = sourceSeriesColorMap(
    rawCards.flatMap((c) => c.raw.map((s) => s.source))
  );
  const cards: ComparisonCard[] = rawCards.map(({ metric, unit, raw }) => ({
    metric,
    unit,
    series: raw.map((s) => ({
      key: s.source,
      label: labelForSource(s.source, docMeta),
      color: colorByKey.get(s.source) ?? SOURCE_FALLBACK_COLOR,
      data: s.data.map((d) => ({
        date: d.date,
        value: displayValue(metric, d.value, weightUnit),
      })),
    })),
    current: priority[metric.key] ?? "",
  }));

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
