// GEOMETRY for the Timeline day view's intraday panel — the pure layer between
// `buildIntradayModel` (what the day IS) and `components/IntradayPanel.tsx` (which
// only draws). Issues #1512 (legibility), #1518 (the size floor), #1515 (zoom).
//
// Why this module exists at all: three consumers now need the SAME projection.
// The server SVG draws it, the client scrub layer reads a value at a pointer x
// through it, and a zoomed window reprojects it. A second copy of `x(minute)` in
// the overlay would be a second chart that happens to line up today — so the
// projection, the row stack, the axis-tick choice and the label placement are one
// computation with three readers (#221).
//
// THE VARIANTS (#1512 F). A fixed viewBox scaled to `width: 100%` renders its text
// at `fontSize × (container ÷ viewBox)`, so one geometry cannot serve a 358 px
// phone and a 1700 px desktop: at 720 units the panel's 7-unit labels painted
// ~3.5 px on a phone and ~17 px on a wide monitor. Two variants whose boxes are
// close to their containers keep the ratio near 1, and each variant's label size
// is COMPUTED from its own scale (`viewBoxFontSize`) rather than typed in — the
// panel cannot drift below the floor #1518's guard enforces, because it reads the
// floor. Both variants carry a max width for the same reason: an uncapped box in
// the app's 110rem shell would scale its type back up out of the band.
//
// Only the geometry differs between variants. The MODEL is identical, so this is
// a variant prop over one content component, not a `hidden md:*` content fork.

import {
  MIN_LABEL_PX,
  clampLabel,
  elideToWidth,
  placeRowLabels,
  textWidth,
  viewBoxFontSize,
  type PlacedLabel,
  type RowLabelInput,
} from "./chart-svg";
import {
  MINUTES_IN_DAY,
  type IntradayHrPoint,
  type IntradayModel,
  type IntradaySleepBlock,
  type IntradayWorkoutBlock,
} from "./intraday";

export type IntradayVariant = "compact" | "wide";

export interface IntradayVariantSpec {
  variant: IntradayVariant;
  /** The viewBox width, in user units. */
  viewBoxWidth: number;
  /** The narrowest container this variant renders into — the size floor's divisor. */
  minContainerPx: number;
  /** The widest it is allowed to grow to, so the type stays in band. */
  maxWidthPx: number;
  /** Every label in the panel, in user units. Computed, never typed in. */
  labelSize: number;
  padLeft: number;
  padRight: number;
  padTop: number;
  hrH: number;
  sleepH: number;
  workH: number;
  tickH: number;
  rowGap: number;
  axisH: number;
}

function spec(
  variant: IntradayVariant,
  viewBoxWidth: number,
  minContainerPx: number,
  maxWidthPx: number,
  rows: Omit<
    IntradayVariantSpec,
    "variant" | "viewBoxWidth" | "minContainerPx" | "maxWidthPx" | "labelSize"
  >
): IntradayVariantSpec {
  return {
    variant,
    viewBoxWidth,
    minContainerPx,
    maxWidthPx,
    labelSize: viewBoxFontSize({ viewBoxWidth, minContainerPx }),
    ...rows,
  };
}

export const INTRADAY_VARIANTS: Record<IntradayVariant, IntradayVariantSpec> = {
  // Below `sm`. 360 units into a 320–420 px container: the label size lands at
  // 10.5 units ≈ 9.4–12.3 real px.
  compact: spec("compact", 360, 320, 420, {
    padLeft: 40,
    padRight: 10,
    padTop: 6,
    hrH: 92,
    sleepH: 16,
    workH: 20,
    tickH: 18,
    rowGap: 8,
    axisH: 20,
  }),
  // `sm` and up. 720 units into a 520–760 px container: 12.5 units ≈ 9.0–13.2 px.
  wide: spec("wide", 720, 520, 760, {
    padLeft: 46,
    padRight: 14,
    padTop: 6,
    hrH: 96,
    sleepH: 18,
    workH: 22,
    tickH: 20,
    rowGap: 9,
    axisH: 22,
  }),
};

