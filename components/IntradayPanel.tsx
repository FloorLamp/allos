// The Timeline day view's intraday panel (issue #1068) — a THIN SVG formatter over
// the pure `buildIntradayModel` result. Every decision (downsampling, clipping,
// layer gating, tick assembly) already happened in lib/intraday.ts; this file only
// maps minutes → x and draws.
//
// Server-rendered SVG on the FeverChart precedent: a fixed viewBox, no chart
// library, no client JS. The tick/block links are plain `<a href="#…">` fragments
// (and one route link), so tapping works before hydration.
import ActivityIcon from "@/components/ActivityIcon";
import { chartBand, chartSeries } from "@/lib/chart-colors";
import { ZONE_COLORS } from "@/lib/training-zones";
import { formatClockValue, type DisplayFormatPrefs } from "@/lib/format-date";
import type { IntradayModel, IntradayTick, SleepStage } from "@/lib/intraday";
import { MINUTES_IN_DAY } from "@/lib/intraday";

const W = 720;
const PAD_LEFT = 30;
const PAD_RIGHT = 10;
const PLOT_W = W - PAD_LEFT - PAD_RIGHT;

const HR_H = 84;
const SLEEP_H = 14;
const WORK_H = 18;
const TICK_H = 18;
const ROW_GAP = 8;
const AXIS_H = 18;

// Tick color by the event's tone — the SAME tone the feed card renders, so a
// flagged temperature reads red in both places.
const TONE_COLOR: Record<NonNullable<IntradayTick["tone"]>, string> = {
  default: chartSeries.slate,
  good: chartSeries.brand,
  warn: chartSeries.amber,
  bad: chartSeries.rose,
};

// Sleep stage sub-band shades (deep → awake). Distinct fills within the one sleep
// block, on the blessed violet/slate families.
const STAGE_COLOR: Record<SleepStage, string> = {
  deep: "#6d28d9", // violet-700
  rem: chartSeries.violet,
  light: "#c4b5fd", // violet-300
  awake: chartSeries.slate,
};

function x(minute: number): number {
  return (
    PAD_LEFT +
    (Math.max(0, Math.min(MINUTES_IN_DAY, minute)) / MINUTES_IN_DAY) * PLOT_W
  );
}

