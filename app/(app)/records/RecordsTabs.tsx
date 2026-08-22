"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import ScrollFade from "@/components/ScrollFade";
import type { RecordsGroup } from "./nav";

// The second level of the Health-record tab hierarchy (#1079). The four group tabs
// now use the shared tab-first page shell; this strip sits directly below those
// tabs in normal document flow, then scrolls away with its pane instead of becoming
// a detached second sticky layer. Active by `usePathname()`: a group is selected
// when the path is under its basePath; a pane lights on exact href match. The group
// set (including the data-gated Specialty panes) is computed server-side and passed
// in, so the strip and the routes agree on what's reachable.
//
// ── THESE ARE DESTINATIONS, AND THEY SAY SO (#3408, item E) ─────────────────
//
// The outline pill is the RECORDS FAMILY'S NAVIGATION shape. It used to be the
// filter shape too — components/FilterPills.tsx drew the identical rounded-full
// outline — so a phone stacked hub tabs, these, and a filter strip three deep in
// one costume. The filter moved to an inset control; this keeps the outline, and
// declares `data-chip-role="nav"` beside FilterPills' `"filter"` so "these two
// are visually distinct" is one attribute comparison rather than a spec
// hard-coding two lists of Tailwind classes.
//
// `shrink-0 whitespace-nowrap` IS THE SPECIALTY STRIP'S FIX. `flex-nowrap` stops
// the CONTAINER wrapping; it does nothing about a flex item being squeezed, and
// with neither of these two classes — the `origin/main` shape — six panes on a
// 430px screen squeezed every pill until its label broke over two lines: the
// 50px pills in the owner's screenshot, against 30px here.
//
// THE TWO ARE INDEPENDENTLY SUFFICIENT, which is worth writing down because it
// means neither is load-bearing ALONE and a guard can only see the pair.
// Measured by mutation: delete `shrink-0` and the chips stay 30px; delete
// `whitespace-nowrap` and they stay 30px; delete BOTH and they go to 50. Two
// different mechanisms happen to forbid the same squeeze — `shrink-0` sets
// `flex-shrink: 0` outright, and `whitespace-nowrap` makes the item's
// min-content size the full width of its label, which a flex item's automatic
// minimum size already refuses to go below. Keep the pair (it is the same pair
// FilterPills carries, and the two strips should read alike), but do not expect
// removing one of them to fail anything.
//
// A pill that refuses to shrink scrolls out of the row instead, which is what
// the row's overflow is for.
//
// And the row now SAYS it scrolls: `ScrollFade` publishes the masked edge and its
// `data-fade-*` markers, so the affordance is assertable rather than absent.
export default function RecordsTabs({ groups }: { groups: RecordsGroup[] }) {
  const pathname = usePathname();
  const activeGroup =
    groups.find((g) => pathname.startsWith(g.basePath)) ?? groups[0];

  if (activeGroup.panes.length <= 1) return null;

  return (
    <div className="-mx-4 section-seam mb-6 px-4 pb-3 md:mx-0 md:px-0">
      <ScrollFade
        data-testid="records-sub-tabs"
        data-chip-role="nav"
        className="flex flex-nowrap gap-2 pb-1"
      >
        {activeGroup.panes.map((p) => {
          const active = pathname === p.href;
          return (
            <Link
              key={p.id}
              href={p.href}
              aria-current={active ? "page" : undefined}
              className={`shrink-0 whitespace-nowrap rounded-full border px-3 py-1 text-sm font-medium ${
                active
                  ? "border-brand-600 bg-brand-50 text-brand-700 dark:border-brand-400 dark:bg-brand-950/40 dark:text-brand-300"
                  : "border-(--border) bg-surface text-slate-600 hover:bg-(--ghost-hover) dark:text-slate-300"
              }`}
            >
              {p.label}
            </Link>
          );
        })}
      </ScrollFade>
    </div>
  );
}
