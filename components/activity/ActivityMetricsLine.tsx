import Link from "next/link";
import type { AppRoute } from "@/lib/hrefs";

export default function ActivityMetricsLine({
  metrics,
  gear,
  className = "",
}: {
  metrics: string[];
  gear?: { label: string; href?: AppRoute } | null;
  className?: string;
}) {
  if (metrics.length === 0 && !gear) return null;

  return (
    <ul
      data-testid="activity-metrics"
      aria-label="Activity details"
      className={`flex flex-wrap text-xs tabular-nums text-slate-500 dark:text-slate-400 ${className}`}
    >
      {metrics.map((metric, index) => (
        <li key={metric} className="whitespace-nowrap">
          {index > 0 ? (
            <span aria-hidden className="mx-2">
              ·
            </span>
          ) : null}
          {metric}
        </li>
      ))}
      {gear ? (
        <li className="whitespace-nowrap">
          {metrics.length > 0 ? (
            <span aria-hidden className="mx-2">
              ·
            </span>
          ) : null}
          {gear.href ? (
            <Link
              href={gear.href}
              data-testid="activity-gear"
              className="hover:text-slate-700 hover:underline dark:hover:text-slate-200"
            >
              {gear.label}
            </Link>
          ) : (
            <span data-testid="activity-gear">{gear.label}</span>
          )}
        </li>
      ) : null}
    </ul>
  );
}
