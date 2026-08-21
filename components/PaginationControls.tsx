"use client";

import { PendingTextLink } from "@/components/PendingLink";
import type { AppRoute } from "@/lib/hrefs";

// The app's ONE pager footer: "Showing 1–10 of 812 · Prev · Page 1 of 82 · Next".
//
// Two navigation modes, and they are exclusive because the two kinds of bound are
// different (#2530/#2445):
//
//   • `onPageChange` — a client table that already holds every row and pages it in
//     memory (the sleep↔mood history). The page is component state.
//   • `prevHref` / `nextHref` — a SERVER-paged read whose page rides the URL (the
//     Trends body history, the cross-item dose ledger, /whats-new, and the two
//     admin log viewers). The links are plain anchors, so the pager works without
//     JS, is bookmarkable, and the page boundary reaches the QUERY instead of only
//     the DOM.
//
// The arithmetic behind both is lib/pagination.ts — the pager never derives a page
// count of its own.
//
// ── TWO SHAPES, ONE PAGER (issue #3378) ──────────────────────────────────────
//
// This was the desktop footer idiom at every width: ~36px `btn-ghost text-sm`
// controls bunched into the row's right half, which on a phone is three small
// words a thumb has to pick between. Below `md` it renders the THUMB shape —
// Prev and Next as 44px controls at the row's two EDGES, as far apart as the row
// allows, with the extent between them. From `md` up the footer is unchanged.
//
// It is ONE set of controls at both widths, re-ORDERED, never a `md:hidden` /
// `hidden md:flex` pair: a second copy of Prev is a second control in the
// accessibility tree and a second thing for a spec's `getByRole` to find. The
// "Page X of Y" sentence is the only thing that hides, because the phone row has
// room for one piece of text between two thumb targets and the extent is the half
// that says something the page number does not.
//
// Deliberately NOT infinite scroll, recorded so it is not re-derived (#3378):
// these are records lists where position and totals matter — an 82-page dose
// ledger is an audit surface, not a feed — and a pager keeps the census countable.
export default function PaginationControls({
  page,
  pageCount,
  pageSize,
  total,
  visibleCount,
  onPageChange,
  prevHref,
  nextHref,
  testId,
  totalTestId,
  unit,
}: {
  page: number;
  pageCount: number;
  pageSize: number;
  total: number;
  visibleCount: number;
  onPageChange?: (page: number) => void;
  // Link mode: the target URL for the neighbouring page, or null at the ends.
  prevHref?: AppRoute | null;
  nextHref?: AppRoute | null;
  testId?: string;
  // Names the TOTAL on its own, for a surface that asserts "how many are there"
  // independently of which page is showing (the two admin log viewers).
  totalTestId?: string;
  // What is being counted, when the surface's own noun is not the default. The
  // audit viewer counts events, the notify-tick viewer counts runs; everything
  // else reads as the bare "Showing 1–10 of 812" it always has.
  unit?: string;
}) {
  if (total === 0) return null;
  const start = (page - 1) * pageSize;

  // The thumb floor (#644/#3378): a real 44px box below `md`, not the
  // `tap-target` pseudo-element — that extension is coarse-pointer-only and
  // invisible to a layout measurement. "Next, next, next" through 82 pages is the
  // most repeatedly tapped control on these surfaces, and it was ~36px. From `md`
  // up the control is the `btn-ghost text-sm` it has always been.
  const STEP_CLASS =
    "btn-ghost min-h-11 min-w-16 text-sm md:min-h-0 md:min-w-0";

  const step = (label: string, delta: -1 | 1, href: AppRoute | null) => {
    const disabled = delta < 0 ? page <= 1 : page >= pageCount;
    if (onPageChange) {
      return (
        <button
          type="button"
          className={STEP_CLASS}
          disabled={disabled}
          onClick={() => onPageChange(page + delta)}
        >
          {label}
        </button>
      );
    }
    return disabled || !href ? (
      <span className={`${STEP_CLASS} opacity-40`}>{label}</span>
    ) : (
      // Link mode answers the tap (#2869). A pager step is a control people tap
      // REPEATEDLY by design — "next, next, next" through 82 pages — which is
      // exactly the cadence #1956 measured turning a slow navigation into a
      // stuck one, and until now it had neither half of the guarantee. There is
      // no icon here to swap, so the step's own label is its slot: it stays
      // where it is, legible, with the spinner over it.
      <PendingTextLink
        href={href}
        label={`page ${page + delta}`}
        className={STEP_CLASS}
      >
        {label}
      </PendingTextLink>
    );
  };

  const paged = pageCount > 1;

  return (
    // Below `md`: `justify-between` with the two steps as the outer children puts
    // them on the row's edges. From `md` up the extent takes the free space
    // (`mr-auto`) and the three trailing children close back up into the footer
    // group — same nodes, same order in the DOM, different order on screen.
    <div
      className="flex flex-wrap items-center justify-between gap-3 border-t border-black/10 px-3 py-2 text-xs text-slate-500 md:justify-start md:gap-2 dark:border-white/10 dark:text-slate-400"
      data-testid={testId}
    >
      {paged && (
        // The slot, not the control: a step is a button in state mode, a link in
        // URL mode and a plain span at either end of the range, so no role- or
        // text-based locator reaches all three — and the disabled one is exactly
        // the one a tap-floor measurement must still see. Its single element child
        // is the control (`[data-pager-step] > *`).
        <span data-pager-step="prev" className="order-1 md:order-2">
          {step("Prev", -1, prevHref ?? null)}
        </span>
      )}
      <span className="order-2 md:order-1 md:mr-auto">
        Showing {start + 1}–{start + visibleCount} of{" "}
        <span data-testid={totalTestId}>{total}</span>
        {unit ? ` ${unit}` : ""}
      </span>
      {paged && (
        <span className="order-3 max-md:hidden">
          Page {page} of {pageCount}
        </span>
      )}
      {paged && (
        <span data-pager-step="next" className="order-4">
          {step("Next", 1, nextHref ?? null)}
        </span>
      )}
    </div>
  );
}
