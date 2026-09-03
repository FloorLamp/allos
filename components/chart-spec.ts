import type { AnnotationKind } from "@/lib/trend-annotations";

// THE CHART SPEC (#4925).
//
// `components/chart-scaffold.tsx` settled the MARKS: every card spreads the same
// grid, axis, tooltip and dot bags. Nobody owned the TREE. Nine cards each
// hand-built root element, axes, tooltip, grid, series, reference marks and gap
// handling, and the only thing that stopped them drifting was that someone read
// all nine — which is how five copies of one `<XAxis>` and three spellings of
// "draw a horizontal target" survived until #4924 went looking.
//
// So the tree becomes a SPEC and two renderers draw it:
// `TimeSeriesChartInner` for lines, `BarSeriesChartInner` for bars. A new chart
// on a page is a spec; a new chart FORM is a renderer.
//
// WHY THIS FILE HOLDS NO REACT AND NO RECHARTS, which is the constraint that
// shapes everything below. The spec is built by the PUBLIC card — the module a
// server page imports — and recharts is code-split behind the renderer so a page
// that draws no chart loads none of it. A spec carrying a prop bag from
// chart-scaffold, or a render function, would drag recharts back across that
// seam. So a spec says WHICH mark, by name, and the renderer (which is already
// inside the chunk) resolves the name to the scaffold's bag.
//
// It also means the spec is plain data: a card's whole rendered tree can be
// asserted without mounting recharts, and two cards drawing "the same chart"
// can be compared by reading two objects.

// ── the x axis ──────────────────────────────────────────────────────────────
//
// FOUR KINDS, and each is a different question about what x MEANS. The three
// #4925 named are here; `category` is the fourth, and it earns its place on
// ZoneMinutes alone — that axis is WEEKS, so a calendar-day tick policy has
// nothing to say about it.

/** A run of unlogged days, or an explicit declaration that this day series has
 *  none to draw. Required on the day axis: see `ChartXAxis`. */
export type ChartGap =
  | {
      /** The series' `metric:` key — lib/trend-sparkline owns the policy. */
      seriesKey: string;
      /** The over-limit holes to band, already resolved by the card. */
      holes: readonly { from: string; to: string; label: string | null }[];
    }
  /** This day series draws no gap band, and says so rather than being silent. */
  | { none: true };

export type ChartXAxis =
  /**
   * A CATEGORY of ISO days, on the calendar-step tick policy
   * (`chartDayAxisProps`). `gap` is REQUIRED and that is the whole point: a day
   * axis without a gap declaration is a chart that cannot say a day is missing,
   * and #4925 asks for that to be a TYPE error rather than a scan. There is no
   * default — an author must write `{ none: true }` and mean it.
   */
  | {
      kind: "day";
      dates: readonly string[];
      gap: ChartGap;
      tickFormatter?: (v: string) => string;
    }
  /**
   * A NUMERIC axis of instants, where x is proportional to elapsed time (#402):
   * a four-year lab gap renders four years wide. `chartInstantAxisProps`.
   */
  | { kind: "instant"; dates: readonly string[] }
  /**
   * A plain NUMERIC axis that is not time at all — the growth chart's age in
   * months. It has a declared domain and its own tick words ("18m", "1.5y"), and
   * neither of the two above can express it (#4925's ruling, 2026-09-03).
   */
  | {
      kind: "numeric";
      dataKey: string;
      domain: [number, number];
      tickFormatter: (v: number) => string;
      /** An axis TITLE, e.g. "Age (years)". */
      title?: string;
    }
  /**
   * A bare CATEGORY, on recharts' own fit. For an x whose categories are not
   * calendar days — ZoneMinutes plots WEEKS — where a day-step tick policy would
   * be answering a question the axis never asked.
   */
  | {
      kind: "category";
      dataKey: string;
      tickFormatter?: (v: string) => string;
    };

// ── the y axes ──────────────────────────────────────────────────────────────

/** One value axis. A chart declares one, or two when its series genuinely carry
 *  different units (`CompareChart`'s dual axis, #400). */
