import Link from "next/link";
import type { ReactNode } from "react";
import { IconArrowDownRight, IconArrowUpRight } from "@tabler/icons-react";
import LineChartCard from "./LineChartCard";
import BarSparkline from "./BarSparkline";
import { loneReading } from "@/lib/trend-sparkline";
import type { DayFillSpec, SparklineShape } from "@/lib/trend-sparkline";
import SingleReadingMark from "./SingleReadingMark";
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
// The old COMPACT VARIANT (#1485 A) remains available to non-grid callers, but the
// saved Overview grid no longer uses it: #2153 keeps an empty tile in its saved
// slot at the same minimum geometry as every other card. The sparse fallback below
// is also full-size because it carries a real number.
//
// The change badge is driven by robustSeriesSummary — the SAME robust-endpoint
// computation the "what's trending" digest above uses (#398) — so the tile's arrow
// and the digest chip can't disagree: a move below the materiality bar (or a lone
// noisy endpoint) shows no arrow here just as it produces no chip there. The
// headline stays the LITERAL latest reading (deduped upstream, #395), not the
// robust endpoint, so the tile still names the current value.
export default function TrendMiniCard({
  title,
  mobileTitle,
  href,
  data,
  unit = "",
  color,
  decimals = 1,
  range = null,
  minPctChange,
  headline,
  showChange = true,
  menu,
  compact = false,
  applyBiomarkerDomain = false,
  yDomain,
  emptyMessage = "No data in this range",
  outsideWindow = null,
  readingDateLabel,
  sparklineShape = "line",
  singleReadingAsChart = false,
  gapFill,
  testid = "trend-mini-card",
}: {
  title: string;
  // Compact surfaces use the registry's short label on phones while retaining the
  // full chart title on larger screens. Omitted for non-registry series such as
  // biomarkers, where `title` is already the canonical display name.
  mobileTitle?: string;
  href: AppRoute;
  data: { date: string; value: number | null }[];
  unit?: string;
  color?: string;
  decimals?: number;
  range?: { low: number | null; high: number | null } | null;
  minPctChange?: number;
  // Optional semantic headline for a metric whose latest value is not honestly
  // expressed as number+unit (for example an ordinal growth percentile).
  headline?: ReactNode;
  // Percentile movement is not inherently good or bad, so composite growth turns
  // off the green/red directional badge while retaining its plotted trajectory.
  showChange?: boolean;
  // The tile's corner ⋯ menu (star / reorder). Omitted by tile grids that carry no
  // per-tile controls (the body census).
  menu?: ReactNode;
  // Render as a one-line row rather than a card (#1485 A). Only meaningful for a
  // tile with no points AND no out-of-window reading.
  compact?: boolean;
  // The tile's day-grain calendar fill (#2258). A sparkline follows the SERIES'
  // declaration, not the tile's: the same registry that picks the mark picks the
  // gap, so a tile and the full chart it links to draw the same shape. Omitted for
  // a series with no calendar grain (biomarker tiles are declared exempt anyway).
  gapFill?: DayFillSpec;
  // Overridable card test hook (defaults to the generic "trend-mini-card"); the
  // Body tile grid passes a per-metric id (`body-tile-steps`) so a spec can open a
  // specific tile's detail page.
  testid?: string;
  // For a biomarker-sourced tile (issue #407): thread the SHARED axis-domain policy
  // through to the sparkline so it scales the same series identically to the detail
  // chart (0-clamp for a non-negative analyte; a flat/near-flat series gets a small
  // window) instead of recharts' bare ["auto","auto"]. Metric tiles leave it off.
  applyBiomarkerDomain?: boolean;
  // Explicit chart scale for bounded domains such as a percentile (0–100).
  yDomain?: [number, number];
  // Optional reason for a chart-shaped empty state that is not range-driven
  // (growth references can be age-inapplicable).
  emptyMessage?: string;
  // #1485 G: the latest reading BEHIND the window, for a series with no points in
  // it. Optional and off by default, so the range-driven Overview tiles opt in
  // while TrendMetricTiles keeps the plain empty state. Rendered only when `data`
  // is empty — it is a fallback FOR the empty state, never an annotation on a
  // drawn series.
  outsideWindow?: {
    date: string;
    text: string;
    age: string;
    rangeLabel?: string;
  } | null;
  // Pref-formatted calendar date for the single reading represented by the
  // marker. The raw ISO date stays on <time dateTime>; callers own display prefs.
  readingDateLabel?: string;
  // Which MARK the sparkline draws (#1485 D). Decided ONCE, per series, by
  // lib/trend-sparkline.ts — a tile grid passes the answer through rather than
  // re-deciding. "line" (the default) is a level; "bar" is a per-day quantity whose
  // missing days are real zeros, where a line would draw a slope through a rest day.
  sparklineShape?: SparklineShape;
  // Keep a one-point line series chart-shaped. Sleep uses this because its tile is
  // a chart at every range; ordinary sparse metrics use the denser value marker.
  singleReadingAsChart?: boolean;
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
  const chartYDomain =
    yDomain ??
    (applyBiomarkerDomain && values.length > 0
      ? ((): [number, number] => {
          const { lo, hi } = biomarkerAxisDomain(values, {
            refLow: range?.low ?? null,
            refHigh: range?.high ?? null,
          });
          return [lo, hi];
        })()
      : undefined);
  const deltaSign = summary && summary.absChange > 0 ? "+" : "";
  const isEmpty = latest == null && outsideWindow == null;
  // A line needs two points to describe a direction. Recharts' sparkline mode
  // deliberately hides per-point dots, so a one-reading series previously spent
  // 80px on a completely blank plot and then printed the same value as both Low
  // and High. Sparse biomarkers had the same awkward empty lower half when their
  // latest reading sat outside the selected range. Give both honest value-only
  // states a deliberate single-marker treatment instead.
  //
  // `loneReading` is the shared predicate (#2615 item 3) — the SAME one the full
  // chart cards now degrade on, so a tile and the card it taps through to cannot
  // draw one reading two ways. Equivalent to the `values.length === 1` it replaces:
  // both count non-null points.
  const lone = loneReading(data);
  const showSingleReading =
    outsideWindow != null ||
    (sparklineShape === "line" && lone != null && !singleReadingAsChart);
  const readingDate =
    outsideWindow?.date ??
    (sparklineShape === "line" ? (lone?.date ?? null) : null);
  const footerTextClass =
    "text-xs tabular-nums text-slate-500 dark:text-slate-400";

  // The one-line variant: name · "no data in this range" · the same corner menu.
  if (compact) {
    return (
      <div
        className="card flex items-stretch overflow-hidden p-0!"
        data-testid={testid}
      >
        <Link
          href={href}
          data-testid="trend-mini-header-link"
          className="group flex min-h-14 min-w-0 flex-1 flex-col justify-center gap-0.5 px-4 py-2.5 transition-colors hover:bg-brand-50/80 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-brand-500 sm:px-5 dark:hover:bg-brand-950/40"
        >
          <span
            // Same breakpoint swap, same fix as the full variant's title below.
            className="truncate text-sm font-medium text-slate-500 group-hover:text-brand-700 group-hover:underline sm:wrap-anywhere sm:whitespace-normal dark:text-slate-400 dark:group-hover:text-brand-300"
            title={title}
          >
            {mobileTitle && mobileTitle !== title ? (
              <>
                <span className="sm:hidden">{mobileTitle}</span>
                <span className="hidden sm:inline">{title}</span>
              </>
            ) : (
              title
            )}
          </span>
          <span className="truncate text-xs text-slate-500 dark:text-slate-400">
            No data in this range
          </span>
        </Link>
        {menu && (
          <div className="flex shrink-0 items-center px-2 sm:px-3">{menu}</div>
        )}
      </div>
    );
  }

  const value =
    latest != null ? (
      <span className="flex flex-wrap items-baseline gap-1.5 sm:shrink-0 sm:flex-nowrap sm:whitespace-nowrap">
        <span className="text-2xl font-semibold leading-tight tabular-nums text-slate-900 dark:text-slate-100">
          {headline ?? (
            <>
              {round(latest, decimals)}
              {unit}
            </>
          )}
        </span>
        {showChange && summary && summary.material && (
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
      // Sparse-series fallback (#1485 G). The window is genuinely empty, so there
      // is nothing to plot — but the series has history, and the latest reading is
      // the number the tile exists to show. It takes the headline slot in the muted
      // tone, ALWAYS with its age and an explicit "outside this range": the value is
      // real, its currency is not.
      <span
        className="flex min-w-0 flex-col sm:items-end"
        data-testid="trend-mini-outside-window"
      >
        <span className="text-2xl font-semibold leading-tight tabular-nums text-slate-600 dark:text-slate-300">
          {outsideWindow.text}
        </span>
        <span className="text-xs text-slate-500 dark:text-slate-400">
          {outsideWindow.age} · outside {outsideWindow.rangeLabel ?? "selected"}{" "}
          range
        </span>
      </span>
    ) : (
      <span className="text-sm text-slate-500 dark:text-slate-400">
        {emptyMessage}
      </span>
    );

  return (
    <div className="card flex h-full min-h-48 flex-col" data-testid={testid}>
      <div className="-mx-4 -mt-4 flex items-start sm:-mx-5 sm:-mt-5">
        <Link
          href={href}
          data-testid="trend-mini-header-link"
          className={`group flex min-h-11 min-w-0 flex-1 flex-col justify-center gap-0.5 rounded-tl-xl px-4 py-2.5 text-sm font-medium text-slate-500 transition-colors hover:bg-brand-50/80 hover:text-brand-800 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-brand-500 sm:px-5 dark:text-slate-400 dark:hover:bg-brand-950/40 dark:hover:text-brand-300 ${
            isEmpty
              ? ""
              : "sm:flex-row sm:items-baseline sm:justify-between sm:gap-3"
          } ${menu ? "" : "rounded-tr-xl"}`}
        >
          <span
            // `truncate` is the MOBILE contract (nowrap + ellipsis in a one-line
            // box) and it reads correctly there. From `sm:` the title WRAPS
            // instead — but `truncate`'s `overflow: hidden` comes along, and
            // `sm:text-clip` took the ellipsis away, so a token wider than the
            // line box was cut mid-glyph with nothing to signal the loss:
            // `Lipoprotein(` for `Lipoprotein(a)`, `Trainir`/`Volum` for
            // `Training Volume` (#2523). The `(a)` is the entire distinction
            // between Lp(a) and ordinary lipoprotein, so that render is not
            // truncation, it is a WRONG LABEL — and the box is narrowest on the
            // tiles carrying the most value+delta context, which is backwards.
            //
            // `wrap-anywhere` (`overflow-wrap: anywhere`) gives an unbreakable
            // token break opportunities, so the whole name renders across lines
            // and nothing is lost; the ellipsis stays behind it for anything that
            // still cannot fit. Below `sm:` this is inert — `white-space: nowrap`
            // leaves nothing to wrap.
            className="min-w-0 truncate group-hover:underline sm:flex-1 sm:wrap-anywhere sm:whitespace-normal sm:text-base sm:font-semibold"
            title={title}
          >
            {mobileTitle && mobileTitle !== title ? (
              <>
                <span className="sm:hidden">{mobileTitle}</span>
                <span className="hidden sm:inline">{title}</span>
              </>
            ) : (
              title
            )}
          </span>
          {value}
        </Link>
        {menu && <div className="shrink-0 px-2 py-1.5 sm:px-3">{menu}</div>}
      </div>
      {showSingleReading ? (
        <SingleReadingMark
          color={color}
          testid="trend-mini-single-reading"
          markTestid="trend-mini-single-marker"
          readingScope={outsideWindow ? "outside" : "inside"}
          captionClassName={footerTextClass}
          caption={
            readingDate && readingDateLabel ? (
              <>
                {outsideWindow ? "Latest recorded" : "Single reading"} ·{" "}
                <time dateTime={readingDate}>{readingDateLabel}</time>
              </>
            ) : outsideWindow ? (
              "Latest recorded value"
            ) : (
              "Single reading in this range"
            )
          }
        />
      ) : (
        data.length > 0 && (
          <div className="mt-auto pt-2" data-sparkline-shape={sparklineShape}>
            {sparklineShape === "bar" ? (
              <BarSparkline
                data={data}
                label={title}
                unit={unit}
                color={color}
                decimals={decimals}
                heightClass="h-20"
                gapFill={gapFill}
              />
            ) : (
              <LineChartCard
                data={data}
                label={title}
                unit={unit}
                color={color}
                decimals={decimals}
                heightClass="h-20"
                yDomain={chartYDomain}
                gapFill={gapFill}
                sparkline
                // Dots are part of the shared tile grammar. The chart scaffold
                // still suppresses them for genuinely dense series.
                sparklineDots
              />
            )}
            {lo != null && hi != null && (
              <div
                className={`mt-1 flex items-baseline justify-between gap-2 ${footerTextClass}`}
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
        )
      )}
    </div>
  );
}