/** The visible minute window. The base chart is the whole day; #1515's zoom
 *  narrows it without touching the model. */
export interface IntradayView {
  from: number;
  to: number;
}

export const FULL_DAY_VIEW: IntradayView = { from: 0, to: MINUTES_IN_DAY };

/** The narrowest window a zoom may select. Below this the axis ticks collapse and
 *  a drag-select becomes an accidental tap. */
export const MIN_ZOOM_MINUTES = 10;

export interface IntradayGeometry extends IntradayVariantSpec {
  height: number;
  plotLeft: number;
  plotRight: number;
  plotW: number;
  /** Which layers this day actually has — a missing layer reserves no strip. */
  hasHr: boolean;
  hasSleep: boolean;
  hasWorkouts: boolean;
  hasTicks: boolean;
  hrTop: number;
  /** Baseline for the bed/wake time labels, above the sleep band (#1512 A). */
  sleepLabelY: number;
  sleepTop: number;
  workTop: number;
  tickTop: number;
  axisY: number;
  /** The HR value axis, padded so the line never touches the frame. */
  hrLo: number;
  hrHi: number;
  view: IntradayView;
}

/**
 * The whole panel's geometry for one variant and one visible window.
 *
 * Rows COLLAPSE when their layer is absent (an HR-only day reserves no empty
 * sleep strip), which is also the honest answer to #1512's partial-day question:
 * a day with heart rate and nothing else renders a heart-rate chart, not a mostly
 * empty frame with orphaned row labels.
 */
export function intradayGeometry(
  model: IntradayModel,
  variant: IntradayVariant,
  view: IntradayView = FULL_DAY_VIEW
): IntradayGeometry {
  const base = INTRADAY_VARIANTS[variant];
  const hasHr = model.hr != null;
  const hasSleep = model.sleep.length > 0;
  const hasWorkouts = model.workouts.length > 0;
  const hasTicks = model.ticks.length > 0;
  // The bed/wake labels get their own strip above the band: painting them inside
  // it would sit them on the stage sub-bands, and painting them below would cross
  // the workout row.
  const sleepLabelH = hasSleep ? base.labelSize + 3 : 0;

  let cursor = base.padTop;
  const hrTop = cursor;
  if (hasHr) cursor += base.hrH + base.rowGap;
  const sleepLabelY = cursor + base.labelSize;
  const sleepTop = cursor + sleepLabelH;
  if (hasSleep) cursor += sleepLabelH + base.sleepH + base.rowGap;
  const workTop = cursor;
  if (hasWorkouts) cursor += base.workH + base.rowGap;
  const tickTop = cursor;
  if (hasTicks) cursor += base.tickH + base.rowGap;
  const axisY = cursor;

  const hr = model.hr;
  const hrLo = hr ? Math.max(0, Math.floor(hr.min) - 5) : 0;
  const hrHi = hr ? Math.ceil(hr.max) + 5 : 1;

  const from = Math.max(
    0,
    Math.min(MINUTES_IN_DAY - MIN_ZOOM_MINUTES, view.from)
  );
  const to = Math.min(
    MINUTES_IN_DAY,
    Math.max(from + MIN_ZOOM_MINUTES, view.to)
  );

  return {
    ...base,
    height: axisY + base.axisH,
    plotLeft: base.padLeft,
    plotRight: base.viewBoxWidth - base.padRight,
    plotW: base.viewBoxWidth - base.padLeft - base.padRight,
    hasHr,
    hasSleep,
    hasWorkouts,
    hasTicks,
    hrTop,
    sleepLabelY,
    sleepTop,
    workTop,
    tickTop,
    axisY,
    hrLo,
    hrHi,
    view: { from, to },
  };
}

/** Minute → x, clamped to the visible window. */
export function projectMinute(geo: IntradayGeometry, minute: number): number {
  const { from, to } = geo.view;
  const span = to - from || 1;
  const clamped = Math.max(from, Math.min(to, minute));
  return geo.plotLeft + ((clamped - from) / span) * geo.plotW;
}

