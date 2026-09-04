"use client";

// One variant of the Timeline day chart: the hand-drawn SVG (issue #1068) plus
// the scrub + zoom interaction layer (#1515), over the pure geometry in
// `lib/intraday-layout.ts`. Every decision — downsampling, clipping, layer gating,
// row stacking, label placement, axis steps, the window clamp — already happened
// in `lib/`; this file maps a placement to an element and a gesture to a window.
//
// WHY THIS IS A CLIENT COMPONENT, AND WHAT THAT DOESN'T COST. #1515's constraint
// was never "no JS" — it was NO LOADING BOX on a glance surface rendered every day
// view, which is what `dynamic(ssr: false)` + `ChartLoading` costs the recharts
// cards. A "use client" component still renders on the SERVER: the complete chart
// is in the first HTML byte, the `<a href="#…">` tick and block anchors work
// before hydration, and there is no chart library in the bundle. What hydration
// adds is the crosshair, the keyboard cursor and the zoom — additive, every one of
// them, and a failed enhancement leaves the drawn chart exactly as it was.
//
// Zoom is EPHEMERAL client state: no route param, no history entry. Reload or back
// returns to the full day.

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import ActivityIcon from "@/components/ActivityIcon";
import { chartDash } from "@/components/chart-scaffold";
import { useResettableState } from "@/components/useResettableState";
import {
  chartBand,
  chartNeutral,
  chartSeries,
  chartSleepStage,
} from "@/lib/chart-colors";
import { ZONE_COLORS } from "@/lib/training-zones";
import { formatClockValue, type DisplayFormatPrefs } from "@/lib/format-date";
import {
  MINUTES_IN_DAY,
  splitHrSegments,
  type IntradayHrPoint,
  type IntradayModel,
  type IntradayTick,
  type SleepStage,
} from "@/lib/intraday";
import {
  FULL_DAY_VIEW,
  MIN_ZOOM_MINUTES,
  axisTicks,
  clipSegmentsToView,
  daylightBandX,
  expectedSleepBandX,
  hrAxisLabels,
  INTRADAY_ROW_NAMES,
  intradayGeometry,
  minuteAtX,
  nearestHrPoint,
  panView,
  projectBpm,
  projectMinute,
  rowLabel,
  sleepEdgeLabels,
  wantsFineDetail,
  blockLabels,
  blockLayout,
  blockRowTop,
  zone2Position,
  zoomViewAt,
  type IntradayGeometry,
  type IntradayVariant,
  type IntradayView,
} from "@/lib/intraday-layout";

// Tick color by the event's tone (`TimelineEvent["tone"]`, carried onto the tick by
// lib/intraday.ts from the SAME resolved event set the day's list is built from).
// This is now that field's ONLY renderer: the feed card this comment used to point at
// was `/timeline`'s `EventCard`, deleted with the route in #3958 phase 2c. The record's
// rows do not colour by tone — a one-line row's colour budget is spent on the title
// link — so a flagged temperature reads red on the axis and plain in the list.
const TONE_COLOR: Record<NonNullable<IntradayTick["tone"]>, string> = {
  default: chartNeutral,
  good: chartSeries.brand,
  warn: chartSeries.amber,
  bad: chartSeries.rose,
};

// Sleep stage sub-band shades come from the shared palette (chartSleepStage) — the
// one place a stage color is allowed to live.
const STAGE_COLOR: Record<SleepStage, string> = chartSleepStage;

// At per-minute resolution a three-minute hole is a real gap, not the 15-minute
// wear gap the 5-minute series is segmented on.
const FINE_GAP_MINUTES = 2;

// Padding around an activity block when tapping it selects its window, so the
// warm-up before and the recovery after are inside the zoom.
const BLOCK_ZOOM_PAD_MINUTES = 5;

// Wheel → span multiplier (#4852). One mouse notch is ~100 deltaY units, so
// e^(100 × 0.0025) ≈ 1.28: a bit over a quarter of the window per notch, the same
// curve in both directions because it is an exponential.
const WHEEL_ZOOM_RATE = 0.0025;

// A wheel event states its own UNITS. Firefox reports lines (and, on a page-scroll
// key, pages) rather than pixels; without this a line-mode notch (deltaY 3) would
// move the window by a third of a percent and read as a dead wheel.
const WHEEL_LINE_PX = 16;
const WHEEL_PAGE_PX = 400;
function wheelPixels(delta: number, deltaMode: number): number {
  if (deltaMode === 1) return delta * WHEEL_LINE_PX;
  if (deltaMode === 2) return delta * WHEEL_PAGE_PX;
  return delta;
}

