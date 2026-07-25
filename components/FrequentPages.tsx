"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { IconHistory } from "@tabler/icons-react";
import {
  PAGE_VISITS_KEY,
  frequentPages,
  parsePageVisits,
  recordPageVisit,
  type TrackedPage,
} from "@/lib/recent-pages";

// "Frequent" shortcuts at the top of the shared sidebar content (issue #1416,
// section E3) — the browser half over the pure tally in lib/recent-pages.ts.
//
// Rendered inside the ONE shared <SidebarContent>, so the desktop sidebar and
// the mobile drawer show the same shortcuts (the responsive-surfaces rule); the
// phone is where it pays off most, since the drawer is otherwise a full tree to
// scroll.
//
// Storage is `localStorage`, per device, never the DB: visit counts are a
// display preference, not health data, and the allowlist in lib/recent-pages.ts
// keeps the stored keys to a bounded set of top-level routes. Nothing renders
// until after mount (SSR emits nothing), so there is no hydration mismatch and
// no server round-trip.
export default function FrequentPages({
  onNavigate,
}: {
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  const [pages, setPages] = useState<TrackedPage[]>([]);

  useEffect(() => {
    let stored;
    try {
      stored = parsePageVisits(window.localStorage.getItem(PAGE_VISITS_KEY));
    } catch {
      // Private-mode / disabled storage: the feature simply doesn't exist here.
      return;
    }
    const next = recordPageVisit(stored, pathname, Date.now());
    if (next !== stored) {
      try {
        window.localStorage.setItem(PAGE_VISITS_KEY, JSON.stringify(next));
      } catch {
        // Quota or a locked store — the shortcuts just stop learning.
      }
    }
    // Rank from the POST-visit tally so the current page's own visit counts, but
    // exclude the page you're standing on (a shortcut to here is a wasted row).
    setPages(frequentPages(next, { currentPath: pathname }));
  }, [pathname]);

  if (pages.length === 0) return null;

  return (
    <div data-testid="frequent-pages" className="flex flex-col gap-1">
      <div className="section-label flex items-center gap-1.5 px-2">
        <IconHistory className="h-3.5 w-3.5" stroke={1.75} />
        Frequent
      </div>
      <div className="flex flex-wrap gap-1.5">
        {pages.map((page) => (
          <Link
            key={page.href}
            href={page.href}
            onClick={onNavigate}
            data-testid={`frequent-page-${page.href}`}
            className="press rounded-full border border-black/10 bg-white/70 px-2.5 py-1 text-xs font-medium text-slate-600 transition hover:bg-slate-100 dark:border-white/10 dark:bg-ink-850 dark:text-slate-300 dark:hover:bg-ink-750"
          >
            {page.label}
          </Link>
        ))}
      </div>
    </div>
  );
}
