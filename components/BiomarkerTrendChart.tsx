"use client";

import BiomarkerChart, { type BiomarkerBands } from "./BiomarkerChart";
import AnnotationToggleBar from "./AnnotationToggleBar";
import { useAnnotationToggles } from "./TrendAnnotationToggles";
import {
  annotationKindsPresent,
  filterAnnotationsByKind,
  type TrendAnnotation,
  type TrendWindow,
} from "@/lib/trend-annotations";

// The per-analyte biomarker chart plus its event-annotation toggle (issue #660).
// The detail chart previously drew reference-range bands only — no life-event
// markers — so "did the statin move my LDL" had nowhere to read. This owns the
// per-type toggle (client) the same way TrendMetricCharts / CompareOverlay do, and
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
  // The biomarker detail page has no context bar, so this resolves to LOCAL state
  // and the bar renders here — unchanged behavior. The hook is used anyway (rather
  // than a private useState) so there is ONE toggle-state implementation across the
  // three chart hosts: a surface that later gains a context bar hoists for free.
  const { enabled, onToggle, hoisted } = useAnnotationToggles(presentKinds);
  const shown = filterAnnotationsByKind(annotations, enabled);
  const shownWindows = enabled.protocol ? windows : [];

  return (
    <div className="space-y-3">
      {!hoisted && presentKinds.length > 0 && (
        <AnnotationToggleBar
          kinds={presentKinds}
          enabled={enabled}
          onToggle={onToggle}
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
