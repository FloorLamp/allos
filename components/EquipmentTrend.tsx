// A tiny, dependency-free inline-SVG sparkline for the equipment detail page's
// usage trend (issue #343). Server-renderable (no chart lib, no client boundary):
// it plots one value per session over time, so a strength implement shows its
// volume trajectory and a bike/shoes their per-ride/run distance. A single point
// uses the shared captioned mark; an empty series renders nothing.
import { loneReading } from "@/lib/trend-sparkline";
import SingleReadingMark from "./SingleReadingMark";

export default function EquipmentTrend({
  points,
  label,
  ariaLabel,
  loneCaption,
}: {
  // Oldest→newest values (already unit-converted for display).
  points: readonly number[];
  label: string;
  ariaLabel: string;
  // Preference-formatted value + date for the shared one-reading mark.
  loneCaption: string;
}) {
  if (points.length === 0) return null;
  const lone = loneReading(points.map((value) => ({ value })));
  if (lone)
    return (
      <div>
        <div className="mb-1 section-label">{label}</div>
        <SingleReadingMark
          caption={loneCaption}
          testid="equipment-trend-single-reading"
        />
      </div>
    );

  const w = 280;
  const h = 56;
  const pad = 4;
  const max = Math.max(...points, 0);
  const min = Math.min(...points, 0);
  const span = max - min || 1;
  const n = points.length;
  const x = (i: number) => pad + (i * (w - 2 * pad)) / (n - 1);
  const y = (v: number) => h - pad - ((v - min) / span) * (h - 2 * pad);

  const d = points
    .map(
      (v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`
    )
    .join(" ");

  return (
    <div>
      <div className="mb-1 section-label">{label}</div>
      <svg
        viewBox={`0 0 ${w} ${h}`}
        className="h-14 w-full"
        role="img"
        aria-label={ariaLabel}
        preserveAspectRatio="none"
      >
        <path
          d={d}
          fill="none"
          className="stroke-brand-500"
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
    </div>
  );
}
