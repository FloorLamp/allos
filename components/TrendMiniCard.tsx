import Link from "next/link";
import type { ReactNode } from "react";
import { IconArrowDownRight, IconArrowUpRight } from "@tabler/icons-react";
import LineChartCard from "./LineChartCard";
import { round } from "@/lib/units";
import { summarizeSeries } from "@/lib/trends";

// A compact trend tile for the Trends hub's Overview grid: a linked title, the
// latest value with a net-change badge over the visible window, and a small
// sparkline. The data is pre-windowed and already in display units by the caller
// (the hub converts kg/km at the boundary), so this component only formats and
// draws it. Reuses LineChartCard for the sparkline. An optional `footer` slot
// holds per-tile controls (the Phase-2 pin toggle).
export default function TrendMiniCard({
  title,
  href,
  data,
  label,
  unit = "",
  color,
  decimals = 1,
  footer,
}: {
  title: string;
  href: string;
  data: { date: string; value: number | null }[];
  label: string;
  unit?: string;
  color?: string;
  decimals?: number;
  footer?: ReactNode;
}) {
  const summary = summarizeSeries(data);
  const deltaSign = summary && summary.delta > 0 ? "+" : "";
  return (
    <div className="card">
      <div className="mb-2 flex items-center justify-between gap-2">
        <Link
          href={href}
          className="font-semibold text-slate-800 transition hover:text-brand-700 hover:underline dark:text-slate-100 dark:hover:text-brand-300"
        >
          {title}
        </Link>
        {summary && (
          <span className="flex items-center gap-1 whitespace-nowrap text-sm">
            <span className="font-semibold text-slate-900 dark:text-slate-100">
              {round(summary.last, decimals)}
              {unit}
            </span>
            {summary.direction !== "flat" && summary.count > 1 && (
              <span
                className={`flex items-center gap-0.5 text-xs ${
                  summary.direction === "up"
                    ? "text-emerald-600 dark:text-emerald-400"
                    : "text-rose-600 dark:text-rose-400"
                }`}
              >
                {summary.direction === "up" ? (
                  <IconArrowUpRight className="h-3.5 w-3.5" stroke={2} />
                ) : (
                  <IconArrowDownRight className="h-3.5 w-3.5" stroke={2} />
                )}
                {deltaSign}
                {round(summary.delta, decimals)}
              </span>
            )}
          </span>
        )}
      </div>
      {data.length === 0 ? (
        <div className="flex h-40 items-center justify-center text-sm text-slate-400 dark:text-slate-500">
          No data in this range
        </div>
      ) : (
        <LineChartCard
          data={data}
          label={label}
          unit={unit}
          color={color}
          heightClass="h-40"
        />
      )}
      {footer && <div className="mt-2 flex justify-end">{footer}</div>}
    </div>
  );
}
