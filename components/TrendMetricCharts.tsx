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
import {
  isTrendMetricSlug,
  savedMetricIdForTrendSlug,
} from "@/lib/trend-metrics";
import { metricSeriesKey } from "@/lib/saved-items";
import type { DayFillWindow } from "@/lib/day-fill";
import { loneReading, type DayFillSpec } from "@/lib/trend-sparkline";
import SingleReadingMark from "./SingleReadingMark";
import { useFormatPrefs } from "./FormatPrefsProvider";
import { formatMonthDay } from "@/lib/format-date";
import { glanceAgeToken } from "@/lib/glance-age";
import {
  TREND_METRIC_PRESENTATION_FLOORS,
  trendMetricPresentationFreshness,
} from "@/lib/trend-metric-freshness";

// One body-composition trend chart's props (weight / body-fat / resting-HR),
// pre-windowed + in display units by the server section.
export interface TrendChartSpec {
  key: string;
  title: string;
  // Take the card's title (and its latest-value headline) out of the PAINTED header
  // (#1541 fix 3). Both earn their keep on the body census, where several cards stack
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
  // Per-card test hook (the merged body census specs open a specific chart).
  testid?: string;
  // A short caption ABOVE the plot (the acute temperature card's "recent readings
  // only" honesty note, the sun chart's provenance line).
  note?: string | null;
  // A right-aligned affordance in the card header (the temperature card's link
  // across to the illness/fever surface). Server-rendered and passed in, so this
  // component stays the toggle-state owner and nothing else.
  headerAction?: ReactNode;
  // A cross-link rendered UNDER the plot, beside the projection note (the weight
  // card's "Fix a range" entry to the bulk-correction panel, #1603). A footer
  // slot on purpose: the header row is the card's full-width tap target (#1488,
  // pinned by chart-tap-through.spec), so an affordance must not take width from
  // it.
  footerAction?: ReactNode;
  // Axis treatment for a COUNT metric (#1541) — a zero-floored domain and grouped
  // ticks. Composed by lib/trend-metrics' trendMetricChartScale() from the ONE
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

// ONE member of the body census flat ranked stack (#1674).
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
export interface TrendStackItem {
  /** The card id the ranker orders by — also the in-page anchor. */
  id: string;
  /** A windowed trend chart, drawn here so the toggle bar reaches it. */
  chart?: TrendChartSpec;
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
//
// The DAY comes back with it (#2615 item 3). "What is it now?" is a claim about
// currency, and the card was making it over a reading two weeks old with nothing
// attached — so the reading's own day travels beside the number and the header decides
// whether to say it.
function latestHeadline(
  chart: TrendChartSpec
): { text: string; date: string } | null {
  for (let i = chart.data.length - 1; i >= 0; i--) {
    const point = chart.data[i];
    if (point.value != null)
      return {
        text: `${roundChartValue(point.value)}${chart.unit}`,
        date: point.date,
      };
  }
  return null;
}

// The Body section's chart grid. Client-side so a single
// event-annotation toggle bar drives every chart at once: flip "Medications" off
// and the markers vanish from all three. Charts, goal target lines, and projection
// notes are computed server-side; this component only owns the toggle state and
// fans the enabled markers into each LineChartCard.
export default function TrendMetricCharts({
  charts = [],
  items,
  annotations,
  windows = [],
  singleColumn = false,
  gapWindow,
  today,
}: {
  charts?: TrendChartSpec[];
  // The PROFILE-local day (#1186), against which a card decides whether its headline
  // may still be presented as the current value (#2615 item 3). One prop for the whole
  // stack, like `gapWindow`: WHICH floor applies is derived from each card's own key
  // through `TREND_METRIC_PRESENTATION_FLOORS`, so no call site picks a clock. Omitted
  // → no card qualifies its headline, which is the previous behaviour and the right
  // default for a caller with no profile day to measure against.
  today?: string;
  // The selected date range, so every chart in the stack can densify its series to
  // the CALENDAR (#2258) instead of plotting only the days it has rows for. One
  // prop for the whole stack rather than one per spec: WHICH policy each chart
  // follows is derived from its own `key` through the single body-slug ↔ series-key
  // mapping (#1643) and the per-series gap registry, so a card and its tile cannot
  // disagree about whether a missing steps day is a zero. Omitted → no fill (the
  // caller has no window, e.g. a fixed-history card).
  gapWindow?: DayFillWindow;
  // The census's FLAT ranked stack (#1674) — mutually exclusive with `charts` in
  // practice. One toggle bar sits above the whole stack, which is the #1486
  // one-bar rule in its simplest case rather than an exception to it.
  items?: TrendStackItem[];
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
  // The login's date format, for the two places a card names a DAY (the as-of stamp and
  // the one-reading caption). Display prefs belong to the login, never to lib/.
  const formatPrefs = useFormatPrefs();

  // The chart's own gap declaration, resolved from its card id. A non-metric card
  // (growth percentiles, the sleep tile, the intraday `hr-day` swap) maps to no
  // series key and is left alone — its x is not a calendar day at this grain.
  const gapFillFor = (chart: TrendChartSpec): DayFillSpec | undefined => {
    if (!gapWindow || !isTrendMetricSlug(chart.key)) return undefined;
    return {
      seriesKey: metricSeriesKey(savedMetricIdForTrendSlug(chart.key)),
      from: gapWindow.from,
      to: gapWindow.to,
    };
  };

  // The card's headline, plus the as-of stamp when it may no longer be read as the
  // current value (#2615 item 3). The floor is per metric and lives in ONE registry;
  // the verdict is the shared `freshnessState`; the token's colour and hover sentence
  // are the shared glance-age treatment. All this decides is whether a chart card has
  // an occasion to spend a line on the day — which is a layout fact about this header,
  // and the only thing that belongs here.
  //
  // A non-registry card (growth percentiles, the mood chart's node, an intraday swap)
  // declares no floor, so it is left exactly as it was rather than guessed at.
  const headlineFor = (chart: TrendChartSpec): ReactNode => {
    if (chart.hideTitle) return null;
    const latest = latestHeadline(chart);
    if (!latest) return null;
    const slug = isTrendMetricSlug(chart.key) ? chart.key : null;
    const freshness =
      slug && today
        ? trendMetricPresentationFreshness(slug, latest.date, today)
        : "not-applicable";
    if (!slug || !today || freshness !== "due") return latest.text;
    const asOf = glanceAgeToken({
      date: latest.date,
      today,
      freshness,
      form: "as-of",
      floorLabel: TREND_METRIC_PRESENTATION_FLOORS[slug].label,
      dateLabel: formatMonthDay(latest.date, formatPrefs),
    });
    return (
      <span className="flex flex-wrap items-baseline gap-x-1.5">
        {latest.text}
        <span
          data-testid="chart-card-headline-asof"
          className={`text-xs font-normal ${asOf.className}`}
          title={asOf.title ?? undefined}
        >
          {asOf.text}
        </span>
      </span>
    );
  };

  const chartCard = (chart: TrendChartSpec) => {
    // ONE reading is a marker, not a plot (#2615 item 3) — the same degrade the
    // Overview tiles have drawn since #1485 G, over the same predicate, so a tile and
    // the card it taps through to cannot render the identical situation two ways.
    const lone = loneReading(chart.data);
    return (
      <ChartCard
        key={chart.key}
        title={chart.title}
        hideTitle={chart.hideTitle}
        // The detail page's own chart (#1541 fix 3): its <h1> is this title and
        // its subtitle is this headline, ~700px apart on a phone — the #1533
        // double-render shape. Suppressed together, since the card's header row
        // is not even a tap target there (detailHref is null).
        headline={headlineFor(chart)}
        note={chart.note}
        anchorId={chart.anchorId}
        testid={chart.testid}
        headerAction={chart.headerAction}
        detailHref={chart.detailHref}
        footer={
          chart.projectionNote || chart.footerAction ? (
            <>
              {chart.projectionNote && (
                <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
                  {chart.projectionNote}
                </p>
              )}
              {chart.footerAction && (
                <div className="mt-2 flex justify-end">
                  {chart.footerAction}
                </div>
              )}
            </>
          ) : null
        }
      >
        {lone ? (
          <SingleReadingMark
            fill
            color={chart.color}
            testid="chart-card-single-reading"
            readingScope="inside"
            caption={
              <>
                Single reading ·{" "}
                <time dateTime={lone.date}>
                  {formatMonthDay(lone.date, formatPrefs)}
                </time>
              </>
            }
          />
        ) : (
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
            gapFill={gapFillFor(chart)}
          />
        )}
      </ChartCard>
    );
  };

  const grid = (list: TrendChartSpec[]) => (
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
