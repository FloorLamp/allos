import { chartSeries, chartBand } from "@/lib/chart-colors";
import type { TemperaturePoint } from "@/lib/illness-episode-format";

// The fever curve (issue #856 item 4): a small, self-contained SVG line chart of the
// episode's timed temperature readings (#800), with a shaded normal-range band so a
// reading above it reads as fever at a glance. The peak-temp STAT stays in the summary
// header; this adds the shape. Inline SVG (not recharts) so it renders in the server
// component and survives print. Colors come from the #794 palette (chart-colors), never
// hand-picked hex. Axis labels stay plain °F for now — they adopt fmtTemp when #857's
// temperature-preference work lands (whoever rebases second integrates).
//
// Pure/presentational: no DB, no client state. A single reading renders as one dot.

const W = 320;
const H = 90;
const PAD_X = 8;
const PAD_Y = 10;
// Typical normal oral-temperature band (°F). Readings above ~100.4 read as fever; the
// band gives the eye a baseline without asserting a diagnosis.
const NORMAL_LOW = 97.0;
const NORMAL_HIGH = 99.0;

export default function FeverChart({
  temperatures,
}: {
  temperatures: TemperaturePoint[];
}) {
  const pts = temperatures.filter((t) => Number.isFinite(t.degF));
  if (pts.length === 0) return null;

  const values = pts.map((t) => t.degF);
  const dataMin = Math.min(...values, NORMAL_LOW);
  const dataMax = Math.max(...values, NORMAL_HIGH);
  // Pad the domain a little so the extremes don't sit on the frame.
  const lo = dataMin - 0.5;
  const hi = dataMax + 0.5;
  const span = hi - lo || 1;

  const x = (i: number) =>
    pts.length === 1 ? W / 2 : PAD_X + (i / (pts.length - 1)) * (W - 2 * PAD_X);
  const y = (v: number) => PAD_Y + (1 - (v - lo) / span) * (H - 2 * PAD_Y);

  const bandTop = y(NORMAL_HIGH);
  const bandBottom = y(NORMAL_LOW);
  const line = pts.map((t, i) => `${x(i)},${y(t.degF)}`).join(" ");

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      width="100%"
      role="img"
      aria-label={`Fever curve, peak ${Math.max(...values).toFixed(1)} degrees Fahrenheit`}
      data-testid="episode-fever-chart"
      className="max-w-md"
    >
      {/* Normal-range band */}
      <rect
        x={0}
        y={bandTop}
        width={W}
        height={Math.max(0, bandBottom - bandTop)}
        fill={chartBand.reference}
        opacity={0.15}
      />
      {/* The fever line */}
      {pts.length > 1 && (
        <polyline
          points={line}
          fill="none"
          stroke={chartSeries.rose}
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      )}
      {/* Reading dots — fever-flagged readings filled rose, others neutral */}
      {pts.map((t, i) => (
        <circle
          key={`${t.date}-${t.time ?? i}`}
          cx={x(i)}
          cy={y(t.degF)}
          r={2.8}
          fill={t.flag === "high" ? chartSeries.rose : chartBand.reference}
        />
      ))}
    </svg>
  );
}
