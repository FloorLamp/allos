"use client";

import { useEffect, useState } from "react";
import type { LabelProps } from "recharts";
import { usePrefersReducedMotion } from "./usePrefersReducedMotion";
import { useHydrated } from "./useHydrated";
import type { ChartColors } from "./useChartColors";

/** recharts' own label-anchor union, re-exported so a caller doesn't reach into
 *  recharts for a type the scaffold already owns. */
export type ChartLabelPosition = NonNullable<LabelProps["position"]>;

// THE chart scaffold chokepoint (issue #1445, Part 4b).
//
// Every `*Inner.tsx` card used to hand-copy the same `<CartesianGrid
// strokeDasharray="3 3">`, the same axis tick object, and the same tooltip
// `contentStyle` block — eight near-identical copies of the recharts defaults.
// That is not a tidiness complaint: it is why the mark-level conventions could
// not be fixed once. A decision made in five call sites regresses in five
// places independently, so #1445's Part 2 decisions live HERE and the cards
// consume them.
//
// Shape: PROP BAGS, not wrapper components. Recharts identifies its children by
// component type, so `<ChartGrid/>` wrapping a `<CartesianGrid/>` is silently
// ignored — the chart renders without a grid. Spreading a prop bag onto the real
// recharts element is the shape that actually works. (`ChartLegend` is a plain
// React component because it renders OUTSIDE the recharts tree.)
//
// `lib/__tests__/chart-scaffold-scan.test.ts` fails CI on a raw
// `strokeDasharray="…"` or tooltip `contentStyle={{` anywhere but here, and on a
// `recharts` import outside the blessed card list. See `docs/internals/charts.md`.

// ── type sizes ──────────────────────────────────────────────────────────────

/** Axis tick text. */
export const CHART_TICK_FONT_SIZE = 11;
/** Annotation / reference-band / axis-title text. The floor: #1445 found 9px
 *  `ReferenceArea` and `ReferenceLine` labels, below legibility. Nothing in a
 *  chart goes under this. */
export const CHART_LABEL_FONT_SIZE = 10;

// ── dash vocabulary ─────────────────────────────────────────────────────────

/** The only dash patterns a chart may use, named by what they MEAN. The grid is
 *  deliberately absent: gridlines are solid hairlines now (a dashed both-axes
 *  grid is the single loudest "default recharts" tell). */
export const chartDash = {
  /** A vertical event marker (medication start, appointment, situation change). */
  annotation: "3 3",
  /** A horizontal reference/goal value. */
  reference: "5 4",
  /** A horizontal target line on a bar chart. */
  target: "4 3",
  /** The "now" marker on a growth chart. */
  now: "4 4",
  /** The hover crosshair. */
  cursor: "3 3",
} as const;

// ── grid + axes (Part 2: recessive scaffolding) ─────────────────────────────

/**
 * Horizontal-only solid hairlines. Vertical gridlines fence the plot into a
 * ledger; the y-gridline is the only one a reader actually traces to a value.
 */
export function chartGridProps(c: ChartColors) {
  return {
    vertical: false,
    stroke: c.grid,
    strokeOpacity: 0.7,
  } as const;
}

/**
 * Axis props: ticks in a text token, no tick marks, no axis spine. The spine and
 * ticks duplicate information the gridlines and labels already carry.
 *
 * `tickFill` overrides the tick color, and exists for exactly one case: a
 * dual-axis chart where the axis serves ONE series. Even there the answer is
 * usually the neutral token — identity belongs to the marks and the legend, and
 * text stays text (see `docs/internals/charts.md`).
 */
export function chartAxisProps(c: ChartColors, tickFill?: string) {
  return {
    tick: { fontSize: CHART_TICK_FONT_SIZE, fill: tickFill ?? c.tick },
    stroke: c.axis,
    tickLine: false,
    axisLine: false,
  } as const;
}

/** An axis TITLE ("Age (years)", a scatter's x/y names). */
export function chartAxisLabelProps(
  c: ChartColors,
  value: string,
  rest: LabelProps = {}
): LabelProps {
  return {
    value,
    fontSize: CHART_LABEL_FONT_SIZE,
    fill: c.tick,
    ...rest,
  };
}

// ── sparkline variant (Part 2, owner-added) ─────────────────────────────────
//
// A mini tile is not a small chart — it is a DIFFERENT chart. `TrendMiniCard`
// reused the full `LineChartCard` at `h-40`, so every Overview tile carried a
// complete X+Y axis: 11px ticks and the margin reservations sized for a 256px-tall
// chart, squeezed into a tile that is ~150px wide on a 390px phone. The ticks
// collided, and the plot — the only part carrying information — got what was left.
//
// The fix is a VARIANT of the same card, not a sixth hand-styled chart: the axes
// still scale the series, they just stop painting themselves (`hide` drops their
// space reservation too), the grid goes, margins go to near-zero, and the numbers
// the axes were there to supply (min / max / latest) are rendered as inline TEXT
// beside the plot, where they are legible at any width. Hover survives — the
// tooltip is how a sparkline reports a single point.

