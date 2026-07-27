import Link from "next/link";
import type { ReactNode } from "react";
import { IconArrowDownRight, IconArrowUpRight } from "@tabler/icons-react";
import LineChartCard from "./LineChartCard";
import BarSparkline from "./BarSparkline";
import type { SparklineShape } from "@/lib/trend-sparkline";
import { round } from "@/lib/units";
import { robustSeriesSummary } from "@/lib/trends-digest";
import { biomarkerAxisDomain } from "@/lib/reference-range";
import type { AppRoute } from "@/lib/hrefs";

// A compact trend tile for the Trends hub's Overview grid: the latest value with a
// net-change badge over the visible window, its linked name, and a small sparkline.
// The data is pre-windowed and already in display units by the caller (the hub
// converts kg/km at the boundary), so this component only formats and draws it. An
// optional `menu` slot holds the tile's own controls (the ★ save toggle and, on a
// saved tile, its reorder items — #1456), rendered in the CORNER.
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
// VALUE-LED HIERARCHY + CORNER CONTROLS (#1485 B). Two more bands of the tile were
// spent on things that aren't the answer:
//
//   • The title and the value carried EQUAL weight (both `font-semibold`, the title
//     first), so a grid of tiles read as a list of names. The stat-tile hierarchy is
//     now the usual one — the latest value is the largest text (`tabular-nums`), the
//     name is the small secondary label above it, and the change badge stays small
//     beside the value. Pairs with the two-column phone grid: dominant numbers scan
//     at a glance where a column of names does not.
//   • The controls sat in a ~90px FOOTER ROW under the chart, per tile. They moved
//     into the corner ⋯ overflow menu (the #1488/#1491 standard), which is the same
//     40px hit box every other row action uses and costs the tile no vertical band.
//     The sparkline shortened with them (h-32 → h-20): with the value promoted to a
//     headline, the plot's job is the SHAPE of the move, not its magnitude.
//
// COMPACT VARIANT (#1485 A): a tile with nothing to show at all — a saved analyte
// that has never been measured — renders as a ONE-LINE row instead of a ~300px
// card of whitespace. It is still a `TrendMiniCard` (same testid, same menu), so
// the #1456 guarantee that a saved item's unstar control stays reachable holds;
// this is compaction, not omission. The caller decides (it also sinks those rows
// below the populated tiles) — the sparse fallback below is NOT compacted, because
// it carries a real number.
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
  menu,
  compact = false,
  applyBiomarkerDomain = false,
  outsideWindow = null,
  sparklineShape = "line",
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
  // The tile's corner ⋯ menu (star / reorder). Omitted by tile grids that carry no
  // per-tile controls (the Body tab's).
  menu?: ReactNode;
  // Render as a one-line row rather than a card (#1485 A). Only meaningful for a
  // tile with no points AND no out-of-window reading.
  compact?: boolean;
  // Overridable card test hook (defaults to the generic "trend-mini-card"); the
  // Body tile grid passes a per-metric id (`body-tile-steps`) so a spec can open a
  // specific tile's detail page.
  testid?: string;
  // For a biomarker-sourced tile (issue #407): thread the SHARED axis-domain policy
  // through to the sparkline so it scales the same series identically to the detail
  // chart (0-clamp for a non-negative analyte; a flat/near-flat series gets a small
  // window) instead of recharts' bare ["auto","auto"]. Metric tiles leave it off.
  applyBiomarkerDomain?: boolean;
  // #1485 G: the latest reading BEHIND the window, for a series with no points in
  // it. Optional and off by default, so the range-driven Overview tiles opt in
  // while BodyMetricTiles keeps the plain empty state. Rendered only when `data`
  // is empty — it is a fallback FOR the empty state, never an annotation on a
  // drawn series.
  outsideWindow?: { text: string; age: string } | null;
  // Which MARK the sparkline draws (#1485 D). Decided ONCE, per series, by
  // lib/trend-sparkline.ts — a tile grid passes the answer through rather than
  // re-deciding. "line" (the default) is a level; "bar" is a per-day quantity whose
  // missing days are real zeros, where a line would draw a slope through a rest day.
  sparklineShape?: SparklineShape;
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

  const titleLink = (
    <Link
      href={href}
      className="truncate text-sm font-medium text-slate-500 transition hover:text-brand-700 hover:underline dark:text-slate-400 dark:hover:text-brand-300"
    >
      {title}
    </Link>
  );

  // The one-line variant: name · "no data in this range" · the same corner menu.
  if (compact) {
    return (
      <div
        className="card flex items-center justify-between gap-2 py-1.5 sm:py-1.5"
        data-testid={testid}
      >
        <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
          {titleLink}
          <span className="truncate text-xs text-slate-500 dark:text-slate-400">
            No data in this range
          </span>
        </span>
        {menu}
      </div>
    );
  }

  return (
    <div className="card" data-testid={testid}>
      <div className="flex items-start justify-between gap-1">
        <div className="flex min-w-0 flex-col">
          {titleLink}
          {latest != null ? (
            <span className="flex flex-wrap items-baseline gap-1.5">
              <span className="text-2xl font-semibold leading-tight tabular-nums text-slate-900 dark:text-slate-100">
                {round(latest, decimals)}
                {unit}
              </span>
              {summary && summary.material && (
                <span
                  className={`flex items-center gap-0.5 whitespace-nowrap text-xs ${
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
          ) : outsideWindow ? (
            // Sparse-series fallback (#1485 G). The window is genuinely empty, so
            // there is nothing to plot — but the series has history, and the latest
            // reading is the number the tile exists to show. It takes the headline
            // slot in the muted tone, ALWAYS with its age and an explicit "outside
            // this range": the value is real, its currency is not, and the label is
            // what keeps a five-month-old reading from being read as today's.
            <span
              className="flex min-w-0 flex-col"
              data-testid="trend-mini-outside-window"
            >
              <span className="text-2xl font-semibold leading-tight tabular-nums text-slate-600 dark:text-slate-300">
                {outsideWindow.text}
              </span>
              <span className="text-xs text-slate-500 dark:text-slate-400">
                {outsideWindow.age} · outside this range
              </span>
            </span>
          ) : (
            <span className="text-sm text-slate-500 dark:text-slate-400">
              No data in this range
            </span>
          )}
        </div>
        {menu}
      </div>
      {data.length > 0 && (
        <div className="mt-2" data-sparkline-shape={sparklineShape}>
          {sparklineShape === "bar" ? (
            <BarSparkline
              data={data}
              label={label}
              unit={unit}
              color={color}
              decimals={decimals}
              heightClass="h-20"
            />
          ) : (
            <LineChartCard
              data={data}
              label={label}
              unit={unit}
              color={color}
              decimals={decimals}
              heightClass="h-20"
              yDomain={yDomain}
              sparkline
            />
          )}
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
        </div>
      )}
    </div>
  );
}
