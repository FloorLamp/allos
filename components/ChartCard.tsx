import Link from "next/link";
import type { ReactNode } from "react";
import { IconArrowsMaximize } from "@tabler/icons-react";
import type { AppRoute } from "@/lib/hrefs";

// THE full-size chart card (issue #1488).
//
// PROBLEM. Overview TILES linked to a detail page, but every full-size chart on the
// Trends tabs was a dead end: a `<div className="card">` + an `<h2>` + a plot, hand-
// assembled at ~20 call sites, with no route to the full-depth view (bigger plot,
// range control, annotations, the readings themselves). "Does this card go anywhere?"
// was decided independently at each site, so the answer drifted to "no" by default.
//
// THE TAP CONTRACT (owner-picked over tap-anywhere).
//
//   • The HEADER ROW navigates — the title plus the latest-value headline, one large
//     target — and a small EXPAND ICON sits top-right for explicitness, with an
//     accessible name (the #794-7a icon-button rule).
//   • The PLOT AREA IS NOT A LINK. On touch, tapping the plot is how you read a
//     point; that gesture must stay tooltip inspection and must never become
//     navigation. `children` is rendered as a plain sibling of the header link —
//     there is no wrapping anchor anywhere near the plot, which is what preserves
//     recharts' own pointer handling.
//
// THE GUARD. `detailHref` is REQUIRED and may be `null` only with a same-line
// `detail-none: <why>` justification comment (the `first-ok` pattern) — pinned by the
// pure source scan `lib/__tests__/chart-detail-href.test.ts`, which also fails a
// Trends chart rendered outside this card. A new chart cannot ship as a dead end
// silently.
//
// SQUARE ON MOBILE (owner-added 2026-07-26). Below `sm` the plot commits to a 1:1
// aspect in EVERY state — populated, empty, loading, error, offline-fallback — in
// place of the per-call-site height vocabulary (h-24 / h-32 / h-40 / h-64) that made
// a single-column stack reflow whenever one series happened to be empty. From `sm` up
// the box takes `plotHeightClass` (default `sm:h-64`), so DESKTOP PROPORTIONS ARE
// UNCHANGED — the square rule is mobile-only by design.
//
// The aspect rides the PLOT BOX rather than the whole card, which is what makes the
// rule survive the cards that carry real content under the plot (the HR-zones card's
// Zone-2 adherence line, easy/hard split and zone table; a goal-projection caption).
// Squaring the outer card would have to take that footer's height OUT of the plot,
// so a footer-heavy card would render a squeezed 60px plot inside a 358px square —
// regularity bought by destroying the chart. Square plot + the card growing for its
// footer delivers what the rule is FOR (one rhythm down a stack; an empty chart
// occupying exactly the footprint the populated one will) with nothing squeezed:
// two cards of the same shape still have identical bounding boxes whether their
// series are populated or empty, which is the property the browser test pins.
//
// The plot box carries `.chart-card-plot` (app/globals.css), whose `> *` rule sizes
// whatever the caller renders to the box. That is deliberate: the card OWNS the plot
// height, so a call site can't silently reintroduce its own fixed inner height, and
// the chart's loading / error / empty fallbacks — separate DOM subtrees, each with
// its own `h-*` — all land on the same footprint without a prop threaded through
// three components.

// For the rare call site that puts a WRAPPER between the plot slot and the chart (the
// full-bleed intraday panel): `.chart-card-plot > *` only reaches the direct child, so
// the chart itself needs to be told to fill it. Pass this as `heightClass` — never a
// fixed `h-*`, which is exactly the per-call-site height vocabulary the card removed.
export const CHART_PLOT_FILL = "h-full";

