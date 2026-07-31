"use client";

import { type ReactNode } from "react";
import LineChartCard from "./LineChartCard";
import ChartCard from "./ChartCard";
import AnnotationToggleBar from "./AnnotationToggleBar";
import { useAnnotationToggles } from "./TrendAnnotationToggles";
import { roundChartValue } from "@/lib/chart-format";
import type { AppRoute } from "@/lib/hrefs";
import {
  annotationKindsPresent,
  filterAnnotationsByKind,
  type TrendAnnotation,
  type TrendWindow,
} from "@/lib/trend-annotations";

// One body-composition trend chart's props (weight / body-fat / resting-HR),
// pre-windowed + in display units by the server section.
export interface BodyChartSpec {
  key: string;
  title: string;
  // Take the card's title (and its latest-value headline) out of the PAINTED header
  // (#1541 fix 3). Both earn their keep on the Body tab, where several cards stack
  // and each needs naming; on a SINGLE-chart detail page whose <h1> is the same
  // string and whose subtitle is the same latest value they are pure echo — the
  // #1533 double-render shape, ~700px apart on a phone. The title stays in the
  // document outline (sr-only), so the card is still named for a screen reader.
  hideTitle?: boolean;
  data: { date: string; value: number | null }[];
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
  // Axis treatment for a COUNT metric (#1541) — a zero-floored domain and grouped
  // ticks. Composed by lib/trends-body-metrics' bodyChartScale() from the ONE
  // registry, never re-decided per surface.
  yDomain?: [number | "auto", number | "auto"];
  groupYTicks?: boolean;
  // The chart's tap-through destination (#1488) — REQUIRED, `null` only with a
  // same-line `detail-none:` justification at the call site. Every registered body
  // metric has one via `metricDetailHref(slug)`; the metric detail page's OWN chart
  // passes null (it is already the detail).
  detailHref: AppRoute | null;
  // Reference LINE colour/label already ride `referenceValue`.
}

// ONE member of the body census's flat ranked stack (#1674).
//
// The census used to render TITLED SECTIONS ("Vitals", "Composition") ordered as
// wholes by their best member, with the synced-daily block below them and outside
// the ordering entirely. That made the box structure a SECOND source of truth for
// order, and it contradicted the first one: a clinical card rode into the everyday
// tier inside its box (SpO₂ above steps), steps could not compete at all, and
// #1643's "starred cards render first, contiguously, in saved order" was
// unsatisfiable — three stars in three boxes can only move three boxes.
//
// So the stack is FLAT: every card is a member, ranked by id, and a promotion is
// visible because a promoted card is simply first. A member is either a windowed
// trend chart this component draws (so one toggle bar can fan annotations into it)
// or a server-rendered node that is placed by the same rank (the growth-percentile
// card, the mood chart, the synced daily charts, the 1D intraday swap at `hr-day`).
export interface BodyStackItem {
  /** The card id the ranker orders by — also the in-page anchor. */
  id: string;
  /** A windowed trend chart, drawn here so the toggle bar reaches it. */
  chart?: BodyChartSpec;
  /** A pre-rendered card, placed by the same rank as any chart. */
  node?: ReactNode;
  /** Span both desktop columns (the intraday swap, the growth card, `hr-day`). */
  wide?: boolean;
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
  items,
  annotations,
  windows = [],
  singleColumn = false,
}: {
  charts?: BodyChartSpec[];
  // The census's FLAT ranked stack (#1674) — mutually exclusive with `charts` in
  // practice. One toggle bar sits above the whole stack, which is the #1486
  // one-bar rule in its simplest case rather than an exception to it.
  items?: BodyStackItem[];
  annotations: TrendAnnotation[];
  // Protocol intervention windows (issue #660), shaded across every chart via the
  // same toggle bar as the point annotations.
  windows?: TrendWindow[];
  // A detail surface already devotes its primary content column to one chart.
  // Keep that single chart full-width instead of inheriting the overview's
  // two-up desktop grid and leaving an empty sibling column.
  singleColumn?: boolean;
}) {
  const presentKinds = annotationKindsPresent(annotations, windows);
  // #1493 A: on the Trends hub the ONE pill row lives in the context bar's expanded
  // controls (it was ~60px of standing chrome above the chart stack at 390px), so
  // `hoisted` is true here and the local bar below is skipped. On a surface without
  // that bar the hook falls back to local state and the bar renders as before.
  const { enabled, onToggle, hoisted } = useAnnotationToggles(presentKinds);
  const shown = filterAnnotationsByKind(annotations, enabled);
  const shownWindows = enabled.protocol ? windows : [];

  const chartCard = (chart: BodyChartSpec) => (
    <ChartCard
      key={chart.key}
      title={chart.title}
      hideTitle={chart.hideTitle}
      // The detail page's own chart (#1541 fix 3): its <h1> is this title and
      // its subtitle is this headline, ~700px apart on a phone — the #1533
      // double-render shape. Suppressed together, since the card's header row
      // is not even a tap target there (detailHref is null).
      headline={chart.hideTitle ? null : latestHeadline(chart)}
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
        label={chart.title}
        unit={chart.unit}
        color={chart.color}
        annotations={shown}
        windows={shownWindows}
        referenceValue={chart.referenceValue ?? null}
        yDomain={chart.yDomain}
        groupYTicks={chart.groupYTicks}
      />
    </ChartCard>
  );

  const grid = (list: BodyChartSpec[]) => (
    <div
      className={`grid gap-6 ${
        singleColumn || list.length === 1 ? "" : "lg:grid-cols-2"
      }`}
    >
      {list.map(chartCard)}
    </div>
  );

  return (
    <div className="space-y-4">
      {!hoisted && presentKinds.length > 0 && (
        <AnnotationToggleBar
          kinds={presentKinds}
          enabled={enabled}
          onToggle={onToggle}
        />
      )}

      {items ? (
        // ONE grid for the whole census (#1674): every member sits in rank order,
        // charts and pre-rendered cards alike, so DOM order IS the ranked order
        // and nothing can ride above its rank inside a box.
        <div
          className={`grid gap-6 ${singleColumn ? "" : "lg:grid-cols-2"}`}
          data-testid="body-chart-stack"
        >
          {items.map((item) => (
            <div
              key={item.id}
              className={item.wide && !singleColumn ? "lg:col-span-2" : ""}
              data-testid={`body-stack-item-${item.id}`}
            >
              {item.chart ? chartCard(item.chart) : item.node}
            </div>
          ))}
        </div>
      ) : (
        grid(charts)
      )}
    </div>
  );
}