function hhmm(minute: number): string {
  const m = Math.max(0, Math.min(MINUTES_IN_DAY - 1, Math.round(minute)));
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

export default function IntradayPanel({
  model,
  formatPrefs,
}: {
  model: IntradayModel;
  formatPrefs: DisplayFormatPrefs;
}) {
  const clock = (minute: number) =>
    formatClockValue(hhmm(minute), formatPrefs.timeFormat);

  // Rows collapse when their layer is absent — no reserved empty strip.
  let cursor = 6;
  const hrTop = cursor;
  if (model.hr) cursor += HR_H + ROW_GAP;
  const sleepTop = cursor;
  if (model.sleep.length > 0) cursor += SLEEP_H + ROW_GAP;
  const workTop = cursor;
  if (model.workouts.length > 0) cursor += WORK_H + ROW_GAP;
  const tickTop = cursor;
  if (model.ticks.length > 0) cursor += TICK_H + ROW_GAP;
  const axisY = cursor;
  const H = axisY + AXIS_H;

  // HR value axis: pad the observed band a little so the line never touches the
  // frame. Zone 2 widens the range only when it overlaps what was actually worn.
  const hr = model.hr;
  const lo = hr ? Math.max(0, Math.floor(hr.min) - 5) : 0;
  const hi = hr ? Math.ceil(hr.max) + 5 : 1;
  const span = hi - lo || 1;
  const yFor = (bpm: number) =>
    hrTop + (1 - (Math.max(lo, Math.min(hi, bpm)) - lo) / span) * HR_H;

  const summary = [
    hr ? `heart rate ${Math.round(hr.min)}–${Math.round(hr.max)} bpm` : null,
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

  return (
    <div
      className="card mb-3 overflow-hidden"
      data-testid="intraday-panel"
      data-intraday-date={model.date}
    >
      <div className="mb-1 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100">
          The day at a glance
        </h3>
        <p className="text-xs text-slate-500 dark:text-slate-400">
          Midnight to midnight · tap a mark to jump to its entry
        </p>
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        role="img"
        aria-label={`Intraday view for ${model.date}: ${summary.join(", ") || "no intraday data"}`}
        className="w-full"
      >
        {/* Hour gridlines every 3 h, behind everything. */}
        {Array.from({ length: 9 }, (_, i) => i * 180).map((minute) => (
          <line
            key={`grid-${minute}`}
            x1={x(minute)}
            y1={6}
            x2={x(minute)}
            y2={axisY}
            stroke={chartBand.reference}
            opacity={0.15}
          />
        ))}

        {/* ── Layer 1: HR band + line (+ optional Zone 2 reference band) ── */}
        {hr && (
          <g data-testid="intraday-hr">
            {hr.zone2 && hr.zone2.high > lo && hr.zone2.low < hi && (
              <>
                <rect
                  x={PAD_LEFT}
                  y={yFor(hr.zone2.high)}
                  width={PLOT_W}
                  height={Math.max(0, yFor(hr.zone2.low) - yFor(hr.zone2.high))}
                  fill={ZONE_COLORS[1]}
                  opacity={0.12}
                  data-testid="intraday-zone2"
                />
                <text
                  x={PAD_LEFT + 3}
                  y={yFor(hr.zone2.high) + 8}
                  fontSize={7}
                  fill={chartSeries.slate}
                >
                  Zone 2
                </text>
              </>
            )}
            {hr.segments.map((segment, index) => (
              <g key={`hr-seg-${segment[0]?.minute ?? index}`}>
                <path
                  d={[
                    ...segment.map(
                      (p, i) =>
                        `${i === 0 ? "M" : "L"} ${x(p.minute)} ${yFor(p.hi)}`
                    ),
                    ...[...segment]
                      .reverse()
                      .map((p) => `L ${x(p.minute)} ${yFor(p.lo)}`),
                    "Z",
                  ].join(" ")}
                  fill={chartSeries.rose}
                  opacity={0.18}
                />
                <polyline
                  points={segment
                    .map((p) => `${x(p.minute)},${yFor(p.bpm)}`)
                    .join(" ")}
                  fill="none"
                  stroke={chartSeries.rose}
                  strokeWidth={1.4}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
              </g>
            ))}
            <text x={1} y={hrTop + 7} fontSize={7} fill={chartSeries.slate}>
              {hi} bpm
            </text>
            <text x={1} y={hrTop + HR_H} fontSize={7} fill={chartSeries.slate}>
              {lo}
            </text>
          </g>
        )}

        {/* ── Layer 2: sleep blocks, clipped to the day (never re-attributed) ── */}
        {model.sleep.map((block) => (
          <g key={block.key} data-testid="intraday-sleep-block">
            <title>{`Sleep · ${clock(block.startMinute)}–${clock(block.endMinute)}${block.clippedStart ? " (continues from the previous day)" : ""}${block.clippedEnd ? " (continues into the next day)" : ""}`}</title>
            <rect
              x={x(block.startMinute)}
              y={sleepTop}
              width={Math.max(1, x(block.endMinute) - x(block.startMinute))}
              height={SLEEP_H}
              rx={block.clippedStart || block.clippedEnd ? 0 : 3}
              fill={chartSeries.violet}
              opacity={0.25}
            />
            {block.stages.map((stage) => (
              <rect
                key={`${block.key}:${stage.stage}:${stage.startMinute}`}
                data-testid="intraday-sleep-stage"
                x={x(stage.startMinute)}
                y={sleepTop + 3}
                width={Math.max(0.6, x(stage.endMinute) - x(stage.startMinute))}
                height={SLEEP_H - 6}
                fill={STAGE_COLOR[stage.stage]}
                opacity={0.75}
              />
            ))}
          </g>
        ))}
        {model.sleep.length > 0 && (
          <text x={1} y={sleepTop + 10} fontSize={7} fill={chartSeries.slate}>
            Sleep
          </text>
        )}

        {/* ── Layer 3: workout blocks with type icons; tap → the activity ── */}
        {model.workouts.map((w) => {
          const left = x(w.startMinute);
          const width = Math.max(3, x(w.endMinute) - left);
          const block = (
            <>
              <title>{`${w.title} · ${clock(w.startMinute)}–${clock(w.endMinute)}`}</title>
              <rect
                x={left}
                y={workTop}
                width={width}
                height={WORK_H}
                rx={3}
                fill={chartSeries.brand}
                opacity={0.3}
              />
              <rect
                x={left}
                y={workTop}
                width={width}
                height={WORK_H}
                rx={3}
                fill="none"
                stroke={chartSeries.brand}
                strokeWidth={0.8}
              />
              {width >= 14 && (
                <svg
                  x={left + 2}
                  y={workTop + 3}
                  width={12}
                  height={12}
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
            </>
          );
          return (
            <g key={w.key} data-testid="intraday-workout" data-title={w.title}>
              {w.href ? <a href={w.href}>{block}</a> : block}
            </g>
          );
        })}
        {model.workouts.length > 0 && (
          <text x={1} y={workTop + 12} fontSize={7} fill={chartSeries.slate}>
            Train
          </text>
        )}

        {/* ── Layer 4: the event-tick rail — tap scrolls the list below ── */}
        {model.ticks.length > 0 && (
          <line
            x1={PAD_LEFT}
            y1={tickTop + TICK_H}
            x2={W - PAD_RIGHT}
            y2={tickTop + TICK_H}
            stroke={chartBand.reference}
            opacity={0.35}
          />
        )}
        {model.ticks.map((tick) => (
          <a
            key={tick.key}
            href={`#${tick.anchorId}`}
            data-testid="intraday-tick"
            data-tick-event={tick.eventId}
          >
            <title>{`${tick.label} · ${clock(tick.minute)}`}</title>
            {/* A generous transparent hit area — the drawn tick is 2px wide. */}
            <rect
              x={x(tick.minute) - 6}
              y={tickTop}
              width={12}
              height={TICK_H}
              fill="transparent"
            />
            <line
              x1={x(tick.minute)}
              y1={tickTop + 2}
              x2={x(tick.minute)}
              y2={tickTop + TICK_H}
              stroke={TONE_COLOR[tick.tone]}
              strokeWidth={2}
              strokeLinecap="round"
            />
            <circle
              cx={x(tick.minute)}
              cy={tickTop + 2}
              r={2.4}
              fill={TONE_COLOR[tick.tone]}
            />
          </a>
        ))}

        {/* ── Layer 5: the now-marker (today only) ── */}
        {model.nowMinute != null && (
          <g data-testid="intraday-now">
            <title>{`Now · ${clock(model.nowMinute)}`}</title>
            <line
              x1={x(model.nowMinute)}
              y1={6}
              x2={x(model.nowMinute)}
              y2={axisY}
              stroke={chartSeries.amber}
              strokeWidth={1.2}
              strokeDasharray="3 2"
            />
          </g>
        )}

        {/* Clock axis. */}
        <line
          x1={PAD_LEFT}
          y1={axisY}
          x2={W - PAD_RIGHT}
          y2={axisY}
          stroke={chartBand.reference}
          opacity={0.35}
        />
        {Array.from({ length: 9 }, (_, i) => i * 180).map((minute, index) => (
          <text
            key={`axis-${minute}`}
            x={x(minute)}
            y={axisY + 11}
            textAnchor={index === 0 ? "start" : index === 8 ? "end" : "middle"}
            fontSize={7.5}
            fill={chartSeries.slate}
          >
            {/* The 24:00 gridline is the SAME midnight as 00:00 — label it so. */}
            {clock(minute === MINUTES_IN_DAY ? 0 : minute)}
          </text>
        ))}
      </svg>
    </div>
  );
}
