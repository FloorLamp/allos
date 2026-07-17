"use client";

import { useState } from "react";
import BiomarkerChart, { type BiomarkerBands } from "./BiomarkerChart";
import AnnotationToggleBar from "./AnnotationToggleBar";
import {
  annotationKindsPresent,
  filterAnnotationsByKind,
  type AnnotationKind,
  type TrendAnnotation,
  type TrendWindow,
} from "@/lib/trend-annotations";

// The per-analyte biomarker chart plus its event-annotation toggle (issue #660).
// The detail chart previously drew reference-range bands only — no life-event
// markers — so "did the statin move my LDL" had nowhere to read. This owns the
// per-type toggle (client) the same way BodyTrendCharts / CompareOverlay do, and
// fans the enabled markers + the targeting protocol's shaded window into the chart.
export default function BiomarkerTrendChart({
  data,
  unit,
  bands,
  annotations,
  windows,
}: {
  data: { date: string; value: number; bound?: "<" | ">" }[];
  unit: string;
  bands: BiomarkerBands;
  annotations: TrendAnnotation[];
  windows: TrendWindow[];
}) {
  const presentKinds = annotationKindsPresent(annotations, windows);
  const [enabled, setEnabled] = useState<Record<AnnotationKind, boolean>>({
    medication: true,
    appointment: true,
    situation: true,
    protocol: true,
  });
  const shown = filterAnnotationsByKind(annotations, enabled);
  const shownWindows = enabled.protocol ? windows : [];

  return (
    <div className="space-y-3">
      {presentKinds.length > 0 && (
        <AnnotationToggleBar
          kinds={presentKinds}
          enabled={enabled}
          onToggle={(kind) => setEnabled((e) => ({ ...e, [kind]: !e[kind] }))}
        />
      )}
      <BiomarkerChart
        data={data}
        unit={unit}
        bands={bands}
        annotations={shown}
        windows={shownWindows}
      />
    </div>
  );
}