export default function ChartCard({
  title,
  headingLevel = "h2",
  hideTitle = false,
  headline,
  description,
  note,
  detailHref,
  detailTitle,
  headerAction,
  anchorId,
  testid,
  className = "",
  headerClassName = "",
  surfaceClass = "card",
  plotHeightClass = "sm:h-64",
  footer,
  children,
}: {
  title: string;
  // The card title's heading level. `h2` (the default) for a card that sits directly
  // on a tab; `h3` for one nested under a section heading, so the document outline
  // stays honest.
  headingLevel?: "h2" | "h3";
  // Stop PAINTING the title, without removing it (#1541 fix 3). The one caller is
  // the metric detail page's own chart, whose <h1> is already this exact string —
  // a visible card heading there is the #1533 echo. The heading element stays in
  // the DOM as `sr-only`, so the document outline and the accessible name of the
  // card are unchanged; only the visual duplicate goes. Never use it to hide a
  // title a reader would otherwise need.
  hideTitle?: boolean;
  // The latest-value headline (#1485 B) — part of the tap target, inside the header
  // link. A string or a small node; omitted where the section has no single latest.
  headline?: ReactNode;
  // A one-line explanation under the title, inside the tap target.
  description?: ReactNode;
  // An honesty caption ABOVE the plot, OUTSIDE the tap target (it is often long).
  note?: ReactNode;
  // Where the card taps through to. `null` is legal ONLY with a same-line
  // `detail-none: <why>` comment at the call site — see the guard scan.
  detailHref: AppRoute | null;
  // Overrides the noun in the expand icon's accessible name, when the visible title
  // reads badly in "Open X detail" (a title carrying a date, say).
  detailTitle?: string;
  // A right-aligned affordance beside the expand icon (a cross-link to another
  // surface). Rendered OUTSIDE the header link so its own href still wins.
  headerAction?: ReactNode;
  // Stable in-page anchor (the Body tab's jump chips).
  anchorId?: string;
  testid?: string;
  className?: string;
  // Extra classes on the HEADER row alone — the full-bleed intraday card re-adds the
  // gutter its surface drops, so the title/expand pair stays inset while the plot
  // runs edge to edge.
  headerClassName?: string;
  // The card's own SURFACE class, for the one card that isn't a plain `.card` — the
  // Body tab's full-bleed intraday panel, which spends the phone's full viewport
  // width on the plot. Everything else keeps the default.
  surfaceClass?: string;
  // The DESKTOP plot height (`sm:` and up). Mobile is always the square.
  plotHeightClass?: string;
  // Rendered under the plot (a goal-projection caption, a legend, a footnote).
  footer?: ReactNode;
  // The plot. Never wrapped in a link — see the tap contract above.
  children: ReactNode;
}) {
  const Heading = headingLevel;
  const heading = (
    <>
      <Heading
        className={
          hideTitle
            ? "sr-only"
            : "truncate font-semibold text-slate-800 dark:text-slate-100"
        }
      >
        {title}
      </Heading>
      {headline != null && (
        <span
          className="text-lg font-semibold leading-tight tabular-nums text-slate-900 dark:text-slate-100"
          data-testid="chart-card-headline"
        >
          {headline}
        </span>
      )}
      {description != null && (
        <span className="text-xs text-slate-500 dark:text-slate-400">
          {description}
        </span>
      )}
    </>
  );

  return (
    <div
      id={anchorId}
      data-testid={testid}
      className={`${surfaceClass} ${
        anchorId ? "scroll-mt-28 " : ""
      }${className}`}
    >
      <div
        className={`mb-2 flex items-start justify-between gap-2 sm:mb-3 ${headerClassName}`}
      >
        {detailHref ? (
          <Link
            href={detailHref}
            data-testid="chart-card-header-link"
            className="group -m-1 flex min-w-0 flex-1 flex-col rounded-lg p-1 transition hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
          >
            {heading}
          </Link>
        ) : (
          <div className="flex min-w-0 flex-1 flex-col">{heading}</div>
        )}
        <div className="flex shrink-0 items-center gap-1">
          {headerAction}
          {detailHref && (
            <Link
              href={detailHref}
              data-testid="chart-card-expand"
              aria-label={`Open ${detailTitle ?? title} detail`}
              className="tap-target press inline-flex h-8 w-8 items-center justify-center rounded-lg text-slate-500 transition hover:bg-slate-100 hover:text-brand-700 dark:text-slate-400 dark:hover:bg-ink-800 dark:hover:text-brand-300"
            >
              <IconArrowsMaximize className="h-4 w-4" aria-hidden />
            </Link>
          )}
        </div>
      </div>

      {note != null && (
        <p
          className={`mb-2 text-xs text-slate-500 dark:text-slate-400 sm:mb-3 ${headerClassName}`}
        >
          {note}
        </p>
      )}

      {/* The plot. A plain sibling of the header link — no anchor wraps it, so a tap
          here is tooltip inspection, not navigation. */}
      <div
        data-testid="chart-card-plot"
        className={`chart-card-plot aspect-square min-w-0 sm:aspect-auto ${plotHeightClass}`}
      >
        {children}
      </div>

      {footer}
    </div>
  );
}
