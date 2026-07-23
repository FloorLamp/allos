"use client";

import { MEDICAL_DISCLAIMER } from "@/lib/disclaimers";
import { useState } from "react";
import GrowthChart, {
  type GrowthBand,
  type GrowthPlotPoint,
} from "./GrowthChart";
import { ordinalPercentile } from "@/lib/growth-format";

export interface GrowthMetricView {
  metric: "height" | "weight" | "bmi" | "head_circumference";
  label: string;
  unit: string;
  valueRound: number;
  bands: GrowthBand[];
  points: GrowthPlotPoint[];
  latestPercentile: number | null;
  minMonths: number;
  maxMonths: number;
}

// The growth-chart card for the Body Metrics page: a WHO/CDC percentile chart per
// available anthropometric, with a metric switcher, the current percentile, and
// the required "not medical advice" disclaimer. Only rendered by the server page
// when the profile is in chart range (child with known sex + birthdate).
export default function GrowthChartsCard({
  views,
  currentAgeMonths,
  source,
}: {
  views: GrowthMetricView[];
  currentAgeMonths: number;
  // "WHO" (0–2 y) or "CDC" (2–20 y) — which reference the current age uses.
  source: string;
}) {
  // The selected metric is DERIVED against the current `views`, not just seeded
  // from them (issue #405): switching profiles hands this persistent client
  // component a new `views` prop, and a stale selection (e.g. "head_circumference"
  // from an infant, absent for an older child) would render views[0]'s chart with
  // NO tab highlighted. Fall back to the first view whenever the selection isn't in
  // the current set, so the highlighted tab always matches the chart.
  const [selected, setSelected] = useState<GrowthMetricView["metric"] | null>(
    null
  );
  const active =
    selected != null && views.some((v) => v.metric === selected)
      ? selected
      : (views[0]?.metric ?? null);
  const view = views.find((v) => v.metric === active) ?? views[0];
  if (!view) return null;

  return (
    <div className="card">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold text-slate-800 dark:text-slate-100">
          Growth percentiles
        </h2>
        <div className="flex gap-1 rounded-lg bg-slate-100 p-0.5 dark:bg-slate-800">
          {views.map((v) => (
            <button
              key={v.metric}
              type="button"
              onClick={() => setSelected(v.metric)}
              className={`rounded-md px-2.5 py-1 text-sm font-medium transition ${
                v.metric === active
                  ? "bg-white text-slate-900 shadow-sm dark:bg-slate-700 dark:text-slate-100"
                  : "text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
              }`}
            >
              {v.label}
            </button>
          ))}
        </div>
      </div>

      <p className="mb-3 text-sm text-slate-600 dark:text-slate-300">
        {view.latestPercentile != null ? (
          <>
            Latest {view.label.toLowerCase()} is tracking the{" "}
            <span className="font-semibold text-slate-900 dark:text-slate-100">
              {ordinalPercentile(view.latestPercentile)}
            </span>{" "}
            percentile ({source}).
          </>
        ) : (
          <>No in-range {view.label.toLowerCase()} measurement to score yet.</>
        )}
      </p>

      <GrowthChart
        bands={view.bands}
        points={view.points}
        currentAgeMonths={currentAgeMonths}
        minMonths={view.minMonths}
        maxMonths={view.maxMonths}
        unit={view.unit}
        valueRound={view.valueRound}
      />

      <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
        Reference curves (WHO 0–2 y, CDC 2–20 y). {MEDICAL_DISCLAIMER}
      </p>
    </div>
  );
}
