"use client";

import Link from "next/link";
import type { AppRoute } from "@/lib/hrefs";

// The app's ONE pager footer: "Showing 1–10 of 812 · Prev · Page 1 of 82 · Next".
//
// Two navigation modes, and they are exclusive because the two kinds of bound are
// different (#2530/#2445):
//
//   • `onPageChange` — a client table that already holds every row and pages it in
//     memory (the sleep↔mood history). The page is component state.
//   • `prevHref` / `nextHref` — a SERVER-paged read whose page rides the URL (the
//     Trends body history, the cross-item dose ledger, /whats-new). The links are
//     plain anchors, so the pager works without JS, is bookmarkable, and the page
//     boundary reaches the QUERY instead of only the DOM.
//
// The arithmetic behind both is lib/pagination.ts — the pager never derives a page
// count of its own.
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
}) {
  if (total === 0) return null;
  const start = (page - 1) * pageSize;

  const step = (label: string, delta: -1 | 1, href: AppRoute | null) => {
    const disabled = delta < 0 ? page <= 1 : page >= pageCount;
    if (onPageChange) {
      return (
        <button
          type="button"
          className="btn-ghost text-sm"
          disabled={disabled}
          onClick={() => onPageChange(page + delta)}
        >
          {label}
        </button>
      );
    }
    return disabled || !href ? (
      <span className="btn-ghost text-sm opacity-40">{label}</span>
    ) : (
      <Link href={href} className="btn-ghost text-sm">
        {label}
      </Link>
    );
  };

  return (
    <div
      className="flex flex-wrap items-center justify-between gap-3 border-t border-black/10 px-3 py-2 text-xs text-slate-500 dark:border-white/10 dark:text-slate-400"
      data-testid={testId}
    >
      <span>
        Showing {start + 1}–{start + visibleCount} of {total}
      </span>
      {pageCount > 1 && (
        <div className="flex items-center gap-2">
          {step("Prev", -1, prevHref ?? null)}
          <span>
            Page {page} of {pageCount}
          </span>
          {step("Next", 1, nextHref ?? null)}
        </div>
      )}
    </div>
  );
}
