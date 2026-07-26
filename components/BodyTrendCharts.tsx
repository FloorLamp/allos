"use client";

import { useState, type ReactNode } from "react";
import LineChartCard from "./LineChartCard";
import ChartCard from "./ChartCard";
import AnnotationToggleBar from "./AnnotationToggleBar";
import { roundChartValue } from "@/lib/chart-format";
import type { AppRoute } from "@/lib/hrefs";
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
  // The chart's tap-through destination (#1488) — REQUIRED, `null` only with a
  // same-line `detail-none:` justification at the call site. Every registered body
  // metric has one via `metricDetailHref(slug)`; the metric detail page's OWN chart
  // passes null (it is already the detail).
  detailHref: AppRoute | null;
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

// The card's latest-value headline (#1485 B) — part of the header TAP TARGET since
// #1488, so the thing you tap to open the detail page is also the thing that answers
// "what is it now?". Read off the SAME pre-windowed, already-rounded series the plot
// draws (no second computation, #221); null when the window is empty, so the card
// falls back to its title alone rather than printing a "—" that means nothing.
function latestHeadline(chart: BodyChartSpec): string | null {
  for (let i = chart.data.length - 1; i >= 0; i--) {
    const v = chart.data[i].value;
    if (v != null) return `${roundChartValue(v)}${chart.unit}`;
  }
  return null;
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
        <ChartCard
          key={chart.key}
          title={chart.title}
          headline={latestHeadline(chart)}
          note={chart.note}
          anchorId={chart.anchorId}
          testid={chart.testid}
          headerAction={chart.headerAction}
          detailHref={chart.detailHref}
          footer={
            chart.projectionNote ? (
              <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
                {chart.projectionNote}
              </p>
            ) : null
          }
        >
          <LineChartCard
            data={chart.data}
            label={chart.label}
            unit={chart.unit}
            color={chart.color}
            annotations={shown}
            windows={shownWindows}
            referenceValue={chart.referenceValue ?? null}
          />
        </ChartCard>
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
