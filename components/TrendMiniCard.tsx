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
// draws it. An optional `footer` slot holds per-tile controls (the ★ save toggle
// and, on a saved tile, its reorder buttons — #1456).
//
// TRUE SPARKLINE (#1445). This called itself a sparkline while rendering the FULL
// LineChartCard at h-40 — so every tile carried a complete X+Y axis, with 11px
// ticks and margins sized for a 256px-tall chart crammed into a ~150px-wide tile
// on a 390px phone. The ticks collided with each other and the plot got whatever
// was left. It now asks LineChartCard for its `sparkline` variant (no grid, no
// axes, near-zero margins) and renders the numbers those axes were there to
// supply — min / max / latest — as inline TEXT under the plot, which is legible
// at any width. Same component, same data, same testids; the chart just stops
// spending the tile on chrome.
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
  testid = "trend-mini-card",
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
  // Overridable card test hook (defaults to the generic "trend-mini-card"); the
  // Body tile grid passes a per-metric id (`body-tile-steps`) so a spec can open a
  // specific tile's detail page.
  testid?: string;
  // For a biomarker-sourced tile (issue #407): thread the SHARED axis-domain policy
  // through to the sparkline so it scales the same series identically to the detail
  // chart (0-clamp for a non-negative analyte; a flat/near-flat series gets a small
  // window) instead of recharts' bare ["auto","auto"]. Metric tiles leave it off.
  applyBiomarkerDomain?: boolean;
}) {
  const values = data.map((d) => d.value).filter((v): v is number => v != null);
  const latest = values.length > 0 ? values[values.length - 1] : null;
  // The window's extremes, which the (now hidden) Y axis used to imply. Shown as
  // text so the tile still answers "how big is this swing?" without an axis.
  const lo = values.length > 0 ? Math.min(...values) : null;
  const hi = values.length > 0 ? Math.max(...values) : null;
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
    <div className="card" data-testid={testid}>
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
        <div className="flex h-32 items-center justify-center text-sm text-slate-500 dark:text-slate-400">
          No data in this range
        </div>
      ) : (
        <>
          <LineChartCard
            data={data}
            label={label}
            unit={unit}
            color={color}
            decimals={decimals}
            heightClass="h-32"
            yDomain={yDomain}
            sparkline
          />
          {lo != null && hi != null && (
            <div
              className="mt-1 flex items-baseline justify-between gap-2 text-xs tabular-nums text-slate-500 dark:text-slate-400"
              data-testid="trend-mini-range"
            >
              <span>
                Low {round(lo, decimals)}
                {unit}
              </span>
              <span>
                High {round(hi, decimals)}
                {unit}
              </span>
            </div>
          )}
        </>
      )}
      {footer && <div className="mt-2 flex justify-end">{footer}</div>}
    </div>
  );
}
