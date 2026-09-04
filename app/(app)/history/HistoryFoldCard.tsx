"use client";

import { IconChevronDown } from "@tabler/icons-react";
import TimelineFilterLink, {
  useHistoryFoldNavigate,
} from "@/components/TimelineFilterLink";
import type { AppRoute } from "@/lib/hrefs";
import { timelineFoldCounts } from "@/lib/timeline-window";
import type { TimelineFold } from "@/lib/timeline-window";

// One collapsed period — a month of the current year, or an earlier year (#2657).
// The `timeline-fold-` anchor id is INHERITED, not restated: the rail's stops are
// computed from those ids in lib/timeline-scrubber.ts, which survived the route.
// Phase 2 moved the feed onto this page rather than reconciling two vocabularies.
//
// A CLIENT COMPONENT since #4365, and ONLY because of that: `useHistoryFoldNavigate`
// is a hook, and a hook cannot be handed down from the async server page that used to
// render this inline. Nothing else about the fold card changed shape — same props,
// same markup, same server-rendered HTML on first paint.
export default function HistoryFoldCard({
  fold,
  href,
  gutter,
  nested = false,
}: {
  fold: TimelineFold<{ date: string; events: unknown[] }> & {
    monthCount?: number;
  };
  href: AppRoute;
  /** The rail's lane, when the rail renders — see the feed container's note. */
  gutter: string;
  nested?: boolean;
}) {
  const onClick = useHistoryFoldNavigate(href);
  return (
    <section
      id={`timeline-fold-${fold.key}`}
      data-testid={`history-fold-${fold.key}`}
      data-fold-key={fold.key}
      data-fold-open={fold.open ? "true" : "false"}
      // NESTING IS MACHINE-READABLE, not only a left inset. A month card inside an
      // opened year is a level DOWN, and the whole point of the year roll-up is that
      // the two levels stay distinguishable — a nested card that rendered flush with
      // its parent would read as a second name for the same level, which is exactly
      // the compression #2657 bought being given back. The `pl-4` says it visually;
      // this is what a test can name.
      data-fold-nested={nested ? "true" : undefined}
      className={`scroll-mt-24 py-1.5 ${nested ? "pl-4" : ""} ${gutter}`}
    >
      {/* THE POSITION-PRESERVING LINK, NOT A PLAIN ONE (#4045 §4). This shipped as a
          `next/link` with default scroll, so every fold tap navigated to `?open=…` and
          jumped to the top of the page: the reader tapped a card, landed above their
          own recent history, saw nothing new, and read the card as dead. The retired
          `/timeline`'s fold cards never did that: they went through this component, which
          carries `scroll={false}` and the #2657 scroll-target capture — the re-housing
          simply dropped it. Reused rather than re-spelled: a second copy of a
          scroll-preserving link is the duplication #2816 was filed about.

          `scroll={false}` ALONE IS NOT THE FIX; the other half is where the revealed
          days render (app/(app)/history/page.tsx).

          `onClick` IS #4365's OTHER HALF: `undefined` falls straight through to
          `<Link>`'s own navigation exactly as before (reduced motion, an unsupported
          browser, a modified click); the handler `useHistoryFoldNavigate` returns
          otherwise wraps that SAME navigation in a view transition rather than
          replacing it. */}
      <TimelineFilterLink
        href={href}
        testId={`history-fold-${fold.key}-toggle`}
        label={fold.label}
        ariaExpanded={fold.open}
        onClick={onClick}
        className="flex items-center gap-3 rounded-lg border border-(--border) bg-surface px-3 py-2 transition hover:bg-(--ghost-hover)"
      >
        <span
          aria-hidden
          className={`inline-flex h-5 w-5 shrink-0 items-center justify-center text-slate-500 transition dark:text-slate-400 ${
            fold.open ? "rotate-180" : ""
          }`}
        >
          <IconChevronDown className="h-3.5 w-3.5" stroke={2} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium text-slate-900 dark:text-slate-100">
            {fold.label}
          </span>
          {/* THE COUNT IS ADDRESSABLE (#1504's grammar): the amount never hides,
              only the vertical cost of it does — so it is a claim the fold makes
              about content it is not showing, and a test has to be able to name it
              rather than matching its text against a page full of other numbers. */}
          <span
            data-testid={`history-fold-${fold.key}-counts`}
            className="block text-xs text-slate-500 dark:text-slate-400"
          >
            {timelineFoldCounts(fold)}
          </span>
        </span>
      </TimelineFilterLink>
    </section>
  );
}
