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
// one content component drawn twice, not a `hidden md:*` content fork — and since
// #4973 the CHART picks which, from its own container, off `minContainerPx` below.
// These columns are the breakpoint; there is no second set of numbers.

import {
  MIN_LABEL_PX,
  clampLabel,
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
  type IntradayBlock,
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
  /**
   * THE GUTTER, and it is sized by the LONGEST ROW NAME, not by taste.
   *
   * `rowLabel` elides a name that will not fit, so a gutter chosen for "Sleep"
   * and "Train" turned "Practice" (#4852) into `Prac…` — a row name nobody wants
   * and the one thing the ruling forbade. The budget a name gets is
   * `padLeft - labelSize × 0.2`, so the gutter has to hold
   * `INTRADAY_ROW_NAMES`' widest at this variant's own label size. Widening it
   * costs plot width (about 5% compact, 2% wide) and MOVES every x-projection and
   * axis-tick choice on the chart, which is why the number is derived below and
   * guarded in the pure suite rather than nudged by eye.
   */
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

/**
 * EVERY NAME THE GUTTER HAS TO HOLD, in one list because `padLeft` is sized by
 * the widest of them.
 *
 * Kept here rather than inline in the chart so the geometry and the drawing
 * cannot disagree: a fourth row added at the call site alone would be measured
 * by nothing, and the first anybody heard of it would be `Prac…` in the gutter
 * (#4852). The pure suite asserts this list renders whole at both variants, so
 * adding a name here is what makes the gutter's cost visible.
 */
export const INTRADAY_ROW_NAMES = {
  sleep: "Sleep",
  train: "Train",
  practice: "Practice",
} as const;

export const INTRADAY_VARIANTS: Record<IntradayVariant, IntradayVariantSpec> = {
  // Below `sm`. The narrowest container is MEASURED, not assumed: the Timeline
  // day column at a 390px viewport is ~308px once the shell padding, the day's
  // `pl-4` indent and the card padding are taken out (an earlier guess of 320 put
  // the labels at 8.98px — under the floor, and the browser test said so). 300
  // keeps a little headroom. 360 units into a 300–420px container puts the label
  // size at 11 units ≈ 9.2–12.8 real px.
  //
  // padLeft 55: "Practice" is 52.80 units at labelSize 11, and the gutter's own
  // 2.20 of inset makes 55 the narrowest that holds it whole (#4852). 40 held
  // 37.80 and elided it.
  compact: spec("compact", 360, 300, 420, {
    padLeft: 55,
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
  // padLeft 62.5 by the same arithmetic: "Practice" is 60.00 units at 12.5, plus
  // 2.50 of inset. 46 held 43.50 and elided it.
  wide: spec("wide", 720, 520, 760, {
    padLeft: 62.5,
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
  /** Whether any practice session drew a block — its own row since #4852. */
  hasPractice: boolean;
  hasTicks: boolean;
  /** Whether #4918 ruling 7's expected-sleep band is drawing this day (today,
   *  waiting on last night, no session in hand yet). */
  hasExpectedSleep: boolean;
  hrTop: number;
  /** Baseline for the bed/wake time labels, above the sleep band (#1512 A). */
  sleepLabelY: number;
  sleepTop: number;
  /** The Train row: ACTIVITY blocks only since #4852. */
  workTop: number;
  /** The Practice row, directly under Train. Both rows are `workH` tall — the
   *  shape and the colour are the same; only the line differs. */
  practiceTop: number;
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
  const hasExpectedSleep = model.expectedSleep != null;
  const hasWorkouts = model.blocks.some((b) => b.source === "activity");
  const hasPractice = model.blocks.some((b) => b.source === "practice");
  const hasTicks = model.ticks.length > 0;
  // THE ROW RESERVES for a real session OR #4918 ruling 7's expected-sleep band —
  // either one needs the same lane, and the band is drawn there only until a
  // session lands, never beside one (see IntradayModel.expectedSleep). The bed/wake
  // LABELS still get their own strip above the band only for a real session
  // (below) — the expected band draws no bed/wake text of its own.
  const showSleepRow = hasSleep || hasExpectedSleep;
  const sleepLabelH = hasSleep ? base.labelSize + 3 : 0;

  let cursor = base.padTop;
  const hrTop = cursor;
  if (hasHr) cursor += base.hrH + base.rowGap;
  const sleepLabelY = cursor + base.labelSize;
  const sleepTop = cursor + sleepLabelH;
  if (showSleepRow) cursor += sleepLabelH + base.sleepH + base.rowGap;
  const workTop = cursor;
  if (hasWorkouts) cursor += base.workH + base.rowGap;
  const practiceTop = cursor;
  if (hasPractice) cursor += base.workH + base.rowGap;
  const tickTop = cursor;
  if (hasTicks) cursor += base.tickH + base.rowGap;
  // THE EMPTY-DAY FLOOR (#4918's empty-day ruling). A day with none of the five
  // rows above still needs a CANVAS: `daylightBandX` spans from `padTop` to
  // `axisY`, and without this, a rowless day leaves `axisY === padTop` — a
  // zero-height band on the one day the ruling most wants it visible ("the
  // daylight band and the day context draw alone"). Reserved ONLY when nothing
  // else reserved anything: the instant any row exists, its own height already
  // gives the band a canvas, so this can never widen an already-tall chart.
  if (cursor === base.padTop) cursor += base.hrH;
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
    hasPractice,
    hasTicks,
    hasExpectedSleep,
    hrTop,
    sleepLabelY,
    sleepTop,
    workTop,
    practiceTop,
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

/**
 * The top of the row a block draws in: Train for an activity, Practice for a
 * session (#4852). One function so the chart and the pure suite agree on the
 * split without either of them spelling the branch out again.
 */
export function blockRowTop(
  geo: IntradayGeometry,
  block: IntradayBlock
): number {
  return block.source === "practice" ? geo.practiceTop : geo.workTop;
}

// ── Wheel and pinch (issue #4852) ────────────────────────────────────────────

/**
 * The window a zoom by `factor` about `atMinute` produces, or NULL when the
 * gesture changes nothing.
 *
 * `factor` is a SPAN multiplier: < 1 zooms in, > 1 zooms out, so a pinch passes
 * the ratio of its two finger distances directly and a wheel passes a curve of
 * its own `deltaY`. `atMinute` keeps its position in the plot, which is what makes
 * both gestures feel anchored under the pointer rather than under the middle.
 *
 * NULL IS THE WHOLE POINT OF THE RETURN TYPE, and it is a scroll decision, not an
 * error: the caller must let the page have the event, because a chart that
 * swallows a wheel it has no use for is a scroll TRAP in the middle of a long day
 * view. ONE test carries it — the clamped span is unchanged — and the case that
 * matters most falls out of it rather than needing a rule of its own: at the full
 * day the span already IS the day, so widening it clamps straight back and the
 * page keeps the wheel. Zooming IN there still narrows, and is still captured.
 */
export function zoomViewAt(
  view: IntradayView,
  atMinute: number,
  factor: number
): IntradayView | null {
  const span = view.to - view.from;
  if (!(span > 0) || !(factor > 0) || !Number.isFinite(factor)) return null;
  const next = Math.min(
    MINUTES_IN_DAY,
    Math.max(MIN_ZOOM_MINUTES, span * factor)
  );
  if (next === span) return null;
  const at = Math.max(view.from, Math.min(view.to, atMinute));
  const ratio = (at - view.from) / span;
  const from = Math.max(0, Math.min(MINUTES_IN_DAY - next, at - ratio * next));
  return { from, to: from + next };
}

/**
 * The window shifted by `deltaMinutes`, clamped to the day — the horizontal-wheel
 * pan. Null (page keeps the event) when the day is fully visible, so there is
 * nothing to pan, or when the view is already against the edge it is being pushed
 * toward. The SPAN never changes: panning is not a zoom.
 */
export function panView(
  view: IntradayView,
  deltaMinutes: number
): IntradayView | null {
  const span = view.to - view.from;
  if (span >= MINUTES_IN_DAY || !Number.isFinite(deltaMinutes)) return null;
  // Rounded, so a STREAM of wheel events slides the window instead of widening it:
  // the caller's floor/ceil on a fractional edge would add a minute per event.
  const from = Math.round(
    Math.max(0, Math.min(MINUTES_IN_DAY - span, view.from + deltaMinutes))
  );
  if (from === view.from) return null;
  return { from, to: from + span };
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

// ── Background bands (#4918 rulings 3 and 7) ────────────────────────────────

/**
 * The daylight band's clipped x-span, or null when the day carries no solarDay
 * (no home location, polar day/night — DaylightChip's own text line already says
 * the honest thing there) or the band falls entirely outside the visible window.
 *
 * A BACKGROUND band — it reserves no row. `intradayGeometry` never sees
 * `model.solarDay` at all, so adding or removing it cannot move `cursor` or
 * `height`; this answers the x question alone, against the plot geometry that was
 * already decided.
 */
export function daylightBandX(
  geo: IntradayGeometry,
  model: Pick<IntradayModel, "solarDay">
): { left: number; right: number } | null {
  if (!model.solarDay) return null;
  const clipped = clipToView(
    geo,
    model.solarDay.sunriseMin,
    model.solarDay.sunsetMin
  );
  if (!clipped) return null;
  return {
    left: projectMinute(geo, clipped.startMinute),
    right: projectMinute(geo, clipped.endMinute),
  };
}

/**
 * The expected-sleep band's clipped x-span, or null when there is none to draw
 * (see IntradayModel.expectedSleep) or it falls entirely outside the visible
 * window. The caller confines it to the sleep row's own vertical bounds
 * (`geo.sleepTop`/`sleepH`, reserved by `showSleepRow` above) — this answers only
 * the x question, the same split every other span in this module uses.
 */
export function expectedSleepBandX(
  geo: IntradayGeometry,
  model: Pick<IntradayModel, "expectedSleep">
): { left: number; right: number } | null {
  if (!model.expectedSleep) return null;
  const clipped = clipToView(
    geo,
    model.expectedSleep.startMinute,
    model.expectedSleep.endMinute
  );
  if (!clipped) return null;
  return {
    left: projectMinute(geo, clipped.startMinute),
    right: projectMinute(geo, clipped.endMinute),
  };
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

export interface BlockLayout {
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
 * That is the honest arithmetic, and it is why `blockLabels` below places most
 * names BESIDE the block instead (#1512 B says "inside/beside"): a name that only
 * ever renders for a six-hour hike would not have fixed the "a 45-minute run and a
 * 45-minute lift look identical" complaint at all.
 *
 * Nothing is painted past the block's right edge here — that is `elideToWidth`,
 * not a clip path.
 */
export function blockLayout(
  geo: IntradayGeometry,
  block: IntradayBlock
): BlockLayout | null {
  const clipped = clipToView(geo, block.startMinute, block.endMinute);
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
    budget > 0 && textWidth(block.title, geo.labelSize) <= budget
      ? block.title
      : null;
  return {
    key: block.key,
    left,
    width,
    showIcon,
    iconSize,
    text: fits,
    textX,
  };
}

export interface BlockLabel extends PlacedLabel {
  key: string;
  /** `inside` when the block itself held the name; `beside` when it is painted in
   *  the row's free space just past the block's right edge. */
  mode: "inside" | "beside";
}

/**
 * Where every block's NAME goes (#1512 B), as ONE row layout.
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
export function blockLabels(
  geo: IntradayGeometry,
  blocks: readonly IntradayBlock[]
): BlockLabel[] {
  const items: (RowLabelInput & { mode: "inside" | "beside" })[] = [];
  for (const block of blocks) {
    const layout = blockLayout(geo, block);
    if (!layout) continue;
    const inside = layout.text != null;
    const gap = geo.labelSize * 0.35;
    items.push({
      key: block.key,
      mode: inside ? "inside" : "beside",
      x: inside ? layout.textX : layout.left + layout.width + gap,
      text: block.title,
      fontSize: geo.labelSize,
      anchor: "start",
      // Longer session wins a collision, and a name the block itself carries
      // outranks one leaning on shared space.
      priority: block.endMinute - block.startMinute + (inside ? 1e6 : 0),
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
 * A row's name in the left gutter, elided to the gutter rather than painting
 * back over the plot's left edge.
 *
 * The elision is the FALLBACK, not the plan: `padLeft` is sized to hold every
 * `INTRADAY_ROW_NAMES` entry whole at this variant's label size (#4852), and the
 * pure suite fails if one of them comes back shortened. What survives here is the
 * guarantee that nothing paints back over the plot, whatever it is handed.
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