/** Margins for a full-size chart: room for tick labels down the left and along
 *  the bottom. */
export const chartFullMargin = {
  top: 10,
  right: 16,
  bottom: 0,
  left: -8,
} as const;

/** Margins for a sparkline: nothing to reserve room for. The few px that remain
 *  keep the 2px stroke and the hover dot from clipping at the tile's edges. */
export const chartSparklineMargin = {
  top: 4,
  right: 4,
  bottom: 2,
  left: 4,
} as const;

/**
 * Axis props for a sparkline. The axis stays MOUNTED — it still scales the series
 * and still honors an explicit `domain`, which is what keeps a biomarker tile's
 * shared axis-domain policy (#407) working — but `hide` makes recharts' own
 * `CartesianAxis` render nothing at all AND drop its space reservation, so the
 * spine, tick marks and tick labels all go and the plot gets the whole tile.
 */
export function chartSparklineAxisProps() {
  return { hide: true } as const;
}

/**
 * The BAR variant of the sparkline (issue #1485 D) — the mark, not a new chart.
 *
 * A line sparkline asserts continuity between its points. For a per-day QUANTITY
 * that is genuinely zero on the days nothing happened (training volume), that is
 * a false claim and it renders as a sawtooth that reads as noise at tile width.
 * Bars say the true thing: each day is its own column and the gaps are the rest
 * days. Which SERIES get it is `lib/trend-sparkline.ts`; this is what they get.
 *
 * `maxBarSize` keeps a short window (a handful of days over a ~150px tile) from
 * drawing slabs instead of bars, and the small top radius keeps the columns
 * reading as marks rather than as a filled area.
 */
export function chartSparklineBarProps(color: string) {
  return {
    fill: color,
    radius: [1, 1, 0, 0] as [number, number, number, number],
    maxBarSize: 14,
  } as const;
}

/** The hover highlight for a bar sparkline. The full-size bar cursor
 *  (`chartBarCursorProps`) paints a band the height of the plot, which on a 80px
 *  tile swamps the marks; a sparkline gets the same token at a lighter weight. */
export function chartSparklineBarCursorProps(c: ChartColors) {
  return { fill: c.grid, fillOpacity: 0.35 } as const;
}

// ── tooltip ─────────────────────────────────────────────────────────────────

/** The tooltip's own surface, for the handful of cards that render a CUSTOM
 *  tooltip body (a `content` render prop) instead of the default one. */
export function chartTooltipSurfaceStyle(c: ChartColors) {
  return {
    background: c.tooltipBg,
    borderColor: c.tooltipBorder,
    color: c.tooltipText,
  } as const;
}

/** Everything a default recharts `<Tooltip>` needs: surface, type size, and the
 *  hover motion (Part 3c). */
export function chartTooltipProps(c: ChartColors, motion: ChartMotion) {
  return {
    contentStyle: {
      fontSize: 12,
      borderRadius: 8,
      background: c.tooltipBg,
      border: `1px solid ${c.tooltipBorder}`,
      color: c.tooltipText,
      maxWidth: 280,
      whiteSpace: "normal",
    },
    labelStyle: { color: c.tooltipText },
    itemStyle: { color: c.tooltipText },
    isAnimationActive: !motion.reduced,
    animationDuration: motion.hoverDuration,
    animationEasing: "ease-out",
  } as const;
}

/** The hover crosshair on a scatter/line chart. */
export function chartTooltipCursorProps(c: ChartColors) {
  return { stroke: c.axis, strokeDasharray: chartDash.cursor } as const;
}

/** The hover band behind a bar chart's hovered category. */
export function chartBarCursorProps(c: ChartColors) {
  return { fill: c.grid, fillOpacity: 0.5 } as const;
}

// ── marks (Part 2: dots, annotations, stack gaps) ───────────────────────────

/** Above this many points a line's per-point dots stop being data and start
 *  being noise; hover carries the value instead, via a larger `activeDot`. */
export const DENSE_SERIES_POINTS = 30;

/**
 * Per-point dots for a line. Off for dense series; hollow (surface fill,
 * colored stroke) where they stay, so overlapping points stay countable and a
 * dot never reads as a heavier mark than the line it sits on.
 *
 * `enabled: false` is the caller's hard override (an intraday series with ~1440
 * points already passes it).
 */
export function chartLineDot(
  c: ChartColors,
  {
    color,
    pointCount,
    enabled = true,
  }: { color: string; pointCount: number; enabled?: boolean }
) {
  if (!enabled || pointCount > DENSE_SERIES_POINTS) return false as const;
  return {
    r: 3,
    fill: c.surface,
    stroke: color,
    strokeWidth: 1.5,
  } as const;
}

