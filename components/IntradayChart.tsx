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

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ActivityIcon from "@/components/ActivityIcon";
import { chartDash } from "@/components/chart-scaffold";
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
  hrAxisLabels,
  intradayGeometry,
  minuteAtX,
  nearestHrPoint,
  projectBpm,
  projectMinute,
  rowLabel,
  sleepEdgeLabels,
  wantsFineDetail,
  workoutBlockLayout,
  zone2Position,
  type IntradayGeometry,
  type IntradayVariant,
  type IntradayView,
} from "@/lib/intraday-layout";

// Tick color by the event's tone — the SAME tone the feed card renders, so a
// flagged temperature reads red in both places.
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

function hhmm(minute: number): string {
  const m = Math.max(0, Math.min(MINUTES_IN_DAY - 1, Math.round(minute)));
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/** The gutter row name ("Sleep", "Train"), elided into the gutter rather than
 *  painting back over the plot's left edge. */
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
    model.workouts.length > 0
      ? `${model.workouts.length} workout${model.workouts.length === 1 ? "" : "s"}`
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
}: {
  model: IntradayModel;
  formatPrefs: DisplayFormatPrefs;
  variant: IntradayVariant;
  className: string;
  profileId: number;
}) {
  const [view, setView] = useState<IntradayView | null>(null);
  const [cursor, setCursor] = useState<number | null>(null);
  const [drag, setDrag] = useState<{ from: number; to: number } | null>(null);
  // The per-minute refinement for the current zoom. Null is not an error state —
  // it simply means the 5-minute series is what is drawn, which is the whole
  // degradation story: a failed or slow fetch never empties or blocks the chart.
  const [fine, setFine] = useState<IntradayHrPoint[][] | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);

  const geo = intradayGeometry(model, variant, view ?? FULL_DAY_VIEW);
  const clock = useCallback(
    (minute: number) => formatClockValue(hhmm(minute), formatPrefs.timeFormat),
    [formatPrefs.timeFormat]
  );
  const x = (minute: number) => projectMinute(geo, minute);
  const y = (bpm: number) => projectBpm(geo, bpm);
  const ticks = axisTicks(geo);
  const bedWake = sleepEdgeLabels(geo, model.sleep, clock);
  const zoomed = view != null;

  const segments = useMemo(
    () => clipSegmentsToView(geo, fine ?? model.hr?.segments ?? []),
    // The geometry object is rebuilt every render; the window is what changes it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [fine, model.hr, geo.view.from, geo.view.to, variant]
  );

  // ── The per-minute window (#1515 D) ──────────────────────────────────────
  useEffect(() => {
    if (!view || !model.hr || !wantsFineDetail(view)) {
      setFine(null);
      return;
    }
    const abort = new AbortController();
    const params = new URLSearchParams({
      date: model.date,
      from: String(Math.floor(view.from)),
      to: String(Math.ceil(view.to)),
      profile: String(profileId),
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
  }, [view, model.date, model.hr, profileId]);

  // ── Gestures ─────────────────────────────────────────────────────────────
  const minuteAtClientX = useCallback(
    (clientX: number): number | null => {
      const svg = svgRef.current;
      if (!svg) return null;
      const rect = svg.getBoundingClientRect();
      if (rect.width === 0) return null;
      const userX = ((clientX - rect.left) / rect.width) * geo.viewBoxWidth;
      return minuteAtX(geo, userX);
    },
    [geo]
  );

  const applyZoom = useCallback((from: number, to: number) => {
    const lo = Math.min(from, to);
    const hi = Math.max(from, to);
    if (hi - lo < MIN_ZOOM_MINUTES) return;
    setView({ from: Math.floor(lo), to: Math.ceil(hi) });
    setCursor(null);
  }, []);

  const resetZoom = useCallback(() => {
    setView(null);
    setFine(null);
    setCursor(null);
  }, []);

  const onPointerDown = (event: React.PointerEvent<SVGSVGElement>) => {
    const minute = minuteAtClientX(event.clientX);
    if (minute == null) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setDrag({ from: minute, to: minute });
    setCursor(minute);
  };

  const onPointerMove = (event: React.PointerEvent<SVGSVGElement>) => {
    const minute = minuteAtClientX(event.clientX);
    if (minute == null) return;
    setCursor(minute);
    setDrag((current) => (current ? { ...current, to: minute } : null));
  };

  const onPointerUp = () => {
    setDrag((current) => {
      if (current && Math.abs(current.to - current.from) >= MIN_ZOOM_MINUTES) {
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

  const dragSpan =
    drag && Math.abs(drag.to - drag.from) >= 1
      ? { from: Math.min(drag.from, drag.to), to: Math.max(drag.from, drag.to) }
      : null;

  return (
    <div
      className={className}
      data-testid="intraday-chart"
      data-variant={variant}
      data-zoomed={zoomed ? "true" : "false"}
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
        // horizontal drag this chart owns is captured.
        className="w-full touch-pan-y focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerLeave={() => {
          setCursor(null);
          setDrag(null);
        }}
        onKeyDown={onKeyDown}
      >
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
        {geo.hasSleep && (
          <RowName
            geo={geo}
            text="Sleep"
            y={geo.sleepTop + geo.sleepH * 0.75}
          />
        )}

        {/* ── Layer 3: workout blocks, NAMED where the width allows ── */}
        {model.workouts.map((w) => {
          const layout = workoutBlockLayout(geo, w);
          if (!layout) return null;
          const block = (
            <>
              <title>{`${w.title} · ${clock(w.startMinute)}–${clock(w.endMinute)}`}</title>
              <rect
                x={layout.left}
                y={geo.workTop}
                width={layout.width}
                height={geo.workH}
                rx={3}
                fill={chartSeries.brand}
                opacity={0.3}
              />
              <rect
                x={layout.left}
                y={geo.workTop}
                width={layout.width}
                height={geo.workH}
                rx={3}
                fill="none"
                stroke={chartSeries.brand}
                strokeWidth={0.8}
              />
              {layout.showIcon && (
                <svg
                  x={layout.left + layout.iconSize * 0.25}
                  y={geo.workTop + (geo.workH - layout.iconSize) / 2}
                  width={layout.iconSize}
                  height={layout.iconSize}
                  viewBox="0 0 24 24"
                  style={{ color: chartSeries.brand }}
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
              {layout.text && (
                <text
                  data-testid="intraday-workout-name"
                  x={layout.textX}
                  y={geo.workTop + geo.workH / 2 + geo.labelSize * 0.35}
                  fontSize={geo.labelSize}
                  fill={chartNeutral}
                >
                  {layout.text}
                </text>
              )}
            </>
          );
          return (
            <g key={w.key} data-testid="intraday-workout" data-title={w.title}>
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
          <RowName geo={geo} text="Train" y={geo.workTop + geo.workH * 0.7} />
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
            <g data-testid="intraday-now">
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
        {dragSpan && (
          <rect
            data-testid="intraday-selection"
            x={x(dragSpan.from)}
            y={geo.padTop}
            width={Math.max(1, x(dragSpan.to) - x(dragSpan.from))}
            height={geo.axisY - geo.padTop}
            fill={chartSeries.sky}
            opacity={0.14}
          />
        )}
        {cursor != null && (
          <g data-testid="intraday-cursor" data-minute={Math.round(cursor)}>
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
            title="Show the whole day again"
            className="rounded border border-slate-300 px-2 py-0.5 text-xs text-slate-600 dark:border-slate-600 dark:text-slate-300"
          >
            {`Full day · showing ${clock(geo.view.from)}–${clock(geo.view.to)}`}
          </button>
        )}
      </div>
    </div>
  );
}