/** x → minute. The scrub layer's inverse of `projectMinute` (#1515 B). */
export function minuteAtX(geo: IntradayGeometry, x: number): number {
  const { from, to } = geo.view;
  const span = to - from || 1;
  const ratio = (x - geo.plotLeft) / (geo.plotW || 1);
  return Math.max(from, Math.min(to, from + ratio * span));
}

/** bpm → y on the HR row. */
export function projectBpm(geo: IntradayGeometry, bpm: number): number {
  const span = geo.hrHi - geo.hrLo || 1;
  const clamped = Math.max(geo.hrLo, Math.min(geo.hrHi, bpm));
  return geo.hrTop + (1 - (clamped - geo.hrLo) / span) * geo.hrH;
}

/** Whether a minute is inside the visible window (a zoomed chart draws nothing
 *  outside it — no marks leaking past the axis). */
export function inView(geo: IntradayGeometry, minute: number): boolean {
  return minute >= geo.view.from && minute <= geo.view.to;
}

/**
 * HR segments trimmed to the visible window.
 *
 * Necessary because `projectMinute` CLAMPS: without trimming, a point at 03:00
 * inside a 08:00–08:45 zoom would paint on the left edge and the line would run
 * flat along the frame — a measured value where there is none. A point that falls
 * outside is dropped, and a run that ends up split by the trim becomes two
 * segments, exactly like a wear gap.
 */
export function clipSegmentsToView(
  geo: IntradayGeometry,
  segments: readonly IntradayHrPoint[][]
): IntradayHrPoint[][] {
  const out: IntradayHrPoint[][] = [];
  for (const segment of segments) {
    let run: IntradayHrPoint[] = [];
    for (const point of segment) {
      if (inView(geo, point.minute)) {
        run.push(point);
      } else if (run.length > 0) {
        out.push(run);
        run = [];
      }
    }
    if (run.length > 0) out.push(run);
  }
  return out;
}

/** A span clipped to the visible window, or null when it falls entirely outside. */
export function clipToView(
  geo: IntradayGeometry,
  startMinute: number,
  endMinute: number
): { startMinute: number; endMinute: number } | null {
  const start = Math.max(geo.view.from, startMinute);
  const end = Math.min(geo.view.to, endMinute);
  if (!(end > start)) return null;
  return { startMinute: start, endMinute: end };
}

// ── Axis ─────────────────────────────────────────────────────────────────────

// Clock-friendly steps only: an axis at 07:00 / 11:48 / 16:36 is arithmetically
// even and humanly useless. Every step divides an hour or is a whole number of
// hours, so every tick lands on a readable time.
const AXIS_STEPS = [1, 2, 5, 10, 15, 20, 30, 60, 120, 180, 360, 720] as const;

/**
 * The visible window's clock ticks: the finest step from the ladder whose labels
 * still FIT, capped at 9 so a wide plot doesn't grow a ruler.
 *
 * The width budget is why the compact variant gets 6-hour ticks where the wide
 * one gets 3-hour ticks (#1512 F, "fewer axis ticks to suit the width") — the
 * same computation, a different plot width, no second constant to keep in sync.
 */
export function axisTicks(
  geo: IntradayGeometry,
  sampleLabel = "00:00"
): number[] {
  const perLabel = textWidth(sampleLabel, geo.labelSize) + geo.labelSize;
  const fits = Math.max(2, Math.floor(geo.plotW / Math.max(1, perLabel)) + 1);
  const maxTicks = Math.min(9, fits);
  const span = geo.view.to - geo.view.from;
  const step =
    AXIS_STEPS.find((s) => Math.floor(span / s) + 1 <= maxTicks) ??
    AXIS_STEPS[AXIS_STEPS.length - 1];
  const out: number[] = [];
  for (
    let m = Math.ceil(geo.view.from / step) * step;
    m <= geo.view.to;
    m += step
  ) {
    out.push(m);
  }
  return out;
}

// ── Labels ───────────────────────────────────────────────────────────────────

