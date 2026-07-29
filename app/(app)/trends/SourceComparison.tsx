import {
  getBodyMetricSeriesBySource,
  getBodyMetricSeriesBySourceInRange,
  getHrSeriesBySource,
  getHrSeriesBySourceInRange,
  getMetricSeriesBySource,
  getMetricSeriesBySourceInRange,
  getMedicalDocuments,
  type MetricSourceSeries,
} from "@/lib/queries";
import { getMetricSourcePriority } from "@/lib/settings";
import {
  COMPARABLE_METRICS,
  DOCUMENTS_SOURCE_CLASS,
  DOCUMENTS_SOURCE_LABEL,
  documentSourceId,
  documentSourceLabel,
  hasDocumentSeries,
  sourceSeriesColorMap,
  withDocumentsClassSeries,
  SOURCE_FALLBACK_COLOR,
  type ComparableMetric,
  type DocumentMeta,
} from "@/lib/metric-source-priority";
import { getIntegration } from "@/lib/integrations/registry";
import { dispWeight, round } from "@/lib/units";
import type { BodyMetricKind, IntegrationId } from "@/lib/types";
import type { WeightUnit } from "@/lib/settings";
import type { DateRange } from "@/lib/timeline-format";
import type { CompareSeries } from "@/components/SourceCompareChartInner";
import SourceCompareChart from "@/components/SourceCompareChart";
import PrimarySourcePicker from "./PrimarySourcePicker";

// "Compare sources" (issue #14): the per-source overlay and primary-source
// picker for ONE metric detail page. Renders NOTHING for a single-source profile
// — the control only exists when there is genuinely something to compare.
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
  if (source === DOCUMENTS_SOURCE_CLASS) return DOCUMENTS_SOURCE_LABEL;
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

export default function SourceComparison({
  profileId,
  weightUnit,
  metricKey,
  className = "",
  range,
}: {
  profileId: number;
  weightUnit: WeightUnit;
  metricKey: string;
  className?: string;
  range?: DateRange;
}) {
  const metric = COMPARABLE_METRICS.find((entry) => entry.key === metricKey);
  if (!metric) return null;

  const priority = getMetricSourcePriority(profileId);
  // A comparison is about the selected window. Sources with only historical
  // readings outside it stay out of the card and picker; their saved preference
  // remains stored and becomes visible again when the user widens the range.
  const raw: MetricSourceSeries[] = range
    ? metric.kind === "sample"
      ? getMetricSeriesBySourceInRange(
          profileId,
          metric.key,
          range.from ?? null,
          range.to ?? null
        )
      : metric.kind === "body"
        ? getBodyMetricSeriesBySourceInRange(
            profileId,
            metric.key as BodyMetricKind,
            range.from ?? null,
            range.to ?? null
          )
        : getHrSeriesBySourceInRange(
            profileId,
            range.from ?? null,
            range.to ?? null
          )
    : metric.kind === "sample"
      ? getMetricSeriesBySource(profileId, metric.key)
      : metric.kind === "body"
        ? getBodyMetricSeriesBySource(profileId, metric.key as BodyMetricKind)
        : getHrSeriesBySource(profileId);
  if (raw.length < 2) return null;

  // Doc id → filename/date, so a 'document:<id>' series labels by the document's
  // own identity instead of a collapsed "Document" (#533).
  const docMeta: Record<number, DocumentMeta> = {};
  for (const d of getMedicalDocuments(profileId)) {
    docMeta[d.id] = { filename: d.filename, document_date: d.document_date };
  }
  // The aggregated "Documents" class series (#1640) joins its members rather than
  // replacing them: three DEXA reports stay three labeled series AND become one
  // sparse ground-truth line the picker can elect. Its color comes from the same
  // de-colliding document palette (sourceSeriesColorMap), so the family reads as a
  // family while the aggregate stays distinguishable from every member.
  const plotted = withDocumentsClassSeries(raw);
  const colorByKey = sourceSeriesColorMap(plotted.map((entry) => entry.source));
  const unit = metric.key === "weight" ? ` ${weightUnit}` : metric.unit;
  const series: CompareSeries[] = plotted.map((s) => ({
    key: s.source,
    label: labelForSource(s.source, docMeta),
    color: colorByKey.get(s.source) ?? SOURCE_FALLBACK_COLOR,
    data: s.data.map((d) => ({
      date: d.date,
      value: displayValue(metric, d.value, weightUnit),
    })),
  }));
  // Picker options are the plotted series PLUS the Documents class whenever any
  // document reports the metric — with a single report the chart has no separate
  // aggregate line to show (it would overdraw that report exactly), but electing
  // the class is still the right forward-looking choice: the NEXT scan is a new
  // document id, and the class already covers it.
  const options = series.map((s) => ({ value: s.key, label: s.label }));
  if (hasDocumentSeries(raw) && !options.some((o) => o.value === DOCUMENTS_SOURCE_CLASS)) {
    const firstDoc = options.findIndex(
      (o) => documentSourceId(o.value) != null
    );
    options.splice(firstDoc, 0, {
      value: DOCUMENTS_SOURCE_CLASS,
      label: DOCUMENTS_SOURCE_LABEL,
    });
  }
  const configured = priority[metric.key];
  const configuredCurrent = configured?.source ?? "";
  const visibleCurrent = options.some((o) => o.value === configuredCurrent)
    ? configuredCurrent
    : "";

  return (
    <section
      className={`card min-w-0 ${className}`}
      data-testid="source-comparison"
      aria-labelledby={`source-comparison-${metric.key}`}
    >
      <div className="mb-3 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 sm:flex-1">
          <h2
            id={`source-comparison-${metric.key}`}
            className="font-semibold text-slate-800 dark:text-slate-100"
          >
            Compare sources
          </h2>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            Choose which source is authoritative for totals and latest values.
            {range ? " The chart uses the selected range." : ""}
          </p>
        </div>
        <PrimarySourcePicker
          metric={metric.key}
          current={visibleCurrent}
          strict={visibleCurrent !== "" && configured?.strict === true}
          options={options}
        />
      </div>
      <div
        className="mb-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-600 dark:text-slate-300"
        data-testid={`source-legend-${metric.key}`}
      >
        {series.map((s) => (
          <span
            key={s.key}
            className="inline-flex min-w-0 items-center gap-1.5"
          >
            <span
              className="h-2.5 w-2.5 shrink-0 rounded-full"
              style={{ backgroundColor: s.color }}
              aria-hidden
            />
            <span className="truncate">{s.label}</span>
          </span>
        ))}
      </div>
      <div data-testid={`source-compare-${metric.key}`}>
        <SourceCompareChart series={series} unit={unit} showLegend={false} />
      </div>
    </section>
  );
}
