"use client";

import { useState, type ReactNode } from "react";
import LineChartCard from "./LineChartCard";
import AnnotationToggleBar from "./AnnotationToggleBar";
import {
  annotationKindsPresent,
  filterAnnotationsByKind,
  type AnnotationKind,
  type TrendAnnotation,
  type TrendWindow,
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
  // Stable in-page anchor for the jump chips (#1067). Defaults to no id.
  anchorId?: string;
  // Per-card test hook (the merged Body tab's specs open a specific chart).
  testid?: string;
  // A short caption ABOVE the plot (the acute temperature card's "recent readings
  // only" honesty note, the sun chart's provenance line).
  note?: string | null;
  // A right-aligned affordance in the card header (the temperature card's link
  // across to the illness/fever surface). Server-rendered and passed in, so this
  // component stays the toggle-state owner and nothing else.
  headerAction?: ReactNode;
  // Reference LINE colour/label already ride `referenceValue`.
}

// A titled run of charts inside one stack (#1486). The merged Body tab renders TWO
// — "Vitals" then "Composition" — and they must share ONE annotation toggle bar:
// two bars for one decision ("show medication markers") is exactly the duplicated
// control the merge exists to remove. Sections are the reason this component takes
// groups at all; a single-group caller still passes plain `charts`.
export interface BodyChartSection {
  id: string;
  heading: string;
  description?: string;
  charts: BodyChartSpec[];
  // Server-rendered cards that belong to this section but aren't plain trend charts
  // (the intraday 1D swap, the acute temperature card). Rendered AFTER the grid.
  after?: ReactNode;
  // Rendered when the section has no charts and no `after` content.
  empty?: ReactNode;
}

// The Body section's chart grid. Client-side so a single
// event-annotation toggle bar drives every chart at once: flip "Medications" off
// and the markers vanish from all three. Charts, goal target lines, and projection
// notes are computed server-side; this component only owns the toggle state and
// fans the enabled markers into each LineChartCard.
export default function BodyTrendCharts({
  charts = [],
  sections,
  annotations,
  windows = [],
}: {
  charts?: BodyChartSpec[];
  // The merged Body tab's grouped form (#1486) — mutually exclusive with `charts`
  // in practice; when present, ONE toggle bar sits above every section.
  sections?: BodyChartSection[];
  annotations: TrendAnnotation[];
  // Protocol intervention windows (issue #660), shaded across every chart via the
  // same toggle bar as the point annotations.
  windows?: TrendWindow[];
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

  const grid = (list: BodyChartSpec[]) => (
    <div className="grid gap-6 lg:grid-cols-2">
      {list.map((chart) => (
        <div
          key={chart.key}
          id={chart.anchorId}
          data-testid={chart.testid}
          className={chart.anchorId ? "card scroll-mt-28" : "card"}
        >
          <div className="mb-3 flex items-center justify-between gap-2">
            <h2 className="font-semibold text-slate-800 dark:text-slate-100">
              {chart.title}
            </h2>
            {chart.headerAction}
          </div>
          {chart.note && (
            <p className="mb-3 text-xs text-slate-500 dark:text-slate-400">
              {chart.note}
            </p>
          )}
          <LineChartCard
            data={chart.data}
            label={chart.label}
            unit={chart.unit}
            color={chart.color}
            annotations={shown}
            windows={shownWindows}
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
  );

  return (
    <div className="space-y-4">
      {presentKinds.length > 0 && (
        <AnnotationToggleBar
          kinds={presentKinds}
          enabled={enabled}
          onToggle={(kind) => setEnabled((e) => ({ ...e, [kind]: !e[kind] }))}
        />
      )}

      {sections
        ? sections.map((section) => (
            <section
              key={section.id}
              id={section.id}
              className="scroll-mt-28 space-y-4"
              data-testid={`body-section-${section.id}`}
            >
              <div>
                <h2 className="text-lg font-semibold text-slate-800 dark:text-slate-100">
                  {section.heading}
                </h2>
                {section.description && (
                  <p className="text-sm text-slate-500 dark:text-slate-400">
                    {section.description}
                  </p>
                )}
              </div>
              {section.charts.length > 0 && grid(section.charts)}
              {section.after}
              {section.charts.length === 0 && !section.after && section.empty}
            </section>
          ))
        : grid(charts)}
    </div>
  );
}