function hhmm(minute: number): string {
  const m = Math.max(0, Math.min(MINUTES_IN_DAY - 1, Math.round(minute)));
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/** A gutter row name from `INTRADAY_ROW_NAMES` — the list `padLeft` is sized by,
 *  so the name paints whole rather than being elided into the gutter (#4852). */
function RowName({
  geo,
  text,
  y,
}: {
  geo: IntradayGeometry;
  text: string;
  y: number;
}) {
  const placed = rowLabel(geo, text);
  if (!placed) return null;
  return (
    <text
      data-testid="intraday-row-name"
      // The row's FULL name. `placed.text` is elided to the gutter, so the drawn
      // glyphs are not the claim — which row exists is.
      data-row={text}
      x={placed.x}
      y={y}
      textAnchor={placed.anchor}
      fontSize={geo.labelSize}
      fill={chartNeutral}
    >
      {placed.text}
    </text>
  );
}

/** The chart's one-line description, shared by both variants' `aria-label`. */
function intradaySummary(model: IntradayModel): string {
  const parts = [
    model.hr
      ? `heart rate ${Math.round(model.hr.min)}–${Math.round(model.hr.max)} bpm`
      : null,
    model.sleep.length > 0
      ? `${model.sleep.length} sleep block${model.sleep.length === 1 ? "" : "s"}`
      : null,
    model.blocks.length > 0
      ? `${model.blocks.length} timed session${model.blocks.length === 1 ? "" : "s"}`
      : null,
    model.ticks.length > 0
      ? `${model.ticks.length} timed entr${model.ticks.length === 1 ? "y" : "ies"}`
      : null,
  ].filter((part): part is string => part != null);
  return `Intraday view for ${model.date}: ${parts.join(", ") || "no intraday data"}`;
}

export default function IntradayChart({
  model,
  formatPrefs,
  variant,
  className,
  profileId,
  selectedWindow = null,
}: {
  model: IntradayModel;
  formatPrefs: DisplayFormatPrefs;
  variant: IntradayVariant;
  className: string;
  profileId: number;
  /**
   * A window stated in the URL (#4950), in minutes since profile-local midnight.
   *
   * DRAWN FROM THE SERVER RENDER, which is the whole reason it is a prop rather than
   * client state: the selection has to stay under the add form while the person fills
   * it in, and survive a reload of the link they were sent. A live drag is the other
   * source and stays local — the two are different marks with the same paint, and
   * `dragSpan` below prefers the live one so releasing a drag never leaves the old
   * window highlighted under the new gesture.
   */
  selectedWindow?: { from: number; to: number | null } | null;
}) {
  const [view, setView] = useState<IntradayView | null>(null);
  const [cursor, setCursor] = useState<number | null>(null);
  const [drag, setDrag] = useState<{ from: number; to: number } | null>(null);
  const fineRequestKey = useMemo(
    () =>
      view && model.hr && wantsFineDetail(view)
        ? {
            date: model.date,
            from: Math.floor(view.from),
            to: Math.ceil(view.to),
            profileId,
            coarseSeries: model.hr,
          }
        : null,
    [view, model.date, model.hr, profileId]
  );
  // The per-minute refinement belongs to exactly one zoom/model request. Null is
  // not an error state — it simply means the 5-minute series is drawn. A request
  // change resets that enhancement during render, without a clearing effect pass.
  const [fine, setFine] = useResettableState<IntradayHrPoint[][] | null>(
    null,
    fineRequestKey
  );
  const svgRef = useRef<SVGSVGElement | null>(null);
  // Live pointers by id → clientX. A ref, not state: the pinch reads it inside the
  // same event that wrote it, and a re-render per touchmove would only cost frames.
  const pointers = useRef(new Map<number, number>());
  const pinch = useRef<{
    gap: number;
    atMinute: number;
    view: IntradayView;
  } | null>(null);
  // The ONE thing about a pinch that has to reach the DOM: `touch-pan-y` hands the
  // browser a two-finger gesture, so the element goes `touch-none` while two
  // pointers are down and back afterwards — a vertical swipe still scrolls.
  const [pinching, setPinching] = useState(false);

  const geo = intradayGeometry(model, variant, view ?? FULL_DAY_VIEW);
  const clock = useCallback(
    (minute: number) => formatClockValue(hhmm(minute), formatPrefs.timeFormat),
    [formatPrefs.timeFormat]
  );
  const x = (minute: number) => projectMinute(geo, minute);
  const y = (bpm: number) => projectBpm(geo, bpm);
  const ticks = axisTicks(geo);
  const bedWake = sleepEdgeLabels(geo, model.sleep, clock);
  // Names are placed PER ROW since #4852: two blocks on different lines cannot
  // overlap, so one shared row layout would drop a practice's name because a
  // workout happened to sit at the same minute a line above it.
  const blockName = new Map(
    [
      ...blockLabels(
        geo,
        model.blocks.filter((b) => b.source === "activity")
      ),
      ...blockLabels(
        geo,
        model.blocks.filter((b) => b.source === "practice")
      ),
    ].map((label) => [label.key, label])
  );
  const zoomed = view != null;

  // ── Background bands (#4918 rulings 3 and 7) — geometry only, drawn first so
  // every other layer paints over them. Neither reserves a row: `geo` above was
  // computed without looking at `solarDay`/`expectedSleep` at all.
  const daylightBand = daylightBandX(geo, model);
  const expectedSleepBand = expectedSleepBandX(geo, model);
  // A hatch `<pattern>` needs an id, and this chart mounts TWICE per panel
  // (compact + wide, both in the DOM at once) — `useId()` keeps the two from
  // colliding the way a hardcoded id would.
  const reactId = useId();
  const hatchId = `intraday-expected-sleep-${reactId}`;

  const segments = useMemo(
    () => clipSegmentsToView(geo, fine ?? model.hr?.segments ?? []),
    // The geometry object is rebuilt every render; the window is what changes it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [fine, model.hr, geo.view.from, geo.view.to, variant]
  );

  // ── The per-minute window (#1515 D) ──────────────────────────────────────
  useEffect(() => {
    if (!fineRequestKey) return;
    const abort = new AbortController();
    const params = new URLSearchParams({
      date: fineRequestKey.date,
      from: String(fineRequestKey.from),
      to: String(fineRequestKey.to),
      profile: String(fineRequestKey.profileId),
    });
    fetch(`/api/intraday/hr?${params}`, { signal: abort.signal })
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => {
        if (
          !body?.ok ||
          !Array.isArray(body.points) ||
          body.points.length === 0
        )
          return;
        const points: IntradayHrPoint[] = body.points.map(
          (p: { minute: number; bpm: number }) => ({
            minute: p.minute,
            bpm: p.bpm,
            lo: p.bpm,
            hi: p.bpm,
          })
        );
        setFine(splitHrSegments(points, FINE_GAP_MINUTES));
      })
      .catch(() => {
        // Aborted, offline, or a 500: the 5-minute line stays drawn. The chart is
        // never empty or broken because of the enhancement.
      });
    // A rapid re-zoom aborts the in-flight request rather than racing it.
    return () => abort.abort();
  }, [fineRequestKey, setFine]);

  // ── Gestures ─────────────────────────────────────────────────────────────
  const minuteAtClientX = (clientX: number): number | null => {
    const svg = svgRef.current;
    if (!svg) return null;
    const rect = svg.getBoundingClientRect();
    if (rect.width === 0) return null;
    const userX = ((clientX - rect.left) / rect.width) * geo.viewBoxWidth;
    return minuteAtX(geo, userX);
  };

  const applyZoom = useCallback((from: number, to: number) => {
    const lo = Math.min(from, to);
    const hi = Math.max(from, to);
    if (hi - lo < MIN_ZOOM_MINUTES) return;
    setView({ from: Math.floor(lo), to: Math.ceil(hi) });
    setCursor(null);
  }, []);

  const resetZoom = useCallback(() => {
    setView(null);
    setCursor(null);
  }, []);

  // ── Wheel and trackpad (#4852) ───────────────────────────────────────────
  // Registered by hand, NOT as an `onWheel` prop: React attaches wheel at the root
  // as a PASSIVE listener, where `preventDefault()` is a silent no-op. "The page
  // does not scroll while zooming" therefore cannot be written as a prop at all.
  //
  // AND THE EXCEPTION IS THE FEATURE — FOR PLAIN WHEELS. `zoomViewAt`/`panView`
  // return null when the gesture moves nothing — above all at the full day, where
  // a wheel that would only zoom out has nowhere to go. Returning WITHOUT
  // preventDefault there is the difference between a chart a reader scrolls past
  // and one that eats the page.
  //
  // A ctrlKey WHEEL IS EXEMPT FROM THAT EXCEPTION (PM ruling, 2026-09-03): it
  // always preventDefaults, in both directions and at every zoom level. It is a
  // trackpad PINCH, and what the browser does with an unhandled one is PAGE ZOOM
  // rather than scrolling — so the reasoning behind the exception does not reach
  // it. The exception exists so a reader can scroll PAST the chart, and a pinch is
  // never an attempt to scroll past anything.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (event: WheelEvent) => {
      const rect = svg.getBoundingClientRect();
      if (rect.width === 0) return;
      const dx = wheelPixels(event.deltaX, event.deltaMode);
      const dy = wheelPixels(event.deltaY, event.deltaMode);
      // Shift+wheel is how a mouse spells "horizontal"; a trackpad sends deltaX.
      const pan = event.shiftKey ? dy : Math.abs(dx) > Math.abs(dy) ? dx : 0;
      const span = geo.view.to - geo.view.from;
      let next;
      if (pan !== 0) {
        const plotPx = (geo.plotW / geo.viewBoxWidth) * rect.width;
        next = panView(geo.view, plotPx > 0 ? (pan / plotPx) * span : 0);
      } else if (dy !== 0) {
        const userX =
          ((event.clientX - rect.left) / rect.width) * geo.viewBoxWidth;
        // A trackpad pinch arrives here as a ctrlKey wheel and takes the same
        // path — it differs only in never being handed back to the page.
        next = zoomViewAt(
          geo.view,
          minuteAtX(geo, userX),
          Math.exp(dy * WHEEL_ZOOM_RATE)
        );
      }
      if (event.ctrlKey || next) event.preventDefault();
      if (!next) return;
      applyZoom(next.from, next.to);
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
    // The geometry object is rebuilt every render; the window is what changes it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [geo.view.from, geo.view.to, variant, applyZoom]);

  // NO setPointerCapture here, deliberately. Capturing the pointer on the <svg>
  // retargets the subsequent `click` to the capturing element, which SWALLOWS the
  // tick and block anchors underneath — the exact affordance #1515 promises to
  // keep working. The drag is tracked on the svg's own pointermove instead, and a
  // gesture that never exceeds the zoom threshold leaves the click to the anchor.
  //
  // The same map is what makes PINCH possible (#4852): a second pointer turns the
  // gesture into a zoom about the two fingers' midpoint, measured against the
  // window they STARTED on so the zoom cannot drift as the fingers move.
  const onPointerDown = (event: React.PointerEvent<SVGSVGElement>) => {
    const minute = minuteAtClientX(event.clientX);
    if (minute == null) return;
    pointers.current.set(event.pointerId, event.clientX);
    if (pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()];
      const mid = minuteAtClientX((a + b) / 2);
      // A drag-select and a pinch are the same two events until the second finger
      // lands; dropping the drag is what keeps the pinch from also committing one.
      setDrag(null);
      setCursor(null);
      pinch.current =
        mid == null
          ? null
          : { gap: Math.abs(a - b), atMinute: mid, view: geo.view };
      setPinching(pinch.current != null);
      return;
    }
    setDrag({ from: minute, to: minute });
    setCursor(minute);
  };

  const onPointerMove = (event: React.PointerEvent<SVGSVGElement>) => {
    if (pointers.current.has(event.pointerId)) {
      pointers.current.set(event.pointerId, event.clientX);
    }
    const active = pinch.current;
    if (active && pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()];
      const gap = Math.abs(a - b);
      if (!(gap > 0) || !(active.gap > 0)) return;
      // Fingers apart ⇒ a wider gap ⇒ a SMALLER span multiplier ⇒ zoom in.
      const next = zoomViewAt(active.view, active.atMinute, active.gap / gap);
      if (next) applyZoom(next.from, next.to);
      return;
    }
    const minute = minuteAtClientX(event.clientX);
    if (minute == null) return;
    setCursor(minute);
    setDrag((current) => (current ? { ...current, to: minute } : null));
  };

  const releasePointer = (pointerId: number) => {
    pointers.current.delete(pointerId);
    if (pointers.current.size < 2) {
      pinch.current = null;
      setPinching(false);
    }
  };

  const onPointerUp = (event: React.PointerEvent<SVGSVGElement>) => {
    const wasPinching = pinch.current != null;
    releasePointer(event.pointerId);
    setDrag((current) => {
      if (
        !wasPinching &&
        current &&
        Math.abs(current.to - current.from) >= MIN_ZOOM_MINUTES
      ) {
        applyZoom(current.from, current.to);
      }
      return null;
    });
  };

  const onKeyDown = (event: React.KeyboardEvent<SVGSVGElement>) => {
    const span = geo.view.to - geo.view.from;
    const step = Math.max(1, Math.round(span / 48));
    const at = cursor ?? geo.view.from + span / 2;
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      const next = at + (event.key === "ArrowLeft" ? -step : step);
      setCursor(Math.max(geo.view.from, Math.min(geo.view.to, next)));
    } else if (event.key === "Home") {
      event.preventDefault();
      setCursor(geo.view.from);
    } else if (event.key === "End") {
      event.preventDefault();
      setCursor(geo.view.to);
    } else if (event.key === "Escape" && zoomed) {
      event.preventDefault();
      resetZoom();
    }
  };

  // ── The readout (#1515 B) ────────────────────────────────────────────────
  // Tolerance follows the DRAWN resolution: the reading has to belong to the
  // pointer's minute, so a scrub over a wear gap reports no reading rather than
  // the value from the other side of it.
  const reading =
    cursor == null
      ? null
      : nearestHrPoint(segments, cursor, fine ? FINE_GAP_MINUTES : 5);
  const zone = reading
    ? zone2Position(reading.bpm, model.hr?.zone2 ?? null)
    : null;
  const readout =
    cursor == null
      ? ""
      : [
          clock(cursor),
          reading ? `${Math.round(reading.bpm)} bpm` : "no reading",
          zone,
        ]
          .filter(Boolean)
          .join(" · ");

  // The live drag wins over the stated window: while a gesture is in flight, the mark
  // under the pointer must be the gesture's, or the person is looking at the last answer
  // while giving a new one.
  const liveDrag =
    drag && Math.abs(drag.to - drag.from) >= 1
      ? { from: Math.min(drag.from, drag.to), to: Math.max(drag.from, drag.to) }
      : null;
  // A start alone (a tap, `to: null`) is drawn as a hairline rather than a band — the
  // `Math.max(1, …)` on the width below is what makes one pixel of it visible.
  const statedSpan = selectedWindow
    ? {
        from: selectedWindow.from,
        to: selectedWindow.to ?? selectedWindow.from,
      }
    : null;
  const dragSpan = liveDrag ?? statedSpan;

  return (
    <div
      className={className}
      data-testid="intraday-chart"
      data-variant={variant}
      data-zoomed={zoomed ? "true" : "false"}
      // The visible window in MINUTES — the machine-readable form of what the
      // reset button says in words. A gesture's whole effect is these two numbers,
      // so a spec can assert a wheel zoom's anchor or a pan's preserved span
      // exactly, instead of parsing a clock the profile's format prefs own.
      data-view-from={Math.round(geo.view.from)}
      data-view-to={Math.round(geo.view.to)}
      style={{ maxWidth: `${geo.maxWidthPx}px` }}
    >
      <svg
        ref={svgRef}
        viewBox={`0 0 ${geo.viewBoxWidth} ${geo.height}`}
        width="100%"
        role="img"
        tabIndex={0}
        aria-label={intradaySummary(model)}
        aria-describedby={`intraday-readout-${model.date}-${variant}`}
        data-testid="intraday-svg"
        // pan-y, not none: a vertical swipe still scrolls the timeline; only the
        // horizontal drag this chart owns is captured. Two fingers down means a
        // pinch, and pan-y would hand that to the browser (#4852).
        className={`w-full ${pinching ? "touch-none" : "touch-pan-y"} focus:outline-hidden focus-visible:ring-2 focus-visible:ring-emerald-500`}
        data-pinching={pinching ? "true" : undefined}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerLeave={(event) => {
          releasePointer(event.pointerId);
          setCursor(null);
          setDrag(null);
        }}
        onKeyDown={onKeyDown}
      >
        {expectedSleepBand && (
          <defs>
            {/* The hatch itself: a diagonal-line fill so the expected window reads
                as a FORECAST, not a fact — the same violet a real session block
                draws solid. */}
            <pattern
              id={hatchId}
              width={6}
              height={6}
              patternUnits="userSpaceOnUse"
              patternTransform="rotate(45)"
            >
              <line
                x1={0}
                y1={0}
                x2={0}
                y2={6}
                stroke={chartSeries.violet}
                strokeWidth={2}
                opacity={0.5}
              />
            </pattern>
          </defs>
        )}

        {/* THE DAYLIGHT BAND (#4918 ruling 3) — sunrise→sunset, subtle, and
            BEHIND EVERYTHING: a background fact about the day, not a row. Its
            height spans the plot's existing content bounds; `geo` above never
            looked at `model.solarDay` to compute them, so this band reserves no
            space of its own. */}
        {daylightBand && (
          <rect
            data-testid="intraday-daylight-band"
            x={daylightBand.left}
            y={geo.padTop}
            width={Math.max(0, daylightBand.right - daylightBand.left)}
            height={Math.max(0, geo.axisY - geo.padTop)}
            fill={chartSeries.amber}
            opacity={0.06}
          />
        )}

        {/* THE EXPECTED SLEEP BAND (#4918 ruling 7) — the profile's usual
            bed→wake window, hatched, confined to the sleep row's own bounds
            (the row a real session would draw in). Gone the instant a session
            lands: `model.expectedSleep` is null then. */}
        {expectedSleepBand && (
          <rect
            data-testid="intraday-expected-sleep"
            x={expectedSleepBand.left}
            y={geo.sleepTop}
            width={Math.max(
              0,
              expectedSleepBand.right - expectedSleepBand.left
            )}
            height={geo.sleepH}
            rx={3}
            fill={`url(#${hatchId})`}
            stroke={chartSeries.violet}
            strokeOpacity={0.4}
            strokeDasharray="2 2"
          />
        )}

        {/* Hour gridlines behind everything, on the axis's own step. */}
        {ticks.map((minute) => (
          <line
            key={`grid-${minute}`}
            x1={x(minute)}
            y1={geo.padTop}
            x2={x(minute)}
            y2={geo.axisY}
            stroke={chartBand.reference}
            opacity={0.15}
          />
        ))}

        {/* ── Layer 1: HR band + line (+ optional Zone 2 reference band) ── */}
        {model.hr && (
          <g
            data-testid="intraday-hr"
            data-resolution={fine ? "minute" : "bucket"}
          >
            {model.hr.zone2 &&
              model.hr.zone2.high > geo.hrLo &&
              model.hr.zone2.low < geo.hrHi && (
                <>
                  <rect
                    x={geo.plotLeft}
                    y={y(model.hr.zone2.high)}
                    width={geo.plotW}
                    height={Math.max(
                      0,
                      y(model.hr.zone2.low) - y(model.hr.zone2.high)
                    )}
                    fill={ZONE_COLORS[1]}
                    opacity={0.12}
                    data-testid="intraday-zone2"
                  />
                  <text
                    x={geo.plotLeft + 3}
                    y={y(model.hr.zone2.high) + geo.labelSize}
                    fontSize={geo.labelSize}
                    fill={chartNeutral}
                  >
                    Zone 2
                  </text>
                </>
              )}
            {segments.map((segment, index) => (
              <g key={`hr-seg-${segment[0]?.minute ?? index}`}>
                <path
                  d={[
                    ...segment.map(
                      (p, i) =>
                        `${i === 0 ? "M" : "L"} ${x(p.minute)} ${y(p.hi)}`
                    ),
                    ...[...segment]
                      .reverse()
                      .map((p) => `L ${x(p.minute)} ${y(p.lo)}`),
                    "Z",
                  ].join(" ")}
                  fill={chartSeries.rose}
                  opacity={0.18}
                />
                <polyline
                  points={segment
                    .map((p) => `${x(p.minute)},${y(p.bpm)}`)
                    .join(" ")}
                  fill="none"
                  stroke={chartSeries.rose}
                  strokeWidth={1.4}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
              </g>
            ))}
            {hrAxisLabels(geo).map((label) => (
              <text
                key={`hr-axis-${label.text}`}
                x={label.x}
                y={label.y}
                textAnchor="end"
                fontSize={geo.labelSize}
                fill={chartNeutral}
              >
                {label.text}
              </text>
            ))}
          </g>
        )}

        {/* ── Layer 2: sleep blocks, clipped to the day (never re-attributed) ── */}
        {model.sleep.map((block) => (
          <g key={block.key} data-testid="intraday-sleep-block">
            <title>{`Sleep · ${clock(block.startMinute)}–${clock(block.endMinute)}${block.clippedStart ? " (continues from the previous day)" : ""}${block.clippedEnd ? " (continues into the next day)" : ""}`}</title>
            <rect
              x={x(block.startMinute)}
              y={geo.sleepTop}
              width={Math.max(1, x(block.endMinute) - x(block.startMinute))}
              height={geo.sleepH}
              rx={block.clippedStart || block.clippedEnd ? 0 : 3}
              fill={chartSeries.violet}
              opacity={0.25}
            />
            {block.stages.map((stage) => (
              <rect
                key={`${block.key}:${stage.stage}:${stage.startMinute}`}
                data-testid="intraday-sleep-stage"
                x={x(stage.startMinute)}
                y={geo.sleepTop + 3}
                width={Math.max(0.6, x(stage.endMinute) - x(stage.startMinute))}
                height={geo.sleepH - 6}
                fill={STAGE_COLOR[stage.stage]}
                opacity={0.75}
              />
            ))}
          </g>
        ))}
        {/* Bed and wake times AT the block's edges (#1512 A) — a day chart's
            most-asked question, which until now lived only in a <title> that a
            touch device never shows. A clipped edge gets none: a session bleeding
            in from yesterday has no bed time inside this day. */}
        {bedWake.map((label) => (
          <text
            key={label.key}
            data-testid="intraday-sleep-time"
            data-edge={label.edge}
            x={label.x}
            y={geo.sleepLabelY}
            textAnchor={label.anchor}
            fontSize={geo.labelSize}
            fill={chartNeutral}
          >
            {label.text}
          </text>
        ))}
        {/* The row NAME shows for a real session or the expected band alike —
            both draw in the same lane, and #4852's gutter rule is about the row,
            not which of the two currently occupies it. */}
        {(geo.hasSleep || geo.hasExpectedSleep) && (
          <RowName
            geo={geo}
            text={INTRADAY_ROW_NAMES.sleep}
            y={geo.sleepTop + geo.sleepH * 0.75}
          />
        )}

        {/* ── Layer 3: session blocks, NAMED where the width allows. An activity's
             window, or a practice session's (#3142) — one shape and one colour,
             because what earns a block is a BOUNDED window. Since #4852 they draw on
             TWO rows (Train, then Practice): a morning workout and an evening sauna
             on one line read as one kind of thing. ── */}
        {model.blocks.map((w) => {
          const layout = blockLayout(geo, w);
          if (!layout) return null;
          const rowTop = blockRowTop(geo, w);
          const name = blockName.get(w.key);
          const block = (
            <>
              <title>{`${w.title} · ${clock(w.startMinute)}–${clock(w.endMinute)}${w.running ? " · running" : ""}`}</title>
              <rect
                x={layout.left}
                y={rowTop}
                width={layout.width}
                height={geo.workH}
                rx={3}
                fill={w.running ? chartSeries.amber : chartSeries.brand}
                opacity={0.3}
              />
              <rect
                x={layout.left}
                y={rowTop}
                width={layout.width}
                height={geo.workH}
                rx={3}
                fill="none"
                stroke={w.running ? chartSeries.amber : chartSeries.brand}
                strokeWidth={0.8}
                strokeDasharray={w.running ? chartDash.annotation : undefined}
              />
              {layout.showIcon && (
                <svg
                  x={layout.left + layout.iconSize * 0.25}
                  y={rowTop + (geo.workH - layout.iconSize) / 2}
                  width={layout.iconSize}
                  height={layout.iconSize}
                  viewBox="0 0 24 24"
                  style={{
                    color: w.running ? chartSeries.amber : chartSeries.brand,
                  }}
                >
                  <ActivityIcon
                    type={w.iconType ?? "activity"}
                    title={w.iconTitle ?? w.title}
                    sportNames={w.iconSportNames ?? undefined}
                    className=""
                    stroke={2}
                  />
                </svg>
              )}
              {name && (
                <text
                  data-testid="intraday-block-name"
                  data-placement={name.mode}
                  x={name.x}
                  y={rowTop + geo.workH / 2 + geo.labelSize * 0.35}
                  textAnchor={name.anchor}
                  fontSize={geo.labelSize}
                  fill={chartNeutral}
                >
                  {name.text}
                </text>
              )}
            </>
          );
          return (
            <g
              key={w.key}
              data-testid="intraday-block"
              data-title={w.title}
              data-source={w.source}
              data-running={w.running ? "true" : undefined}
            >
              {w.href ? (
                // Progressive enhancement: the anchor IS the pre-hydration and
                // no-JS behavior (tap scrolls to the feed entry). Once hydrated,
                // tapping the block selects its window instead — the shortcut
                // #1515 C describes — and the feed entry stays one scroll away.
                <a
                  href={w.href}
                  onClick={(event) => {
                    event.preventDefault();
                    applyZoom(
                      w.startMinute - BLOCK_ZOOM_PAD_MINUTES,
                      w.endMinute + BLOCK_ZOOM_PAD_MINUTES
                    );
                  }}
                >
                  {block}
                </a>
              ) : (
                block
              )}
            </g>
          );
        })}
        {geo.hasWorkouts && (
          <RowName
            geo={geo}
            text={INTRADAY_ROW_NAMES.train}
            y={geo.workTop + geo.workH * 0.7}
          />
        )}
        {geo.hasPractice && (
          <RowName
            geo={geo}
            text={INTRADAY_ROW_NAMES.practice}
            y={geo.practiceTop + geo.workH * 0.7}
          />
        )}

        {/* ── Layer 4: the event-tick rail — tap scrolls the list below ── */}
        {geo.hasTicks && (
          <line
            x1={geo.plotLeft}
            y1={geo.tickTop + geo.tickH}
            x2={geo.plotRight}
            y2={geo.tickTop + geo.tickH}
            stroke={chartBand.reference}
            opacity={0.35}
          />
        )}
        {model.ticks.map((tick) => {
          if (tick.minute < geo.view.from || tick.minute > geo.view.to)
            return null;
          const at = x(tick.minute);
          return (
            <a
              key={tick.key}
              href={`#${tick.anchorId}`}
              data-testid="intraday-tick"
              data-tick-event={tick.eventId}
            >
              <title>{`${tick.label} · ${clock(tick.minute)}`}</title>
              {/* A generous transparent hit area — the drawn tick is thin. */}
              <rect
                x={at - geo.labelSize * 0.6}
                y={geo.tickTop}
                width={geo.labelSize * 1.2}
                height={geo.tickH}
                fill="transparent"
              />
              <line
                x1={at}
                y1={geo.tickTop + 2}
                x2={at}
                y2={geo.tickTop + geo.tickH}
                stroke={TONE_COLOR[tick.tone]}
                strokeWidth={2}
                strokeLinecap="round"
              />
              <circle
                cx={at}
                cy={geo.tickTop + 2}
                r={2.4}
                fill={TONE_COLOR[tick.tone]}
              />
            </a>
          );
        })}

        {/* ── Layer 5: the now-marker (today only) ── */}
        {model.nowMinute != null &&
          model.nowMinute >= geo.view.from &&
          model.nowMinute <= geo.view.to && (
            <g data-testid="intraday-now" pointerEvents="none">
              <title>{`Now · ${clock(model.nowMinute)}`}</title>
              <line
                x1={x(model.nowMinute)}
                y1={geo.padTop}
                x2={x(model.nowMinute)}
                y2={geo.axisY}
                stroke={chartSeries.amber}
                strokeWidth={1.2}
                strokeDasharray={chartDash.now}
              />
            </g>
          )}

        {/* ── Layer 6: the interaction marks (#1515) ── */}
        {/* The interaction marks are pointer-TRANSPARENT. They are drawn last, so
            they paint over the tick and block anchors — and an SVG element under
            the pointer becomes the click target, which would silently swallow the
            very anchors #1515 promises to keep working (the crosshair sits exactly
            under the cursor by construction). */}
        {dragSpan && (
          <rect
            data-testid="intraday-selection"
            pointerEvents="none"
            x={x(dragSpan.from)}
            y={geo.padTop}
            width={Math.max(1, x(dragSpan.to) - x(dragSpan.from))}
            height={geo.axisY - geo.padTop}
            fill={chartSeries.sky}
            opacity={0.14}
          />
        )}
        {cursor != null && (
          <g
            data-testid="intraday-cursor"
            data-minute={Math.round(cursor)}
            pointerEvents="none"
          >
            <line
              x1={x(cursor)}
              y1={geo.padTop}
              x2={x(cursor)}
              y2={geo.axisY}
              stroke={chartNeutral}
              strokeWidth={1}
              strokeDasharray={chartDash.cursor}
            />
            {reading && (
              <circle
                cx={x(cursor)}
                cy={y(reading.bpm)}
                r={2.6}
                fill={chartSeries.rose}
              />
            )}
          </g>
        )}

        {/* Clock axis. */}
        <line
          x1={geo.plotLeft}
          y1={geo.axisY}
          x2={geo.plotRight}
          y2={geo.axisY}
          stroke={chartBand.reference}
          opacity={0.35}
        />
        {ticks.map((minute, index) => (
          <text
            key={`axis-${minute}`}
            data-testid="intraday-axis-label"
            x={x(minute)}
            y={geo.axisY + geo.labelSize + 2}
            textAnchor={
              index === 0
                ? "start"
                : index === ticks.length - 1
                  ? "end"
                  : "middle"
            }
            fontSize={geo.labelSize}
            fill={chartNeutral}
          >
            {/* The 24:00 gridline is the SAME midnight as 00:00 — label it so. */}
            {clock(minute === MINUTES_IN_DAY ? 0 : minute)}
          </text>
        ))}
      </svg>

      <div className="mt-1 flex min-h-6 flex-wrap items-center justify-between gap-x-3 gap-y-1">
        {/* The readout is a live region so the value is REACHABLE by keyboard and
            screen reader, not only by dragging — the #1220 discipline extended to
            interaction. It is present (and empty) before the first scrub so the
            first announcement isn't swallowed. */}
        <p
          id={`intraday-readout-${model.date}-${variant}`}
          data-testid="intraday-readout"
          aria-live="polite"
          className="text-xs tabular-nums text-slate-600 dark:text-slate-300"
        >
          {readout}
        </p>
        {zoomed && (
          <button
            type="button"
            onClick={resetZoom}
            data-testid="intraday-zoom-reset"
            className="rounded-sm border border-slate-300 px-2 py-0.5 text-xs text-slate-600 dark:border-slate-600 dark:text-slate-300"
          >
            {`Full day · showing ${clock(geo.view.from)}–${clock(geo.view.to)}`}
          </button>
        )}
      </div>
    </div>
  );
}
