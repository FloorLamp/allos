"use client";

import { useState } from "react";
import CompareChart from "./CompareChart";
import AnnotationToggleBar from "./AnnotationToggleBar";
import {
  annotationKindsPresent,
  filterAnnotationsByKind,
  type AnnotationKind,
  type TrendAnnotation,
} from "@/lib/trend-annotations";

// The Compare tab's overlay chart plus its event-annotation toggle.
// Client-side so the per-type toggle can add/remove the vertical markers
// live; the aligned series + correlation read-out are computed server-side in
// CompareSection and passed straight through to CompareChart.
export default function CompareOverlay({
  data,
  labelA,
  labelB,
  colorA,
  colorB,
  unitA,
  unitB,
  normalized,
  annotations,
}: {
  data: { date: string; a: number | null; b: number | null }[];
  labelA: string;
  labelB: string;
  colorA: string;
  colorB: string;
  unitA: string;
  unitB: string;
  normalized: boolean;
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
    <div className="space-y-3">
      {presentKinds.length > 0 && (
        <AnnotationToggleBar
          kinds={presentKinds}
          enabled={enabled}
          onToggle={(kind) => setEnabled((e) => ({ ...e, [kind]: !e[kind] }))}
        />
      )}
      <CompareChart
        data={data}
        labelA={labelA}
        labelB={labelB}
        colorA={colorA}
        colorB={colorB}
        unitA={unitA}
        unitB={unitB}
        normalized={normalized}
        annotations={shown}
      />
    </div>
  );
}