export interface ChartYAxis {
  /** Set on BOTH axes when there are two; omitted when there is one, because
   *  recharts requires every mark to name an axis id once any axis has one. */
  id?: string;
  orientation?: "right";
  domain?: [number | "auto", number | "auto"];
  /** Exact tick positions, for a chart whose bands carry semantic boundaries. */
  ticks?: number[];
  tickFormatter?: (v: number) => string;
  allowDecimals?: boolean;
  /** A suffix recharts appends to every tick ("  min"). */
  unit?: string;
}

// ── reference marks ─────────────────────────────────────────────────────────
//
// Six named marks, replacing nine hand-written `<ReferenceLine>` /
// `<ReferenceArea>` blocks across five cards. The vocabulary is deliberately
// about MEANING — an event, a window, a silence, a target, a range, "you are
// here" — not about recharts' element names.

/** The label anchors these marks actually use. Narrower than recharts' own union
 *  on purpose: an anchor nothing draws is a decision nobody has made. */
export type ChartMarkLabelPosition =
  | "top"
  | "insideTop"
  | "insideLeft"
  | "insideTopLeft"
  | "insideTopRight"
  | "insideBottomRight";

export type ChartReference =
  /** A vertical event marker — medication, appointment, situation — drawn in the
   *  shared annotation vocabulary, which owns its colour and dash. */
  | { mark: "event"; x: string | number; kind: AnnotationKind }
  /** A shaded span in that same vocabulary: a protocol's intervention window. */
  | {
      mark: "window";
      x1: string | number;
      x2: string | number;
      kind: AnnotationKind;
    }
  /**
   * A run of unlogged days: the absence of plot made visible, in the neutral grid
   * token, carrying its own class so "is a protocol shaded here?" is never
   * answered by a silence. `label` is null where the band is too narrow to hold
   * its count, or where the run is the live trailing one whose words are the
   * caption's.
   */
  | { mark: "unlogged"; x1: string; x2: string; label: string | null }
  /** "You are here" on the x axis — the current ride, the child's age today. */
  | { mark: "now"; x: string | number; label: string; color: string }
  /** A horizontal target LINE: "reach this". */
  | {
      mark: "target";
      y: number;
      color: string;
      dash: "reference" | "target";
      width?: number;
      label?: string;
      labelPosition: ChartMarkLabelPosition;
      labelFontSize?: number;
    }
  /** A horizontal context BAND: "stay inside this". A range target, a reference
   *  interval, a training zone. */
  | {
      mark: "band";
      y1: number;
      y2: number;
      color: string;
      fillOpacity: number;
      strokeOpacity?: number;
      label?: string;
      labelColor?: string;
      labelPosition?: ChartMarkLabelPosition;
    };

// ── marks on a series ───────────────────────────────────────────────────────

/**
 * WHICH resting mark a series draws, by name. Every arm is a decision already
 * made somewhere in `chart-scaffold.tsx`; naming them here is what lets a card
 * choose one without importing recharts.
 */
export type ChartDots =
  | { policy: "none" }
  /** The shared clutter threshold, plus the two exceptions to it (#4924): a
   *  reading no stroke reaches, and one whose value is not yet whole. */
  | {
      policy: "density";
      color: string;
      pointCount: number;
      enabled?: boolean;
      isolated?: ReadonlySet<number>;
      inexact?: ReadonlySet<number>;
    }
  /** A demoted stroke's dots, which lead (#2653 state 5). */
  | { policy: "sparse"; color: string }
  /** An exact reading at every point, unconditionally. */
  | { policy: "exact"; color: string }
  /**
   * Exact or hollow per point, at EVERY point whatever the density says — a lab
   * series, where the readings are the whole of the content and a bounded assay
   * result ("<0.10") must show that it is one.
   */
  | { policy: "bounded"; color: string; inexact: ReadonlySet<number> }
  /** The companion mark for a reading the source election did not keep. */
  | { policy: "other-source" }
  /**
   * A label at one end of a reference curve, instead of a mark at every point —
   * the growth chart's percentile numbers, which are its legend.
   */
  | { policy: "curve-end-label"; label: string; atIndex: number };

// ── series ──────────────────────────────────────────────────────────────────

