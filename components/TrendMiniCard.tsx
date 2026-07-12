import Link from "next/link";
import type { ReactNode } from "react";
import { IconArrowDownRight, IconArrowUpRight } from "@tabler/icons-react";
import LineChartCard from "./LineChartCard";
import { round } from "@/lib/units";
import { robustSeriesSummary } from "@/lib/trends-digest";
import { biomarkerAxisDomain } from "@/lib/reference-range";
import type { AppRoute } from "@/lib/hrefs";

// A compact trend tile for the Trends hub's Overview grid: a linked title, the
// latest value with a net-change badge over the visible window, and a small
// sparkline. The data is pre-windowed and already in display units by the caller
// (the hub converts kg/km at the boundary), so this component only formats and
// draws it. Reuses LineChartCard for the sparkline. An optional `footer` slot
// holds per-tile controls (the Phase-2 pin toggle).
//
// The change badge is driven by robustSeriesSummary — the SAME robust-endpoint
// computation the "what's trending" digest above uses (#398) — so the tile's arrow
// and the digest chip can't disagree: a move below the materiality bar (or a lone
// noisy endpoint) shows no arrow here just as it produces no chip there. The
// headline stays the LITERAL latest reading (deduped upstream, #395), not the
// robust endpoint, so the tile still names the current value.
export default function TrendMiniCard({
  title,
  href,
  data,
  label,
  unit = "",
  color,
  decimals = 1,
  range = null,
  minPctChange,
  footer,
  applyBiomarkerDomain = false,
}: {
  title: string;
  href: AppRoute;
  data: { date: string; value: number | null }[];
  label: string;
  unit?: string;
  color?: string;
  decimals?: number;
  range?: { low: number | null; high: number | null } | null;
  minPctChange?: number;
  footer?: ReactNode;
  // For a biomarker-sourced tile (issue #407): thread the SHARED axis-domain policy
  // through to the sparkline so it scales the same series identically to the detail
  // chart (0-clamp for a non-negative analyte; a flat/near-flat series gets a small
  // window) instead of recharts' bare ["auto","auto"]. Metric tiles leave it off.
  applyBiomarkerDomain?: boolean;
}) {
  const values = data.map((d) => d.value).filter((v): v is number => v != null);
  const latest = values.length > 0 ? values[values.length - 1] : null;
  const summary = robustSeriesSummary({ points: data, range, minPctChange });
  // The tile draws no reference bands, so band-inclusion is moot — only the
  // value-and-range-driven [lo, hi] matters. Skipped when there are no points.
  const yDomain =
    applyBiomarkerDomain && values.length > 0
      ? ((): [number, number] => {
          const { lo, hi } = biomarkerAxisDomain(values, {
            refLow: range?.low ?? null,
            refHigh: range?.high ?? null,
          });
          return [lo, hi];
        })()
      : undefined;
  const deltaSign = summary && summary.absChange > 0 ? "+" : "";
  return (
    <div className="card" data-testid="trend-mini-card">
      <div className="mb-2 flex items-center justify-between gap-2">
        <Link
          href={href}
          className="font-semibold text-slate-800 transition hover:text-brand-700 hover:underline dark:text-slate-100 dark:hover:text-brand-300"
        >
          {title}
        </Link>
        {latest != null && (
          <span className="flex items-center gap-1 whitespace-nowrap text-sm">
            <span className="font-semibold text-slate-900 dark:text-slate-100">
              {round(latest, decimals)}
              {unit}
            </span>
            {summary && summary.material && (
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
                {round(summary.absChange, decimals)}
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
          decimals={decimals}
          heightClass="h-40"
          yDomain={yDomain}
        />
      )}
      {footer && <div className="mt-2 flex justify-end">{footer}</div>}
    </div>
  );
}
