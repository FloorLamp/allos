"use client";

import CompareChart from "./CompareChart";
import AnnotationToggleBar from "./AnnotationToggleBar";
import { useAnnotationToggles } from "./TrendAnnotationToggles";
import {
  annotationKindsPresent,
  filterAnnotationsByKind,
  type TrendAnnotation,
  type TrendWindow,
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
  windows,
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
  // Protocol intervention windows (issue #660), shaded on the overlay via the same
  // toggle bar as the point annotations.
  windows?: TrendWindow[];
}) {
  const presentKinds = annotationKindsPresent(annotations, windows ?? []);
  // #1493 A: on the Trends hub the pill row is rendered ONCE, in the context bar's
  // expanded controls, so it stops costing ~60px of standing chrome above the
  // overlay; `hoisted` says so. On a surface with no context bar to hoist into the
  // hook falls back to local state and this renders its own bar exactly as before.
  const { enabled, onToggle, hoisted } = useAnnotationToggles(presentKinds);
  const shown = filterAnnotationsByKind(annotations, enabled);
  const shownWindows = enabled.protocol ? (windows ?? []) : [];

  return (
    <div className="space-y-3">
      {!hoisted && presentKinds.length > 0 && (
        <AnnotationToggleBar
          kinds={presentKinds}
          enabled={enabled}
          onToggle={onToggle}
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
        windows={shownWindows}
      />
    </div>
  );
}