export interface ChartLineSeries {
  key: string;
  /** The stroke colour, or null for a strokeless line that carries only marks
   *  and the tooltip (a cut series' values, a companion column). */
  color: string | null;
  /** The tooltip/legend name, when it differs from the key. */
  name?: string;
  yAxisId?: string;
  strokeWidth?: number;
  /** The demoted stroke of a sparse series: thin, dashed, low opacity. */
  sparseStroke?: boolean;
  dots: ChartDots;
  activeDot?: string;
  connectNulls: boolean;
  /** Keep this line out of the legend and out of the tooltip — a per-run stroke
   *  is a fragment of one series, not a series. */
  silent?: boolean;
  /** Bands never animate: they are reference material, not the reading. */
  animate?: boolean;
}

/** The low–high spread band under an aggregated mean line (#1938). */
export interface ChartAreaSeries {
  key: string;
  color: string;
  fillOpacity: number;
  connectNulls: boolean;
}

export interface ChartBarSeries {
  key: string;
  name?: string;
  color: string;
  stackId?: string;
}

// ── the tooltip ─────────────────────────────────────────────────────────────

export interface ChartTooltip {
  /**
   * One payload row → its `[value, name]` pair, or null to DROP the row. Null is
   * load-bearing: a gap day is blank under every stacked key, and four "No data"
   * rows would be four ways of saying one thing.
   */
  row: (
    value: unknown,
    name: string,
    payload: Record<string, unknown> | undefined,
    index: number
  ) => [string, string | undefined] | null;
  /** The hovered x, as a sentence. */
  label?: (x: string) => string;
  /** Nulls must REACH `row` for a chart whose holes are on the axis (#2258);
   *  recharts drops them by default, which renders an unlabelled empty box. */
  filterNull?: boolean;
  /** A chart wanting an order other than the declared one (growth's percentiles
   *  read numerically, not in render order). */
  order?: (dataKey: unknown) => number;
  /** Recharts animates the tooltip's transform between points. A chart with
   *  labelled horizontal bands can force an edge flip that crosses the card. */
  animate?: boolean;
  cursor?: "bar" | "sparkline-bar";
}

// ── the frame ───────────────────────────────────────────────────────────────

export interface ChartLegendEntry {
  label: string;
  color: string;
}

export interface ChartFrame {
  /** The plot box's classes — the card's declared height and its layout. */
  boxClass: string;
  /** The height class alone, for the loading and offline placeholders, so a
   *  chunk fetch does not jump the layout by 100px (#407). */
  heightClass: string;
  /** `data-*` the surface's specs address the box by. */
  data?: Readonly<Record<string, string>>;
}

// ── the two specs ───────────────────────────────────────────────────────────

export interface TimeSeriesSpec {
  frame: ChartFrame;
  rows: readonly Record<string, unknown>[];
  x: ChartXAxis;
  y: readonly [ChartYAxis] | readonly [ChartYAxis, ChartYAxis];
  lines: readonly ChartLineSeries[];
  areas?: readonly ChartAreaSeries[];
  references?: readonly ChartReference[];
  tooltip: ChartTooltip;
  /**
   * A mini tile is a DIFFERENT chart, not a small one (#1445): the axes stop
   * painting themselves and stop reserving space, the grid goes, the margins go
   * to near-zero, and the numbers the axes carried are the caller's inline text.
   */
  sparkline?: boolean;
  /** A legend ABOVE the plot, outside the recharts tree, so identity is never
   *  colour-alone and it survives the code split. Every >= 2-series chart has
   *  one: colour is a channel roughly 1 in 12 men cannot fully read. */
  legend?: readonly ChartLegendEntry[];
  /** Charts sharing an id share hover position (the paired sleep + mood panels). */
  syncId?: string;
  syncMethod?: "index" | "value";
  onActiveLabelChange?: (label: string | null) => void;
}

export interface BarSeriesSpec {
  frame: ChartFrame;
  rows: readonly Record<string, unknown>[];
  x: ChartXAxis;
  y: readonly [ChartYAxis];
  bars: readonly ChartBarSeries[];
  references?: readonly ChartReference[];
  tooltip: ChartTooltip;
  /** recharts' own `<Legend>`, INSIDE the tree and below the plot — where the
   *  stacked cards have always drawn theirs. */
  legend?: boolean;
  sparkline?: boolean;
}
