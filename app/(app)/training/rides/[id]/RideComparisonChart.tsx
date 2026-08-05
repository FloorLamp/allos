"use client";

import { useState } from "react";
import Link from "next/link";
import { IconChevronRight } from "@tabler/icons-react";
import { useFormatPrefs } from "@/components/FormatPrefsProvider";
import { CYCLING_METRICS } from "@/lib/cycling-metrics";
import { cyclingRideHref, type CyclingLens } from "@/lib/hrefs";
import { roundChartValue } from "@/lib/chart-format";
import { formatLongDate } from "@/lib/format-date";
import type { RideComparisonMetricKey } from "@/lib/ride-detail";

export interface RideComparisonChartMetric {
  key: RideComparisonMetricKey;
  label: string;
  shortLabel: string;
  unit: string;
  decimals: number;
  median: number;
  points: {
    id: number;
    date: string;
    title: string;
    value: number;
    current: boolean;
  }[];
}

const METRIC_COLORS: Record<RideComparisonMetricKey, string> = {
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

export default function RideComparisonChart({
  metrics,
  lens,
}: {
  metrics: RideComparisonChartMetric[];
  lens: CyclingLens | null;
}) {
  const formatPrefs = useFormatPrefs();
  const initialKey = metrics.some((metric) => metric.key === lens?.metric)
    ? (lens?.metric as RideComparisonMetricKey)
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
    <div className="mt-4 min-w-0" data-testid="ride-comparison-chart">
      {metrics.length > 1 ? (
        <div
          className="flex flex-wrap gap-1"
          aria-label="Comparison metric"
          role="group"
          data-testid="ride-comparison-metrics"
        >
          {metrics.map((metric) => {
            const active = metric.key === selected.key;
            return (
              <button
                key={metric.key}
                type="button"
                aria-pressed={active}
                onClick={() => setSelectedKey(metric.key)}
                className={`rounded-full px-3 py-1 text-sm font-medium transition focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-ink-950 ${
                  active
                    ? "bg-brand-600 text-white"
                    : "text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-ink-750"
                }`}
              >
                {metric.shortLabel}
              </button>
            );
          })}
        </div>
      ) : null}

      <div className="mt-3" data-testid="ride-comparison-ranking">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-xs text-slate-500 dark:text-slate-400">
          <span>Rides ranked highest to lowest</span>
          <span data-testid="ride-comparison-range">
            Peer range{" "}
            {formattedValue(peerMin, selected.decimals, selected.unit)}–
            {formattedValue(peerMax, selected.decimals, selected.unit)} · Median{" "}
            {formattedValue(selected.median, selected.decimals, selected.unit)}
          </span>
        </div>

        <ol
          className="max-h-80 space-y-1 overflow-y-auto pr-1"
          aria-label={`${selected.label} across ${points.length} rides`}
        >
          {points.map((point) => {
            const row = (
              <div
                className={`grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 gap-y-0.5 rounded-md px-1 py-1.5 sm:grid-cols-[minmax(6.5rem,1.3fr)_minmax(7rem,2fr)_6.5rem] sm:px-2 ${
                  point.current
                    ? "bg-brand-50 dark:bg-brand-950/30"
                    : "transition hover:bg-slate-50 dark:hover:bg-white/[0.03]"
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
                      ? "This ride"
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
                  data-testid="ride-comparison-track"
                >
                  <span className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-slate-200 dark:bg-ink-700" />
                  <span
                    className="absolute inset-y-0 border-l border-dashed border-slate-400 dark:border-slate-500"
                    style={{ left: `${position(selected.median)}%` }}
                  />
                  <span
                    className={`absolute top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 ${
                      point.current
                        ? "h-3.5 w-3.5 shadow-sm"
                        : "h-2.5 w-2.5 bg-white dark:bg-ink-900"
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
                  {!point.current ? (
                    <IconChevronRight
                      className="h-3.5 w-3.5 text-slate-400"
                      aria-hidden="true"
                    />
                  ) : null}
                </span>
              </div>
            );
            return (
              <li
                key={point.id}
                data-testid="ride-comparison-observation"
                data-current={point.current ? "true" : "false"}
              >
                {point.current ? (
                  row
                ) : (
                  <Link
                    href={
                      lens
                        ? cyclingRideHref(point.id, lens)
                        : `/training/rides/${point.id}`
                    }
                    data-testid="ride-comparison-link"
                    className="block rounded-md focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-ink-950"
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