export interface SleepEdgeLabel extends PlacedLabel {
  key: string;
  blockKey: string;
  edge: "bed" | "wake";
  minute: number;
}

/**
 * Bed and wake times at the sleep block's edges (#1512 A) — the single
 * most-asked question of a day chart, which until now lived only in an SVG
 * `<title>` that a touch device never shows.
 *
 * A CLIPPED edge gets no label: a session that bleeds in from yesterday has no
 * meaningful "bed time" inside this day, and stamping midnight on it would be an
 * invented fact. Overlapping labels are dropped rather than smeared (#1573), and
 * the longer session wins a collision — on a night split by a wake-up, the main
 * sleep's edges are the ones worth reading.
 */
export function sleepEdgeLabels(
  geo: IntradayGeometry,
  blocks: readonly IntradaySleepBlock[],
  format: (minute: number) => string
): SleepEdgeLabel[] {
  const items: {
    key: string;
    blockKey: string;
    edge: "bed" | "wake";
    minute: number;
    x: number;
    text: string;
    fontSize: number;
    anchor: "start" | "end";
    priority: number;
  }[] = [];
  for (const block of blocks) {
    const duration = block.endMinute - block.startMinute;
    if (!block.clippedStart && inView(geo, block.startMinute)) {
      items.push({
        key: `${block.key}:bed`,
        blockKey: block.key,
        edge: "bed",
        minute: block.startMinute,
        x: projectMinute(geo, block.startMinute),
        text: format(block.startMinute),
        fontSize: geo.labelSize,
        anchor: "start",
        priority: duration,
      });
    }
    if (!block.clippedEnd && inView(geo, block.endMinute)) {
      items.push({
        key: `${block.key}:wake`,
        blockKey: block.key,
        edge: "wake",
        minute: block.endMinute,
        x: projectMinute(geo, block.endMinute),
        text: format(block.endMinute),
        fontSize: geo.labelSize,
        anchor: "end",
        priority: duration,
      });
    }
  }
  const placed = placeRowLabels(items, {
    left: geo.plotLeft,
    right: geo.plotRight,
    minGap: geo.labelSize * 0.5,
  });
  return items.flatMap((item) => {
    const label = placed.get(item.key);
    return label
      ? [
          {
            ...label,
            key: item.key,
            blockKey: item.blockKey,
            edge: item.edge,
            minute: item.minute,
          },
        ]
      : [];
  });
}

export interface WorkoutBlockLayout {
  key: string;
  left: number;
  width: number;
  /** Whether the type glyph fits at all. */
  showIcon: boolean;
  iconSize: number;
  /** The block's name, elided to the space beside the glyph — null when the
   *  block is too short to carry any of it (icon-only fallback). */
  text: string | null;
  textX: number;
}

/**
 * The block's own rectangle, its glyph, and whether its name fits INSIDE it.
 *
 * Almost nothing does. A one-hour session is 1/24th of a 24-hour axis — about 27
 * user units of a 660-unit plot — which holds a 13-unit icon and not much else.
 * That is the honest arithmetic, and it is why `workoutLabels` below places most
 * names BESIDE the block instead (#1512 B says "inside/beside"): a name that only
 * ever renders for a six-hour hike would not have fixed the "a 45-minute run and a
 * 45-minute lift look identical" complaint at all.
 *
 * Nothing is painted past the block's right edge here — that is `elideToWidth`,
 * not a clip path.
 */
export function workoutBlockLayout(
  geo: IntradayGeometry,
  workout: IntradayWorkoutBlock
): WorkoutBlockLayout | null {
  const clipped = clipToView(geo, workout.startMinute, workout.endMinute);
  if (!clipped) return null;
  const left = projectMinute(geo, clipped.startMinute);
  const width = Math.max(
    geo.labelSize * 0.25,
    projectMinute(geo, clipped.endMinute) - left
  );
  const iconSize = Math.min(geo.workH - 6, geo.labelSize + 1);
  const iconPad = iconSize * 0.25;
  const showIcon = width >= iconSize + iconPad * 2;
  const textX = left + (showIcon ? iconPad + iconSize + iconPad : iconPad);
  const budget = left + width - iconPad - textX;
  // Inside only when the WHOLE name fits: an elided name inside a narrow block
  // ("Mor…") is less informative than the same name painted in full beside it.
  const fits =
    budget > 0 && textWidth(workout.title, geo.labelSize) <= budget
      ? workout.title
      : null;
  return {
    key: workout.key,
    left,
    width,
    showIcon,
    iconSize,
    text: fits,
    textX,
  };
}

