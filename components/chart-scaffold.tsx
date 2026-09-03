"use client";

import { useEffect, useState } from "react";
import { Label, type LabelProps } from "recharts";
import { textWidth } from "@/lib/chart-svg";
import { chartNeutral } from "@/lib/chart-colors";
import {
  CHART_VALUE_AXIS_NICE_TICKS,
  CHART_VALUE_AXIS_TICKS,
} from "@/lib/chart-time-axis";
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
  /** The faint hint joining readings too far apart for the stroke to assert
   *  continuity (#2653 state 5). Finer and airier than every pattern above, so
   *  it reads as less than a line rather than as another kind of line. */
  sparse: "2 5",
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
 * AND THE TICK VALUES ARE A POLICY (#4924). Every card handed recharts an axis
 * with no `tickCount` and no nice-number mode, so the numbers down the side were
 * whatever its default `adaptive` fit produced: 4.75 / 5.7 / 6.65 hours of sleep,
 * 55 / 66 / 77 / 88 / 99 bpm. Those are honest divisions of the data range and
 * nobody reads a chart in ninths. `snap125` snaps the step to 1 / 2 / 2.5 / 5 at
 * each order of magnitude, which is how a person would have chosen it.
 *
 * It applies to whichever axis carries NUMBERS: recharts ignores both props on a
 * category axis, and the date axis takes an explicit tick set instead
 * (`categoryDateTicks`, lib/chart-time-axis.ts).
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
    niceTicks: CHART_VALUE_AXIS_NICE_TICKS,
    tickCount: CHART_VALUE_AXIS_TICKS,
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
    // RENDER ORDER, not alphabetical (#2804). recharts 3 defaults `itemSorter` to
    // `'name'` and LEXICALLY sorts the payload before any formatter runs, which is
    // never what a chart means: percentile bands came out 10th, 25th, 3th, 5th, 50th,
    // a stacked bar's rows stopped matching its stack, and StackedBarCardInner's
    // "only the first entry speaks" formatter keyed on a post-sort index. The series
    // are declared in the order the reader should read them, so that is the order.
    // recharts sorts stably, so a constant key leaves the payload as it arrives; a
    // chart wanting a different order passes its own itemSorter AFTER this spread.
    itemSorter: () => 0,
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

// ── the curve (#4924) ───────────────────────────────────────────────────────

/**
 * The curve EVERY line in this app draws: straight segments between readings.
 *
 * It was `type="monotone"` written out at nine call sites across six cards — a
 * mark decision that never made it into the scaffold, so it could not be fixed
 * once. `curveMonotoneX` invents a smooth path through the points: on a dense
 * daily series that is a harmless smoothing, and on FIVE WEIGH-INS over a
 * quarter it draws a peak between two readings that nobody measured. The chart
 * cannot tell those apart, because the two get the same curve.
 *
 * A straight segment asserts exactly what its two endpoints bound and nothing
 * between them, which is the only claim a line here is entitled to make. The
 * separate #2653 states still say how much to trust the segment (demoted for a
 * thin series, cut at an over-limit hole); this decides its SHAPE, once.
 */
export const chartCurve = "linear" as const;

// ── marks (Part 2: dots, annotations, stack gaps) ───────────────────────────

/** Above this many points a line's per-point dots stop being data and start
 *  being noise; hover carries the value instead, via a larger `activeDot`. */
export const DENSE_SERIES_POINTS = 30;

// ── THE FILL CHANNEL (#2653, owner call 3) ──────────────────────────────────
//
// A dot's FILL means ONE thing app-wide: whether the reading is EXACT.
//
//   • SOLID  — an exact reading. The ordinary case, and the default.
//   • HOLLOW — an inexact BOUNDED reading ("<0.10", ">5"): the assay reported a
//     side of the number, not the number, so the mark is drawn as an outline of
//     a value rather than as one.
//
// It was carrying three meanings by 2026-08. `BiomarkerChartInner` had the one
// above; the scaffold's own default dot was hollow and meant nothing; and #2689's
// sparse demotion had just taken SOLID to mean "the readings are the content".
// Two of those coexisted by accident because they rarely shared a chart. Three
// could not, and the failure would have been silent — a reader seeing a hollow
// dot with no way to know which claim it was making. So the channel was assigned
// once, to inexactness, which is the meaning with clinical stakes.
//
// The two evictees moved to the channel each actually meant:
//   • sparse emphasis → MARK SIZE (`CHART_SPARSE_DOT_R`, below): it was always
//     about mark-vs-stroke prominence, not about the reading being exact.
//   • two sources on one day (#2653 state 6) → paired OFFSET marks
//     (`chartOtherSourceDot`, below).
//
// `lib/__tests__/chart-fill-channel.test.ts` fails on a surface-filled dot
// anywhere but `chartInexactDot`, so the channel cannot silently re-fork.
//
// AND SIZE MEANS PROMINENCE, only prominence (#2831). Three steps, no more:
// ordinary (`CHART_DOT_R`), emphasised (`CHART_SPARSE_DOT_R`), hover
// (`CHART_ACTIVE_DOT_R`). The hollow mark used to sit between the first two on an
// `r: 3` literal it had inherited from the meaningless hollow default it
// replaced — so inexactness rode size as well as fill, on the channel the move
// above had just assigned to prominence. It is drawn at the ordinary radius now:
// hollow is the whole of what it says. The same test file pins that, because the
// lesson of the fill fork is that a meaning rides a channel unnoticed for exactly
// as long as nothing looks.

/** The resting dot's radius, and the size an unemphasised mark is drawn at
 *  whatever else it is saying. */
export const CHART_DOT_R = 2.5;
/** The hover dot's radius. Strictly above every resting radius below. */
export const CHART_ACTIVE_DOT_R = 5;

/**
 * Per-point dots for a line. Off for dense series.
 *
 * SOLID in the series' colour — an ordinary reading is an exact one, and fill is
 * the exactness channel. The 1px SURFACE-COLOURED ring is what keeps overlapping
 * points countable (the same separator trick `chartStackSegmentProps` uses
 * between stacked segments), and the small radius keeps the mark from out-weighing
 * the stroke it sits on.
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
    isolated,
    inexact,
  }: {
    color: string;
    pointCount: number;
    enabled?: boolean;
    // Indices whose stroke is cut on BOTH sides (lib/trend-sparkline's
    // `isolatedReadings`). They draw whatever the density says.
    isolated?: ReadonlySet<number>;
    // Indices whose value is not the whole of what it will be — a bucket the
    // profile's local day is still filling (#4924). They draw HOLLOW, and they
    // draw whatever the density says, because the mark is the claim.
    inexact?: ReadonlySet<number>;
  }
) {
  if (!enabled) return false as const;
  // TWO EXCEPTIONS TO THE CLUTTER RULE, AND THEY ARE THE SAME EXCEPTION (#4924).
  //
  // The density threshold is a CLUTTER rule: above thirty points the dots fuse
  // into a heavy line and the stroke already says where every reading is, so
  // hover carries the value instead. That argument holds for a reading the
  // stroke DRAWS. It collapses for a reading the stroke cannot reach — an
  // isolated reading had no segment and no dot, so a value that exists rendered
  // as nothing at all — and for one whose mark carries a claim the stroke does
  // not make, which is what hollow says. Both keep their marks at any density.
  const dense = pointCount > DENSE_SERIES_POINTS;
  // A series whose marks are all alike takes the PROP BAG, which is the shape
  // recharts renders through its own `<Dot>` — same geometry, and it keeps the
  // `recharts-dot` / `recharts-line-dot` classes specs and stylesheets address.
  // Below the threshold an isolated reading is already drawn, so only an INEXACT
  // point makes the marks differ from each other.
  if (!dense && size(inexact) === 0) return chartExactDot(c, color);
  if (dense && size(isolated) + size(inexact) === 0) return false as const;
  return chartPointDot(c, color, { isolated, inexact, dense });
}

const size = (s?: ReadonlySet<number>) => s?.size ?? 0;

/** The resting mark for an EXACT reading, unconditionally — for the two cards
 *  that draw their own `<circle>` per point and so cannot take a prop bag that
 *  may be `false`. `chartLineDot` is this plus the density threshold. */
export function chartExactDot(c: ChartColors, color: string) {
  return {
    r: CHART_DOT_R,
    fill: color,
    stroke: c.surface,
    strokeWidth: 1,
    // The RESTING-MARK selector, so a spec can count the marks a reader can
    // actually see. recharts' own `.recharts-line-dot` is on the layer whether
    // the mark is a dot or an empty group.
    className: CHART_DOT_CLASS,
  } as const;
}

/** The class every resting mark carries. */
export const CHART_DOT_CLASS = "chart-dot";

/**
 * The dot layer when the marks are not all alike: hollow where the value is not
 * the whole of what it will be, solid where the stroke cannot reach, and nothing
 * at all for a point a dense stroke already draws. A renderer rather than a prop
 * bag because the decision is per POINT, and recharts hands a dot function the
 * point's index.
 */
function chartPointDot(
  c: ChartColors,
  color: string,
  {
    isolated,
    inexact,
    dense,
  }: {
    isolated?: ReadonlySet<number>;
    inexact?: ReadonlySet<number>;
    dense: boolean;
  }
) {
  // What recharts' own `<Dot>` would have put on the circle (`DotItem` merges the
  // Line's `recharts-line-dot` with `recharts-dot`). A per-point RENDERER bypasses
  // that entirely, so the classes are restated here rather than silently dropped:
  // e2e/sleep-page.spec.ts finds the SRI card's marks by `.recharts-dot`, and a
  // selector that stops matching because a mark became conditional is the same
  // regression as the mark disappearing.
  const rechartsDot = "recharts-dot recharts-line-dot";
  const exact = chartExactDot(c, color);
  const hollow = chartInexactDot(c, color);
  return function PointDot({
    cx,
    cy,
    index,
  }: {
    cx?: number | string;
    cy?: number | string;
    index?: number;
  }) {
    if (typeof cx !== "number" || typeof cy !== "number" || index == null) {
      return <g />;
    }
    const mark = inexact?.has(index)
      ? hollow
      : !dense || isolated?.has(index)
        ? exact
        : null;
    if (!mark) return <g />;
    return (
      <circle
        {...mark}
        className={`${rechartsDot} ${mark.className}`}
        cx={cx}
        cy={cy}
      />
    );
  };
}

/**
 * The ONE hollow dot. An inexact bounded reading — the value is known only to lie
 * on one side of the number plotted, so the mark is an outline rather than a
 * filled fact. Nothing else in the app may render a surface-filled dot.
 *
 * At the ORDINARY radius. An inexact reading is not a prominent one, and size is
 * the prominence channel — drawing it bigger said "look at this" alongside the
 * outline, and half a pixel of radius is not a distinction a reader can make
 * without both marks in view at once anyway. Hollow carries the whole claim.
 */
export function chartInexactDot(c: ChartColors, color: string) {
  return {
    r: CHART_DOT_R,
    fill: c.surface,
    stroke: color,
    strokeWidth: 1.5,
    className: CHART_DOT_CLASS,
    "data-inexact": true,
  } as const;
}

// ── PAIRED MARKS: two sources, one day (#2653 state 6) ──────────────────────
//
// A day two sources reported is drawn as TWO marks at one x: the series' own where
// it always sat, and a companion beside it at what the other source said. The PAIR
// is the channel — one mark is one account of the day, two are two — which is what
// owner call 3 left for this state after assigning fill to exactness. The three
// spoken-for channels stay untouched, deliberately: FILL solid (both readings are
// exact; a hollow companion would claim the other source reported a bound), SIZE
// `CHART_DOT_R` (another reading at ordinary weight, neither emphasised nor
// demoted), COLOUR the declared NEUTRAL that docs/internals/charts.md §1 reserves
// for "a bucket that genuinely means other / none" — exactly what a source the
// election did not keep is. A series hue would assert a second series.
//
// The x offset is what keeps the pair legible when the two numbers are close —
// stacked coincident dots are the smudge the issue opened with — and small enough
// that the companion still reads as its own day's rather than the next one's.
//
// NO CONNECTOR between the two marks. A hairline would state a RANGE, and two
// accounts of one day are not a spread around a value; the caption below the plot
// already names what the grey mark is. It would also cost an `ErrorBar` per series
// on every chart in the funnel to buy one day's emphasis.
//
// AND IT DOES NOT REACH `SourceCompareChart`. That surface plots every source as its
// own named, coloured, legended series on purpose — the pair is the glance-level
// answer for a chart showing ONE series, and drawing it there would say twice, in two
// vocabularies, what that chart already says once.

/** How far a companion mark sits from its day's own x, in px. */
export const CHART_PAIR_OFFSET_X = 4;

/**
 * The companion mark for a reading the source election did not keep. A renderer
 * rather than a prop bag because the offset needs the `cx` recharts resolves.
 */
export function chartOtherSourceDot(c: ChartColors) {
  return function OtherSourceDot({
    cx,
    cy,
  }: {
    cx?: number | string;
    cy?: number | string;
  }) {
    if (typeof cx !== "number" || typeof cy !== "number") return <g />;
    return (
      <circle
        cx={cx + CHART_PAIR_OFFSET_X}
        cy={cy}
        r={CHART_DOT_R}
        fill={chartNeutral}
        stroke={c.surface}
        strokeWidth={1}
        data-testid="chart-other-source-dot"
      />
    );
  };
}

/** The hover dot. Bigger than every resting dot (and present even when resting
 *  dots are off) so a dense line still has a hit target, and so hover stays a
 *  visible state change on a series whose resting marks are already emphasised. */
export function chartActiveDot(color: string) {
  return {
    r: CHART_ACTIVE_DOT_R,
    fill: color,
    stroke: color,
    strokeWidth: 1,
  } as const;
}

// ── the demoted stroke (#2653 state 5) ──────────────────────────────────────
//
// A series whose readings sit further apart than its declared continuity span
// (lib/trend-sparkline.ts) is drawn with the DOTS leading and the stroke demoted
// to a hint. Both halves matter: LARGER dots make the facts the heaviest ink on
// the plot, and a thinner, dashed, part-transparent stroke makes the
// interpolation visibly lighter than the facts it joins.
//
// Larger, not filled: the emphasis rides MARK SIZE because fill belongs to
// exactness alone (see the fill channel above). Prominence was what this state
// meant all along — the readings out-weighing the interpolation between them —
// and size says exactly that without borrowing a word that means something else.
//
// THE DEMOTION MUST BE A DEMOTION. The failure mode of a state treatment is that
// it makes the treated chart look deliberate, and therefore MORE trustworthy than
// the confident line it replaced. Nothing here adds ink: the stroke's width and
// opacity are strictly below the normal line's on every axis, and
// `lib/__tests__/sparse-series.test.ts` pins that as an inequality rather than as
// a pair of numbers, so a later tweak cannot quietly turn the hint back into a
// line.

/** The normal line's stroke weight — the thing the demotion is measured against. */
export const CHART_LINE_STROKE_WIDTH = 2;
/** The demoted stroke's weight. Strictly below `CHART_LINE_STROKE_WIDTH`. */
export const CHART_SPARSE_STROKE_WIDTH = 1;
/** The demoted stroke's opacity. Strictly below the normal line's implicit 1. */
export const CHART_SPARSE_STROKE_OPACITY = 0.4;
/** The demoted line's resting dot radius. Strictly ABOVE `CHART_DOT_R` (that is
 *  the demotion — the marks out-weigh the hint joining them) and strictly BELOW
 *  `CHART_ACTIVE_DOT_R`, so hover still reads as a state change. */
export const CHART_SPARSE_DOT_R = 4;

/** Spread onto a `<Line>` whose series is too thin for a confident stroke. */
export function chartSparseLineProps() {
  return {
    strokeWidth: CHART_SPARSE_STROKE_WIDTH,
    strokeDasharray: chartDash.sparse,
    strokeOpacity: CHART_SPARSE_STROKE_OPACITY,
  } as const;
}

/**
 * The resting dot on a demoted line. Same solid fill as any exact reading — it
 * says nothing about exactness, because it may not — and LARGER than the ordinary
 * resting dot, which is the whole claim: on a thin series the readings are the
 * content and the stroke between them is mostly assertion, so the marks carry
 * more ink than the hint does. Still smaller than the hover dot.
 */
export function chartSparseDot(c: ChartColors, color: string) {
  return {
    r: CHART_SPARSE_DOT_R,
    fill: color,
    stroke: c.surface,
    strokeWidth: 1,
  } as const;
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

// ── THE FIT RULE (issue #2871) ──────────────────────────────────────────────
//
// THE DEFECT. A `ReferenceArea` label is drawn whatever the area is worth in
// pixels. On the Sun card an ordinary logging rhythm produced eleven unlogged-run
// bands across a 77-day window, each one narrower than the "N days unlogged" it
// carried, and every one of them centred on the same baseline: the labels printed
// through each other into "10 days unlog3gday3 unlogge7 days unlogged…".
//
// THE RULE (owner decision). A band labels itself only when it can hold the text.
// Below that width the band draws exactly as before and the label is simply
// omitted — no abbreviation, no truncation, no second vocabulary. The fact is not
// lost: the shading IS the absence made visible, and `filterNull={false}` on the
// tooltip means hovering a gap day still answers "No data" (#2258). Only the run
// LENGTH goes unstated, and only where stating it would have been illegible.
//
// WHY IT LIVES HERE and not in the funnel: every annotation that sits INSIDE a
// bounded box has the same question, so the next one inherits the answer.
//
// WHY AN ESTIMATE. SVG text cannot be measured without a DOM, and the decision has
// to be pure to be testable. `textWidth` (lib/chart-svg.ts) is the app's existing
// answer — glyph count × a deliberately generous per-character advance — and it is
// already the width model behind the hand-drawn panels' label placement. Reusing
// it means one estimate app-wide rather than a second, subtly different one.
//
// WHY IT SELF-SCALES. The width compared against is the band's REAL pixel width,
// read from the viewBox recharts computed for that reference area. The same chart
// therefore labels a hole on a wide monitor and stays quiet on a phone, with no
// breakpoint anywhere.

/** Estimated painted width of annotation text, in px at `CHART_LABEL_FONT_SIZE`. */
export function chartAnnotationLabelWidth(value: string): number {
  return textWidth(value, CHART_LABEL_FONT_SIZE);
}

/**
 * Whether a band `bandWidth` px wide can hold `value` as an annotation.
 *
 * An unknown width keeps today's render: a label is dropped because it provably
 * does not fit, never because the geometry could not be read.
 */
export function chartAnnotationLabelFits(
  value: string,
  bandWidth: number | null | undefined
): boolean {
  if (bandWidth == null || !Number.isFinite(bandWidth)) return true;
  return chartAnnotationLabelWidth(value) <= bandWidth;
}

/** The band width recharts computed for this label, when it has one. A polar
 *  viewBox has no width, and neither has a label recharts could not place. */
function labelBandWidth(viewBox: LabelProps["viewBox"]): number | null {
  if (viewBox == null || !("width" in viewBox)) return null;
  return typeof viewBox.width === "number" ? viewBox.width : null;
}

/**
 * `chartAnnotationLabel`, drawn only when the box it sits in can hold it.
 *
 * The band is unaffected — this decides the TEXT alone. `content` is recharts'
 * own hook for a label that needs to see its own geometry: it receives the
 * computed viewBox, and returning null there paints nothing at all (rather than
 * an empty `<text>`), while the fitting case hands straight back to the default
 * label render so a fitted annotation is pixel-identical to an unfitted one.
 */
export function chartFittedAnnotationLabel(
  value: string,
  color: string,
  position: ChartLabelPosition,
  rest: LabelProps = {}
): LabelProps {
  const base = chartAnnotationLabel(value, color, position, rest);
  const FittedAnnotation = (props: LabelProps) =>
    chartAnnotationLabelFits(value, labelBandWidth(props.viewBox)) ? (
      <Label {...props} content={undefined} />
    ) : null;
  return { ...base, content: FittedAnnotation };
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
