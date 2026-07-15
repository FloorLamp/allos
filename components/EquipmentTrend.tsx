// A tiny, dependency-free inline-SVG sparkline for the equipment detail page's
// usage trend (issue #343). Server-renderable (no chart lib, no client boundary):
// it plots one value per session over time, so a strength implement shows its
// volume trajectory and a bike/shoes their per-ride/run distance. A single point
// renders a dot; an empty series renders nothing.
export default function EquipmentTrend({
  points,
  label,
  ariaLabel,
}: {
  // Oldest→newest values (already unit-converted for display).
  points: number[];
  label: string;
  ariaLabel: string;
}) {
  if (points.length === 0) return null;
  const w = 280;
  const h = 56;
  const pad = 4;
  const max = Math.max(...points, 0);
  const min = Math.min(...points, 0);
  const span = max - min || 1;
  const n = points.length;
  const x = (i: number) =>
    n === 1 ? w / 2 : pad + (i * (w - 2 * pad)) / (n - 1);
  const y = (v: number) => h - pad - ((v - min) / span) * (h - 2 * pad);

  const d = points
    .map(
      (v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`
    )
    .join(" ");

  return (
    <div>
      <div className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
        {label}
      </div>
      <svg
        viewBox={`0 0 ${w} ${h}`}
        className="h-14 w-full"
        role="img"
        aria-label={ariaLabel}
        preserveAspectRatio="none"
      >
        {n === 1 ? (
          <circle
            cx={x(0)}
            cy={y(points[0])}
            r={3}
            className="fill-brand-500"
          />
        ) : (
          <path
            d={d}
            fill="none"
            className="stroke-brand-500"
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
        )}
      </svg>
    </div>
  );
}