export interface WorkoutLabel extends PlacedLabel {
  key: string;
  /** `inside` when the block itself held the name; `beside` when it is painted in
   *  the row's free space just past the block's right edge. */
  mode: "inside" | "beside";
}

/**
 * Where every workout block's NAME goes (#1512 B), as ONE row layout.
 *
 * A 45-minute run and a 45-minute lift are identical rectangles until something
 * names them, and the name only reached the SVG `<title>` — a touch dead end.
 * But a session is a sliver of a 24-hour axis, so "inside the block" is available
 * to almost no real session; the name goes BESIDE the block, in the row's own free
 * space, whenever the block cannot hold it.
 *
 * Because those labels then share one baseline, they are subject to the same
 * collision rule as every other label row (#1573): the LONGER session wins, and a
 * name that would overlap a kept one is dropped rather than smeared. The block,
 * its glyph and its `<title>` are still there — only the redundant text goes.
 */
export function workoutLabels(
  geo: IntradayGeometry,
  workouts: readonly IntradayWorkoutBlock[]
): WorkoutLabel[] {
  const items: (RowLabelInput & { mode: "inside" | "beside" })[] = [];
  for (const workout of workouts) {
    const layout = workoutBlockLayout(geo, workout);
    if (!layout) continue;
    const inside = layout.text != null;
    const gap = geo.labelSize * 0.35;
    items.push({
      key: workout.key,
      mode: inside ? "inside" : "beside",
      x: inside ? layout.textX : layout.left + layout.width + gap,
      text: workout.title,
      fontSize: geo.labelSize,
      anchor: "start",
      // Longer session wins a collision, and a name the block itself carries
      // outranks one leaning on shared space.
      priority: workout.endMinute - workout.startMinute + (inside ? 1e6 : 0),
    });
  }
  const placed = placeRowLabels(items, {
    left: geo.plotLeft,
    right: geo.plotRight,
    minGap: geo.labelSize * 0.4,
  });
  return items.flatMap((item) => {
    const label = placed.get(item.key);
    return label ? [{ ...label, key: item.key, mode: item.mode }] : [];
  });
}

/** The HR row's value labels, right-aligned into the left gutter. */
export function hrAxisLabels(
  geo: IntradayGeometry
): { text: string; x: number; y: number }[] {
  if (!geo.hasHr) return [];
  const x = geo.plotLeft - geo.labelSize * 0.35;
  return [
    { text: String(geo.hrHi), x, y: geo.hrTop + geo.labelSize * 0.8 },
    { text: String(geo.hrLo), x, y: geo.hrTop + geo.hrH },
  ];
}

/**
 * A row's name in the left gutter ("Sleep", "Train", "Meds"), elided to the
 * gutter rather than painting back over the plot's left edge.
 */
export function rowLabel(
  geo: IntradayGeometry,
  text: string
): PlacedLabel | null {
  return clampLabel({
    x: geo.plotLeft - geo.labelSize * 0.35,
    text,
    fontSize: geo.labelSize,
    anchor: "end",
    left: 0,
    right: geo.plotLeft - geo.labelSize * 0.2,
  });
}

// ── Reading a value (issue #1515) ────────────────────────────────────────────

/**
 * The HR sample nearest `minute`, or null when the nearest one is further away
 * than `tolerance` — a scrub over a wear GAP must report "no reading", never the
 * value from the other side of the gap.
 */
