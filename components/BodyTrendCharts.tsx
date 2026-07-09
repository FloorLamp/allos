"use client";

import { useState } from "react";
import LineChartCard from "./LineChartCard";
import AnnotationToggleBar from "./AnnotationToggleBar";
import {
  annotationKindsPresent,
  filterAnnotationsByKind,
  type AnnotationKind,
  type TrendAnnotation,
} from "@/lib/trend-annotations";

// One body-composition trend chart's props (weight / body-fat / resting-HR),
// pre-windowed + in display units by the server section.
export interface BodyChartSpec {
  key: string;
  title: string;
  data: { date: string; value: number | null }[];
  label: string;
  unit: string;
  color: string;
  // A goal's target line (already in this chart's display unit), when the metric
  // has an active goal with a target value.
  referenceValue?: { value: number; label?: string; color?: string } | null;
  // A one-line goal-projection caption ("at current pace you reach 80 kg ~3 weeks
  // early"), composed server-side with the right unit; null when no projection.
  projectionNote?: string | null;
}

// The Body section's chart grid (issue #212, Phase 3). Client-side so a single
// event-annotation toggle bar drives every chart at once: flip "Medications" off
// and the markers vanish from all three. Charts, goal target lines, and projection
// notes are computed server-side; this component only owns the toggle state and
// fans the enabled markers into each LineChartCard.
export default function BodyTrendCharts({
  charts,
  annotations,
}: {
  charts: BodyChartSpec[];
  annotations: TrendAnnotation[];
}) {
  const presentKinds = annotationKindsPresent(annotations);
  const [enabled, setEnabled] = useState<Record<AnnotationKind, boolean>>({
    medication: true,
    appointment: true,
    situation: true,
  });
  const shown = filterAnnotationsByKind(annotations, enabled);

  return (
    <div className="space-y-4">
      {presentKinds.length > 0 && (
        <AnnotationToggleBar
          kinds={presentKinds}
          enabled={enabled}
          onToggle={(kind) => setEnabled((e) => ({ ...e, [kind]: !e[kind] }))}
        />
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        {charts.map((chart) => (
          <div key={chart.key} className="card">
            <h2 className="mb-3 font-semibold text-slate-800 dark:text-slate-100">
              {chart.title}
            </h2>
            <LineChartCard
              data={chart.data}
              label={chart.label}
              unit={chart.unit}
              color={chart.color}
              annotations={shown}
              referenceValue={chart.referenceValue ?? null}
            />
            {chart.projectionNote && (
              <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
                {chart.projectionNote}
              </p>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