/** The hover dot. Bigger than the resting dot (and present even when resting
 *  dots are off) so a dense line still has a hit target. */
export function chartActiveDot(color: string) {
  return { r: 4, fill: color, stroke: color, strokeWidth: 1 } as const;
}

/** A `ReferenceLine` / `ReferenceArea` label, at or above the legibility floor. */
export function chartAnnotationLabel(
  value: string,
  color: string,
  position: ChartLabelPosition,
  rest: LabelProps = {}
): LabelProps {
  return {
    value,
    position,
    fontSize: CHART_LABEL_FONT_SIZE,
    fill: color,
    ...rest,
  };
}

/**
 * A 2px surface gap between stacked segments, so a stack reads as discrete
 * quantities rather than one fused column. Recharts has no stack-gap prop; a
 * 1px surface-colored stroke on each segment gives 2px between neighbours and
 * disappears against the surface at the stack's outer edges.
 */
export function chartStackSegmentProps(c: ChartColors) {
  return { stroke: c.surface, strokeWidth: 1 } as const;
}

/** recharts' built-in `<Legend>` wrapper (bar charts, which have room for it). */
export const chartLegendWrapperStyle = { fontSize: 12 } as const;

// ── motion (Part 3c) ────────────────────────────────────────────────────────

/** First-mount draw-in. recharts' 1500ms default reads sluggish. */
export const CHART_MOUNT_MS = 400;
/** Hover transitions — active dot, tooltip. */
export const CHART_HOVER_MS = 150;

export interface ChartMotion {
  /** Whether the viewer asked for reduced motion; every duration below is
   *  already zeroed when true, but marks also pass this straight to recharts as
   *  `isAnimationActive={false}`. */
  reduced: boolean;
  /** Spread onto a `<Line>` / `<Bar>` / `<Scatter>`. */
  isAnimationActive: boolean;
  animationDuration: number;
  animationEasing: "ease-out";
  hoverDuration: number;
}

/**
 * Chart motion, decided once. FIRST MOUNT ONLY: recharts replays its draw-in on
 * every data change, so a range or tab switch would re-animate the whole chart —
 * exactly the "motion as decoration" this app doesn't want in a medical context.
 * The flag flips off shortly after the first pass, so subsequent renders snap.
 *
 * Under `prefers-reduced-motion: reduce` the flag never turns on at all: the
 * first render is already `isAnimationActive: false` (the shared hook reads the
 * query after mount, defaulting false, and the phase gate holds animation until
 * the same tick that resolves it), so there is no frame of motion to suppress.
 */
export function useChartMotion(): ChartMotion {
  const reduced = usePrefersReducedMotion();
  const hydrated = useHydrated();
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (!hydrated) return;
    const t = setTimeout(() => setDone(true), CHART_MOUNT_MS + 100);
    return () => clearTimeout(t);
  }, [hydrated]);

  return {
    reduced,
    isAnimationActive: hydrated && !reduced && !done,
    animationDuration: CHART_MOUNT_MS,
    animationEasing: "ease-out",
    hoverDuration: reduced ? 0 : CHART_HOVER_MS,
  };
}

/** Spread onto a mark (`<Line>`, `<Bar>`, `<Scatter>`). */
export function chartMarkMotion(motion: ChartMotion) {
  return {
    isAnimationActive: motion.isAnimationActive,
    animationDuration: motion.animationDuration,
    animationEasing: motion.animationEasing,
  } as const;
}

// ── legend (Part 2: every >= 2-series chart carries one) ────────────────────

export interface ChartLegendItem {
  label: string;
  color: string;
}

/**
 * A compact legend row: a colored dot per series with the label in a TEXT token.
 * Rendered outside the recharts tree (a plain sibling of the chart box), so it
 * survives the code-split and doesn't fight recharts' own layout.
 *
 * Why every >= 2-series chart has one: without it the only identity channel is
 * color, which is a channel roughly 1 in 12 men cannot fully read — and it is
 * how `chartSeries.brand` vs `chartSeries.rose` (ΔE 2.7 under deuteranopia) stays
 * legal at all. The dot carries the color; the LABEL stays in ink, never the
 * series color.
 */
export function ChartLegend({ items }: { items: ChartLegendItem[] }) {
  if (items.length < 2) return null;
  return (
    <ul
      data-testid="chart-legend"
      className="mb-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-600 dark:text-slate-300"
    >
      {items.map((item) => (
        <li
          key={item.label}
          data-testid="chart-legend-item"
          className="flex min-w-0 items-center gap-1.5"
        >
          <span
            aria-hidden="true"
            className="h-2.5 w-2.5 shrink-0 rounded-full"
            style={{ background: item.color }}
          />
          <span className="truncate">{item.label}</span>
        </li>
      ))}
    </ul>
  );
}