export function nearestHrPoint(
  segments: readonly IntradayHrPoint[][],
  minute: number,
  tolerance: number
): IntradayHrPoint | null {
  let best: IntradayHrPoint | null = null;
  let bestGap = Infinity;
  for (const segment of segments) {
    for (const point of segment) {
      const gap = Math.abs(point.minute - minute);
      if (gap < bestGap) {
        bestGap = gap;
        best = point;
      }
    }
  }
  return best != null && bestGap <= tolerance ? best : null;
}

/**
 * Where a bpm sits against the profile's Zone 2 band — the third field of the
 * scrub readout (time · bpm · zone).
 *
 * Coarse ON PURPOSE: the model carries the Zone 2 band and nothing else, and
 * inventing five zone edges out of one band would be a fabricated fact. Null when
 * the profile has no resolvable max HR, so the readout drops the field rather
 * than guessing (data-gated like every other layer).
 */
export function zone2Position(
  bpm: number,
  zone2: { low: number; high: number } | null
): "below Zone 2" | "Zone 2" | "above Zone 2" | null {
  if (!zone2) return null;
  if (bpm < zone2.low) return "below Zone 2";
  if (bpm > zone2.high) return "above Zone 2";
  return "Zone 2";
}

// ── The per-minute window (issue #1515 D) ────────────────────────────────────

/**
 * The widest window the per-minute endpoint will serve: 6 h ⇒ ≤ 360 points.
 *
 * Per-minute detail is NOT shipped for the whole day, and the reason belongs in
 * the code so a later change doesn't "improve" this into 1440 points:
 *
 *   1. SUB-PIXEL. The plot is ~680 user units for 1440 minutes — 0.47 units per
 *      minute, i.e. 2–4 samples per device pixel at the rendered width. Per-minute
 *      detail is invisible at 24-hour zoom and the client would have to downsample
 *      it again just to draw the line.
 *   2. NOTHING IS HIDDEN. Each 5-minute point already carries lo/hi from the
 *      per-minute bpm_min/bpm_max and the panel draws that envelope as a band, so
 *      a one-minute spike shows as band height. It is averaged in the line, not
 *      erased from the chart.
 *
 * Per-minute earns its keep only when zoomed: 45 minutes across the same plot is
 * ~15 units per minute, where intervals and recovery become legible. A wider zoom
 * simply keeps the 5-minute series, which is all the pixels can resolve anyway.
 */
export const MAX_FINE_WINDOW_MINUTES = 360;

/**
 * The requested window, clamped to the day and to the server's cap. Null when the
 * request names no usable window at all — the caller answers 400 rather than
 * silently serving something else.
 *
 * Clamping (not rejecting) an over-wide range is deliberate: the client asks for
 * what it is showing, and the honest server answer to "too wide" is the widest
 * window it will serve, not an error the chart would have to special-case.
 */
export function clampFineWindow(
  from: number,
  to: number
): { from: number; to: number } | null {
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  const start = Math.max(0, Math.min(MINUTES_IN_DAY, Math.floor(from)));
  const end = Math.max(0, Math.min(MINUTES_IN_DAY, Math.ceil(to)));
  if (!(end > start)) return null;
  return { from: start, to: Math.min(end, start + MAX_FINE_WINDOW_MINUTES) };
}

/** Whether a window is narrow enough to be worth per-minute detail at all. */
export function wantsFineDetail(view: IntradayView): boolean {
  return view.to - view.from <= MAX_FINE_WINDOW_MINUTES;
}

/** The effective CSS size of the panel's labels at a given container width —
 *  what the browser test asserts, and what `MIN_LABEL_PX` bounds from below. */
export function intradayLabelPx(
  variant: IntradayVariant,
  containerPx: number
): number {
  const base = INTRADAY_VARIANTS[variant];
  return (base.labelSize * containerPx) / base.viewBoxWidth;
}

/** Every variant clears the floor at its own narrowest container. Asserted in
 *  the pure suite; exported so the panel can state the contract it holds. */
export const INTRADAY_LABEL_FLOOR_PX = MIN_LABEL_PX;
