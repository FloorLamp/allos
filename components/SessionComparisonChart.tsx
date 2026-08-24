"use client";

import { useState } from "react";
import Link from "next/link";
import { IconChevronRight } from "@tabler/icons-react";
import { useFormatPrefs } from "@/components/FormatPrefsProvider";
import { CYCLING_METRICS } from "@/lib/cycling-metrics";
import { roundChartValue } from "@/lib/chart-format";
import { formatLongDate } from "@/lib/format-date";
import type { SessionComparisonMetricKey } from "@/lib/session-detail";
import type { SessionComparisonMetricView } from "@/lib/session-comparison-view";

const METRIC_COLORS: Record<SessionComparisonMetricKey, string> = {
  speed: CYCLING_METRICS.speed.color,
  heart_rate: CYCLING_METRICS.heart_rate.color,
  power: CYCLING_METRICS.power.color,
  weighted_power: CYCLING_METRICS.weighted_power.color,
  cadence: CYCLING_METRICS.cadence.color,
  elevation: CYCLING_METRICS.elevation.color,
  relative_effort: CYCLING_METRICS.relative_effort.color,
};

function formattedValue(value: number, decimals: number, unit: string): string {
  return `${roundChartValue(value, decimals)}${unit}`;
}

export default function SessionComparisonChart({
  metrics,
  initialMetric,
  noun = "sessions",
  singularNoun = "session",
  testIdPrefix = "session-comparison",
}: {
  metrics: SessionComparisonMetricView[];
  initialMetric?: SessionComparisonMetricKey | null;
  noun?: string;
  singularNoun?: string;
  testIdPrefix?: string;
}) {
  const formatPrefs = useFormatPrefs();
  const initialKey = metrics.some((metric) => metric.key === initialMetric)
    ? initialMetric
    : metrics[0]?.key;
  const [selectedKey, setSelectedKey] = useState(initialKey);
  const selected =
    metrics.find((metric) => metric.key === selectedKey) ?? metrics[0];
  if (!selected) return null;

  const points = [...selected.points].sort(
    (a, b) => b.value - a.value || b.date.localeCompare(a.date) || b.id - a.id
  );
  const values = [...points.map((point) => point.value), selected.median];
  const rawMin = Math.min(...values);
  const rawMax = Math.max(...values);
  const spread = rawMax - rawMin;
  const padding =
    spread > 0 ? spread * 0.08 : Math.max(Math.abs(rawMax) * 0.05, 1);
  const domainMin = Math.max(0, rawMin - padding);
  const domainMax = rawMax + padding;
  const domainSpan = domainMax - domainMin || 1;
  const position = (value: number) =>
    Math.max(0, Math.min(100, ((value - domainMin) / domainSpan) * 100));
  const peerValues = points
    .filter((point) => !point.current)
    .map((point) => point.value);
  const peerMin = Math.min(...peerValues);
  const peerMax = Math.max(...peerValues);
  const color = METRIC_COLORS[selected.key];

  return (
    <div className="mt-4 min-w-0" data-testid={`${testIdPrefix}-chart`}>
      {metrics.length > 1 && (
        <div
          className="flex flex-wrap gap-1"
          aria-label="Comparison metric"
          role="group"
          data-testid={`${testIdPrefix}-metrics`}
        >
          {metrics.map((metric) => {
            const active = metric.key === selected.key;
            return (
              <button
                key={metric.key}
                type="button"
                aria-pressed={active}
                onClick={() => setSelectedKey(metric.key)}
                className="chip chip-filter"
              >
                {metric.shortLabel}
              </button>
            );
          })}
        </div>
      )}

      <div className="mt-3" data-testid={`${testIdPrefix}-ranking`}>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-xs text-slate-500 dark:text-slate-400">
          <span>{noun} ranked highest to lowest</span>
          <span data-testid={`${testIdPrefix}-range`}>
            Peer range{" "}
            {formattedValue(peerMin, selected.decimals, selected.unit)}–
            {formattedValue(peerMax, selected.decimals, selected.unit)} · Median{" "}
            {formattedValue(selected.median, selected.decimals, selected.unit)}
          </span>
        </div>
        <ol
          className="max-h-80 space-y-1 overflow-y-auto pr-1"
          aria-label={`${selected.label} across ${points.length} ${noun}`}
        >
          {points.map((point) => {
            const row = (
              <div
                className={`grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 gap-y-0.5 rounded-md px-1 py-1.5 sm:grid-cols-[minmax(6.5rem,1.3fr)_minmax(7rem,2fr)_6.5rem] sm:px-2 ${
                  point.current
                    ? "bg-brand-50 dark:bg-brand-950/30"
                    : "transition hover:bg-slate-50 dark:hover:bg-white/3"
                }`}
              >
                <div className="min-w-0">
                  <p
                    className={`truncate text-xs ${
                      point.current
                        ? "font-semibold text-brand-800 dark:text-brand-200"
                        : "font-medium text-slate-700 dark:text-slate-200"
                    }`}
                  >
                    {point.current
                      ? `This ${singularNoun}`
                      : formatLongDate(point.date, formatPrefs, {
                          year: "always",
                        })}
                  </p>
                  <p
                    className="truncate text-xs text-slate-500 dark:text-slate-400"
                    title={point.title}
                  >
                    {point.title}
                  </p>
                </div>
                <div
                  className="relative col-span-2 row-start-2 h-5 sm:col-span-1 sm:col-start-2 sm:row-start-1 sm:h-6"
                  aria-hidden="true"
                  data-testid={`${testIdPrefix}-track`}
                >
                  <span className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-slate-200 dark:bg-ink-700" />
                  <span
                    className="absolute inset-y-0 border-l border-dashed border-slate-400 dark:border-slate-500"
                    style={{ left: `${position(selected.median)}%` }}
                  />
                  <span
                    className={`absolute top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 ${
                      point.current
                        ? "h-3.5 w-3.5 shadow-xs"
                        : "h-2.5 w-2.5 bg-surface"
                    }`}
                    style={{
                      left: `${position(point.value)}%`,
                      borderColor: color,
                      backgroundColor: point.current ? color : undefined,
                    }}
                  />
                </div>
                <span
                  className={`col-start-2 row-start-1 flex items-center justify-end gap-1 whitespace-nowrap text-right text-xs tabular-nums sm:col-start-3 ${
                    point.current
                      ? "font-semibold text-brand-800 dark:text-brand-200"
                      : "text-slate-600 dark:text-slate-300"
                  }`}
                >
                  {formattedValue(
                    point.value,
                    selected.decimals,
                    selected.unit
                  )}
                  {!point.current && (
                    <IconChevronRight
                      className="h-3.5 w-3.5 text-slate-400"
                      aria-hidden="true"
                    />
                  )}
                </span>
              </div>
            );
            return (
              <li
                key={point.id}
                data-testid={`${testIdPrefix}-observation`}
                data-current={point.current ? "true" : "false"}
              >
                {point.current ? (
                  row
                ) : (
                  <Link
                    href={point.href}
                    data-testid={`${testIdPrefix}-link`}
                    className="block rounded-md focus:outline-hidden focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-ink-950"
                    aria-label={`Open ${point.title} from ${formatLongDate(
                      point.date,
                      formatPrefs,
                      { year: "always" }
                    )}`}
                  >
                    {row}
                  </Link>
                )}
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}
